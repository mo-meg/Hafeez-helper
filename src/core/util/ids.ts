/** Injectable clock and id generator so services stay deterministic under test. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type IdGenerator = (prefix: string) => string;

export const randomIds: IdGenerator = (prefix) => {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${rnd}`;
};

export function sequentialIds(): IdGenerator {
  let n = 0;
  return (prefix) => `${prefix}_${++n}`;
}

export class FixedClock implements Clock {
  private t: number;
  constructor(iso: string) {
    this.t = Date.parse(iso);
  }
  now() {
    return new Date(this.t);
  }
  set(iso: string) {
    this.t = Date.parse(iso);
  }
  advanceDays(days: number) {
    this.t += days * 86_400_000;
  }
  advanceMs(ms: number) {
    this.t += ms;
  }
}

/** Local calendar date (YYYY-MM-DD) for a Date, in the runtime's time zone. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 86_400_000;
}
