import { describe, expect, it } from 'vitest';
import { elapsedSeconds, formatElapsed, normaliseThresholds, urgencyOf } from './elapsed';

const T = { warnAfterSeconds: 300, lateAfterSeconds: 600 };
const created = '2026-09-22T10:00:00Z';
const at = (s: number) => Date.parse(created) + s * 1000;

describe('elapsed time', () => {
  it('computes elapsed seconds and never goes negative', () => {
    expect(elapsedSeconds(created, at(75))).toBe(75);
    expect(elapsedSeconds(created, at(-30))).toBe(0);
    expect(elapsedSeconds('garbage', at(10))).toBe(0);
  });

  it('applies the server clock offset', () => {
    // local clock is 20 s behind the server
    expect(elapsedSeconds(created, at(100), 20_000)).toBe(120);
  });

  it.each([
    [0, 'ok'],
    [299, 'ok'],
    [300, 'warn'],
    [599, 'warn'],
    [600, 'late'],
    [5000, 'late'],
  ] as const)('urgency at %is is %s with default thresholds', (secs, expected) => {
    expect(urgencyOf(secs, T)).toBe(expected);
  });

  it('honours custom thresholds', () => {
    const t = { warnAfterSeconds: 60, lateAfterSeconds: 90 };
    expect(urgencyOf(59, t)).toBe('ok');
    expect(urgencyOf(60, t)).toBe('warn');
    expect(urgencyOf(90, t)).toBe('late');
  });

  it('formats mm:ss and h:mm:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(187)).toBe('3:07');
    expect(formatElapsed(3729)).toBe('1:02:09');
  });

  it('normalises thresholds', () => {
    expect(normaliseThresholds({ warnAfterSeconds: 600, lateAfterSeconds: 60 })).toEqual({
      warnAfterSeconds: 600,
      lateAfterSeconds: 600,
    });
    expect(normaliseThresholds({ warnAfterSeconds: -5, lateAfterSeconds: NaN })).toEqual({
      warnAfterSeconds: 0,
      lateAfterSeconds: 0,
    });
  });
});
