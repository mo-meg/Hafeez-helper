#!/usr/bin/env python3
"""Local speech-recognition server for the Hafeez Helfer Recitation Tracker.

Runs the NVIDIA NeMo FastConformer Quran model (Hugging Face: mohammed/fastconformer-quran-ar)
on THIS computer and listens on 127.0.0.1 only. The browser posts short 16 kHz mono WAV chunks;
the server answers {"text": ..., "words": [{"word", "start", "end"}]}. Word timings are returned
only when NeMo produces real word timestamps for the model; otherwise "words" is omitted and the
app aligns from the transcript alone. Nothing is written to disk and nothing is sent elsewhere.

    pip install "nemo_toolkit[asr]"           # once (CPU works; a GPU is used if available)
    python scripts/asr_server.py              # downloads the model once from Hugging Face
    python scripts/asr_server.py --nemo path/to/model.nemo   # fully offline

Model licence: CC BY 4.0 (attribution required; see the model card).
"""
import argparse
import io
import json
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

MODEL_ID = "mohammed/fastconformer-quran-ar"
# The repository holds several training checkpoints; this is the best one (val WER 0.14%).
MODEL_FILE = "phase3_full/phase3_full_wer0.0014.nemo"
RATE = 16000
# Measured: the model returns empty or wrong text for chunks that start/end abruptly inside
# speech; 0.4 s of silence on both sides (like the training recordings) fixes this.
PAD_S = 0.4
state = {"model": None, "error": None, "stride": 0.04}
lock = threading.Lock()


def load(args):
    try:
        import nemo.collections.asr as nemo_asr  # noqa: PLC0415

        path = args.nemo
        if not path:
            from huggingface_hub import hf_hub_download  # noqa: PLC0415

            path = hf_hub_download(args.model, args.file)
        # EncDecHybridRNNTCTCBPEModel (FastConformer hybrid RNNT/CTC, SentencePiece BPE 1024)
        model = nemo_asr.models.ASRModel.restore_from(path, map_location=args.device)
        if args.decoder == "ctc" and hasattr(model, "change_decoding_strategy"):
            model.change_decoding_strategy(decoder_type="ctc")
        model.eval()
        try:  # seconds per output frame = window stride x encoder subsampling (8 for FastConformer)
            pre = model.cfg.preprocessor
            state["stride"] = float(pre.window_stride) * int(model.cfg.encoder.get("subsampling_factor", 8))
        except Exception:  # noqa: BLE001
            pass
        state["model"] = model
        print(f"Model ready: {args.nemo or args.model}", file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        state["error"] = f"Model failed to load: {e}"
        print(state["error"], file=sys.stderr)


def read_wav(data: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(data)) as w:
        if w.getframerate() != RATE or w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("expected 16 kHz mono 16-bit WAV")
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0


def word_list(hyp):
    ts = getattr(hyp, "timestamp", None) or getattr(hyp, "timestep", None)
    words = ts.get("word") if isinstance(ts, dict) else None
    out = []
    for w in words or []:
        text = w.get("word") or w.get("char")
        if "start" in w and "end" in w:
            start, end = float(w["start"]), float(w["end"])
        elif "start_offset" in w:
            start, end = w["start_offset"] * state["stride"], w["end_offset"] * state["stride"]
        else:
            continue
        if text:
            out.append({"word": text, "start": round(max(0.0, start - PAD_S), 3), "end": round(max(0.0, end - PAD_S), 3)})
    return out


def transcribe(audio: np.ndarray):
    model = state["model"]
    pad = np.zeros(int(PAD_S * RATE), dtype=np.float32)
    audio = np.concatenate([pad, audio, pad])
    with lock:
        try:
            res = model.transcribe([audio], batch_size=1, timestamps=True, verbose=False)
        except TypeError:  # older NeMo: no timestamps argument
            res = model.transcribe([audio], batch_size=1, return_hypotheses=True)
    if isinstance(res, tuple):  # some RNNT versions return (best, all)
        res = res[0]
    hyp = res[0]
    text = hyp if isinstance(hyp, str) else getattr(hyp, "text", "")
    body = {"text": text}
    words = [] if isinstance(hyp, str) else word_list(hyp)
    if words:
        body["words"] = words
    return body


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", self.server.allow_origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        if self.path != "/health":
            return self._send(404, {"error": "not found"})
        ready = state["model"] is not None
        self._send(200 if ready or not state["error"] else 503, {"ready": ready, "model": MODEL_ID, "error": state["error"] or (None if ready else "Model is still loading")})

    def do_POST(self):  # noqa: N802
        if self.path != "/transcribe":
            return self._send(404, {"error": "not found"})
        if state["model"] is None:
            return self._send(503, {"error": state["error"] or "Model is still loading"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if n <= 44 or n > RATE * 2 * 60:
                raise ValueError("audio chunk must be between 0 and 60 seconds")
            self._send(200, transcribe(read_wav(self.rfile.read(n))))
        except ValueError as e:
            self._send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": f"recognition failed: {e}"})

    def log_message(self, *a):  # keep the console quiet; audio is never logged
        pass


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--model", default=MODEL_ID)
    p.add_argument("--file", default=MODEL_FILE, help="checkpoint inside the Hugging Face repository")
    p.add_argument("--nemo", help="local .nemo file (offline)")
    p.add_argument("--decoder", choices=["rnnt", "ctc"], default="rnnt", help="hybrid model head (ctc is faster on CPU)")
    p.add_argument("--device", default=None, help="cpu or cuda (default: automatic)")
    p.add_argument("--allow-origin", default="*", help="CORS origin of the app, e.g. https://you.github.io")
    args = p.parse_args()
    threading.Thread(target=load, args=(args,), daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.allow_origin = args.allow_origin
    print(f"Recitation recognition server on http://127.0.0.1:{args.port} (local only)", file=sys.stderr)
    srv.serve_forever()


if __name__ == "__main__":
    main()
