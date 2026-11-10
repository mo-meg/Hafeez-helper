# Recitation tracker

Status: implemented 2026-11-10. Route `#/recite` ("Recitation tracker" / «متابعة التلاوة»).

## How it works

```
microphone ─► src/browser/micCapture.ts   (16 kHz mono float, in memory only)
           ─► core/recitation/audio.ts     Chunker: energy VAD, cuts at pauses, ≤4 s, no overlap
           ─► core/recitation/engine.ts    AsrEngine interface  ◄─ browser/localAsrEngine.ts
                                           (WAV → http://127.0.0.1:8765, scripts/asr_server.py, NeMo)
           ─► core/recitation/tracker.ts   two-stage matching against core/recitation/corpus.ts
           ─► core/recitation/mistakeBridge.ts ─► existing MistakeService (markWord)
UI: src/ui/views/recite.ts (no recognition logic in the UI)
```

The canonical KFGQPC text is the only source of displayed words and mistake snapshots. The
transcript is used only for comparison (`normalize.ts` folds harakat, hamza seats, alef forms,
ta marbuta, alef maqsura) and is never shown as Quran text or written into it.

**Stage A — global search.** Normalised word bigrams of the whole text (~77k words, built in
~0.2 s) seed candidate places; each is scored by semi-global word alignment. The tracker locks
only when at least 4 words match (3 consecutive) and the best place beats the best *other* place
by a margin, so refrains such as «فبأي آلاء ربكما تكذبان» stay ambiguous until the following
words decide. No surah or page needs to be selected.

**Recognition loop.** Speech is cut by an energy VAD into ≤ 2 s steps; each step re-recognises a
window (committed context + uncommitted audio) and only words two passes agree on reach the
tracker. Pause/resume and a "hide text" memorisation mode are in the UI; the latest model
transcript and its latency are shown for transparency (never as Quran text).

**Stage B — focused.** Each new chunk is aligned against a small window after the cursor on the
current and next mushaf page (page from the verified division metadata), also trying up to 8
words back to recognise repetition and self-correction. Chunks with too few matches are not
highlighted; two in a row return to Stage A, which first searches the pages around the last
known place, then the whole Quran. Both stages use the same model; only the text constraint differs.

**Word states.** correct · pending (suspected, inside the confirmation window) · incorrect
(substitution) · skipped · repeated · hesitation (pause ≥ 3.5 s inside an ayah; pauses between
ayat are normal) · uncertain (near spelling or model confidence < 0.5 — never a mistake).
A suspected mistake is confirmed only after 2.5 s of audio **and** two further words; if the
reciter goes back and says the word correctly within that window it becomes correct
(self-correction). Word timestamps are used only when the model returns them.

**Saving.** After stopping, the summary lists findings. Incorrect, skipped and hesitation are
pre-selected; repetitions are opt-in. Saving goes through `MistakeService.markWord`, so
categories, recurrence, scheduling, statistics and the review/test features behave exactly like
manual marks (manual marking is unchanged). Duplicates are prevented three times: one finding
per word+kind per session in the tracker, one record per word per session in the bridge, and
an existing record for the same place becomes a recurrence. Mapping: incorrect → incorrect word,
skipped → forgotten, hesitation/repeated → hesitation, first word of an ayah → linking ayat.

## The model (verified 2026-11-10)

`mohammed/fastconformer-quran-ar`: NVIDIA NeMo `EncDecHybridRNNTCTCBPEModel` (FastConformer-Large,
114.6 M parameters, SentencePiece BPE 1024), fine-tuned from
`nvidia/stt_ar_fastconformer_hybrid_large_pcd_v1.0` on `tarteel-ai/everyayah`; 16 kHz mono;
**licence CC BY 4.0** (attribution). The repository holds nine training checkpoints and no
root `.nemo`, so the server downloads `phase3_full/phase3_full_wer0.0014.nemo` explicitly.
Output is fully diacritised imla'i Arabic; RNNT word timestamps are real but approximate
(±80 ms frames, sometimes worse). The card describes cache-aware streaming; the tracker does not
need it (see below). On a 2-core CPU a 20 s ayah takes ~1.5 s.

## Local server

```bash
pip install "nemo_toolkit[asr]"
python scripts/asr_server.py                       # downloads the checkpoint once (~460 MB)
python scripts/asr_server.py --nemo model.nemo     # fully offline
python scripts/asr_server.py --decoder ctc         # faster, less accurate (measured)
```

Binds to 127.0.0.1 only, accepts 16 kHz mono 16-bit WAV, returns `{text, words?}`, and pads every
chunk with 0.4 s of silence (measured: without it the model returns empty or wrong text for
chunks that start or end inside speech). The app accepts only loopback endpoints; the nginx CSP
allows `http://127.0.0.1:*`/`http://localhost:*`; the server sends
`Access-Control-Allow-Private-Network` for Chrome.

## Decisions taken from measurements with real audio

| Observation (real model, real recitation) | Change |
|---|---|
| Isolated 2–4 s chunks: many wrong/empty words | Sliding window: recent audio re-recognised with up to 4 s of committed context |
| A window starting inside a word garbles it | Context is cut only in gaps between words (from timestamps) |
| Single passes flicker near the live edge | Local agreement: a word is committed when two passes agree (same word, ±320 ms) |
| Same audio reported twice with shifted timestamps | Committed-word tail; same word within 1.2 s is dropped |
| A pass sometimes returns nothing | Empty pass keeps the window; the previous pass is used at the end of an utterance |
| VAD noise floor climbed above soft, reverberant speech (Alafasy) | Floor falls fast, rises slowly, capped |
| KFGQPC open tanween U+08F0–08F2 (رَحۡمَةࣰ) not stripped | Folded in `normWord` |
| «شفاحفرة» for شَفَا حُفۡرَةࣲ, «أينما» for KFGQPC أَيۡنَ مَا | Alignment merges 1↔2 words |
| ص/س, ض/د … written plainly for correct recitation | Close letters cost half (→ "not clearly heard") |
| «من» swallowed by idgham in مِن لَّدُنكَ | Missing word inside a ≥ 650 ms recognised gap → not clearly heard |
| Isti'adha locked onto An-Nahl 16:98 | Leading isti'adha/basmala removed before search |
| Ayat with identical openings (67:2/67:3) | On losing track the last words are re-placed by the search |
| Long-context re-recognition "hears" the canonical word | Second look (8 s window) only for suspected *omissions*, not substitutions |

## Real-audio tests

`npm run test:audio -- --reciter Husary_64kbps` downloads EveryAyah recordings at run time and
checks 7 scenarios (correct passage found without selection, page boundary 2→3, repeated ayah,
skipped word, skipped ayah, substituted word — spliced from another recording — and a 5 s pause).
Results on 2026-11-10: Husary 7/7, Minshawy (murattal) 7/7, Alafasy 6/7 (the spliced-word case
fails: his reverberant recording, which itself repeats part of 18:10, is mis-recognised around
the splice). Note: EveryAyah is the model's training set, so these are optimistic.

`npm run test:recording -- file.ogg --cache /tmp/asr-cache` runs any recording (resumable).
On a real user's 6 min 51 s phone recording (WhatsApp, Āl ʿImrān 3:93–132): located at 0:07 with
no selection, followed 628 words across pages 62–67, repetitions the user made were reported as
repetitions, and **1 false omission** remained (3:117 «أنفسهم», heard as «ولكنهم»).

## Data note

KFGQPC's own `hafsData_v18.json` (github.com/thetruetruth/quran-data-kfgqpc) gives page starts
that differ from the app's `divisions.json` (Tanzil/AlQuran.cloud) on **25 of 604 pages**
(e.g. page 121 starts at 5:78 vs 5:77). The tracker uses the app's divisions; aligning page data
with the KFGQPC edition the text comes from is a separate, app-wide decision.

## Performance

One recognition at a time; queued audio is folded into the window (nothing dropped). Average
recognition ~0.4–0.7 s per step on a 2-core VM for real-time input.

## Tests

`tests/recitation.test.ts` (synthetic fixture, mocked model): identification, ambiguity,
global → focused, page boundary, substitution, omission, repetition, self-correction,
uncertainty, hesitation, loss and recovery, preamble, chunking (incl. closing after a length cut
and soft speech), pause/resume, microphone/model/engine failures, silence, duplicate-free saving.
`tests/data/recitation.datatest.ts` checks identification on the real KFGQPC text.

## Sharing the tracker with approved users (public site)

The site (GitHub Pages) only serves the app; the model runs on your computer and is exposed through a tunnel. Only the admin (`mmm_megahed@hotmail.com`) and users the admin approves in the app can use it. Local testing is unchanged.

1. **Supabase, once:** run `supabase/recitation_access.sql` in the SQL editor. (The admin email is set there, in `src/core/recitation/access.ts` and in `scripts/asr_server.py`. Keep "Confirm email" enabled in Supabase Auth, since the admin is identified by a confirmed email.)
2. **Start the server in shared mode** (it still listens on 127.0.0.1 only):
   `python scripts/asr_server.py --allow-origin https://mo-meg.github.io --supabase-url https://<project>.supabase.co --supabase-anon-key <anon key>`
   Without `--supabase-url` there is no sign-in check, so never tunnel it in that mode.
3. **Open the tunnel:** `cloudflared tunnel --url http://127.0.0.1:8765` and copy the `https://….trycloudflare.com` address (a named tunnel keeps the address stable).
4. **Tell the site the address:** set the repository variable `HAFEEZ_ASR_URL` (Settings → Secrets and variables → Actions → Variables) and re-run the deploy workflow. For a local build put `HAFEEZ_ASR_URL=…` in `.env`.
5. **Approve users:** they open Recitation tracker → "Request access". You see the requests on the same page (admin only) and press Approve / Deny / Revoke. Approval takes effect within about a minute.

How it is protected: the browser sends the user's Supabase token; the server asks Supabase who the user is and whether `recitation_access.status = 'approved'` (row-level security stops users approving themselves), fails closed if Supabase is unreachable, and limits each user to 90 requests a minute (`--rate`). The tracker works only while your computer is on and the tunnel is running. For local testing, run the server without the flags and leave `HAFEEZ_ASR_URL` unset: the app then uses `http://127.0.0.1:8765` and needs no sign-in. Users can also pick their own local server under "Recognition engine".

Privacy: with the shared server, recitation audio travels to your computer for recognition and is not stored. The app says so on the page.
