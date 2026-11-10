import type { MistakeCategory } from '../model.ts';
import { suggestedCategory } from '../model.ts';
import type { MarkResult, MistakeService } from '../mistakes/mistakeService.ts';
import type { Finding, FindingKind } from './tracker.ts';

/** Kinds offered for saving by default (repetitions are recorded only if the user opts in). */
export const DEFAULT_SAVE_KINDS: readonly FindingKind[] = ['incorrect', 'skipped', 'hesitation'];

export function categoryFor(f: Finding): MistakeCategory {
  if ((f.kind === 'incorrect' || f.kind === 'skipped') && suggestedCategory(f.position) === 'ayah_transition') return 'ayah_transition';
  switch (f.kind) {
    case 'incorrect':
      return 'incorrect_word';
    case 'skipped':
      return 'forgotten';
    case 'hesitation':
    case 'repeated':
      return 'hesitation';
  }
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Saves selected tracker findings through the existing MistakeService, so recurrence, statistics,
 * scheduling and review all behave exactly like manual marks. One record per word per session:
 * findings already saved in this session (same key) are skipped, and marking an existing place
 * again becomes a recurrence, not a duplicate.
 */
export class RecitationMistakeBridge {
  private readonly saved = new Set<string>();
  private readonly mistakes: MistakeService;
  private readonly edition: string;
  private readonly sessionId: string;
  constructor(mistakes: MistakeService, edition: string, sessionId: string) {
    this.mistakes = mistakes;
    this.edition = edition;
    this.sessionId = sessionId;
  }

  isSaved(f: Finding): boolean {
    return this.saved.has(this.key(f));
  }

  async save(findings: readonly Finding[]): Promise<MarkResult[]> {
    const out: MarkResult[] = [];
    for (const f of findings) {
      const key = this.key(f);
      if (this.saved.has(key)) continue;
      this.saved.add(key);
      const heard = f.heard ? ` · heard: ${f.heard}` : '';
      out.push(
        await this.mistakes.markWord(
          f.ref,
          { position: f.position, tokenText: f.tokenText, edition: this.edition },
          { category: categoryFor(f), severity: f.kind === 'hesitation' ? 1 : 2, confidence: null, note: `Recitation tracker (${f.kind}) at ${fmtTime(f.atMs)}${heard}` },
        ),
      );
    }
    return out;
  }

  /** Word-level dedupe across kinds: a word is stored once per session. */
  private key(f: Finding): string {
    return `${this.sessionId}:${f.ref.surah}:${f.ref.ayah}:${f.position}`;
  }
}
