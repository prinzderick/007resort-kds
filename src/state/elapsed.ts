/** Elapsed-time helpers for ticket ageing (pure, clock injected). */

export type Urgency = 'ok' | 'warn' | 'late';

export interface Thresholds {
  /** Seconds after creation at which a ticket turns amber. */
  readonly warnAfterSeconds: number;
  /** Seconds after creation at which a ticket turns red. */
  readonly lateAfterSeconds: number;
}

/**
 * Seconds since `createdAtUtc`. `clockOffsetMs` = serverNow - localNow, so a kiosk
 * with a skewed clock still shows correct ages (0 when the server time is unknown).
 * Never negative.
 */
export function elapsedSeconds(createdAtUtc: string, nowMs: number, clockOffsetMs = 0): number {
  const created = Date.parse(createdAtUtc);
  if (Number.isNaN(created)) return 0;
  return Math.max(0, Math.floor((nowMs + clockOffsetMs - created) / 1000));
}

export function urgencyOf(elapsed: number, t: Thresholds): Urgency {
  if (elapsed >= t.lateAfterSeconds) return 'late';
  if (elapsed >= t.warnAfterSeconds) return 'warn';
  return 'ok';
}

/** "3:07", or "1:02:09" past an hour. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${sec}` : `${String(m)}:${sec}`;
}

/** Sanitises user/station supplied thresholds: non-negative, late >= warn. */
export function normaliseThresholds(t: Thresholds): Thresholds {
  const warn = Number.isFinite(t.warnAfterSeconds) ? Math.max(0, t.warnAfterSeconds) : 0;
  const late = Number.isFinite(t.lateAfterSeconds) ? Math.max(warn, t.lateAfterSeconds) : warn;
  return { warnAfterSeconds: warn, lateAfterSeconds: late };
}
