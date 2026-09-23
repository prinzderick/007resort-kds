import type { CredentialType } from '../api/client';

/**
 * Keyboard-wedge classifier. An NFC reader "types" the card UID very quickly and ends with Enter;
 * a person on a keypad types slowly. Feed every key event; on Enter you get the credential.
 */

export interface WedgeResult {
  readonly credentialType: Extract<CredentialType, 'PIN' | 'NFC_CARD'>;
  readonly value: string;
}

export interface WedgeOptions {
  /** Max average gap between characters (ms) to be treated as a reader. */
  readonly maxAvgGapMs?: number;
  /** Minimum characters for a card read. */
  readonly minCardLength?: number;
  /** A gap larger than this discards the partial buffer (stray keystroke). */
  readonly resetGapMs?: number;
}

export class WedgeScanner {
  private buffer = '';
  private gaps: number[] = [];
  private last = 0;
  private readonly maxAvgGapMs: number;
  private readonly minCardLength: number;
  private readonly resetGapMs: number;

  constructor(opts: WedgeOptions = {}) {
    this.maxAvgGapMs = opts.maxAvgGapMs ?? 50;
    this.minCardLength = opts.minCardLength ?? 6;
    this.resetGapMs = opts.resetGapMs ?? 1500;
  }

  reset(): void {
    this.buffer = '';
    this.gaps = [];
    this.last = 0;
  }

  /** @returns a result when Enter completes a credential, otherwise null. */
  feed(key: string, timeMs: number): WedgeResult | null {
    if (this.buffer !== '' && timeMs - this.last > this.resetGapMs) this.reset();

    if (key === 'Enter') {
      const value = this.buffer;
      const gaps = this.gaps;
      this.reset();
      if (value === '') return null;
      const avg = gaps.length === 0 ? Infinity : gaps.reduce((a, b) => a + b, 0) / gaps.length;
      if (value.length >= this.minCardLength && avg <= this.maxAvgGapMs) {
        return { credentialType: 'NFC_CARD', value };
      }
      return /^\d+$/.test(value) ? { credentialType: 'PIN', value } : null;
    }
    if (key.length !== 1) return null; // ignore Shift, Tab, arrows...
    if (this.buffer !== '') this.gaps.push(timeMs - this.last);
    this.buffer += key;
    this.last = timeMs;
    return null;
  }
}
