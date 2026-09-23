import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdleTimer } from './idle';
import { WedgeScanner } from './wedge';

describe('IdleTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after the timeout without activity', () => {
    const onIdle = vi.fn();
    const t = new IdleTimer(60_000, onIdle);
    t.touch();
    vi.advanceTimersByTime(59_999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(120_000);
    expect(onIdle).toHaveBeenCalledOnce();
    expect(t.running).toBe(false);
  });

  it('activity restarts the countdown', () => {
    const onIdle = vi.fn();
    const t = new IdleTimer(60_000, onIdle);
    t.touch();
    vi.advanceTimersByTime(50_000);
    t.touch();
    vi.advanceTimersByTime(50_000);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it('stop() cancels and a zero timeout disables locking', () => {
    const onIdle = vi.fn();
    const t = new IdleTimer(1_000, onIdle);
    t.touch();
    t.stop();
    vi.advanceTimersByTime(5_000);
    const off = new IdleTimer(0, onIdle);
    off.touch();
    vi.advanceTimersByTime(5_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe('WedgeScanner', () => {
  function type(w: WedgeScanner, text: string, startMs: number, gapMs: number) {
    let t = startMs;
    for (const ch of text) {
      w.feed(ch, t);
      t += gapMs;
    }
    return w.feed('Enter', t);
  }

  it('treats a fast burst ending in Enter as an NFC card', () => {
    expect(type(new WedgeScanner(), '04A1B2C3', 1000, 8)).toEqual({
      credentialType: 'NFC_CARD',
      value: '04A1B2C3',
    });
  });

  it('treats slow digits as a PIN', () => {
    expect(type(new WedgeScanner(), '4821', 1000, 400)).toEqual({
      credentialType: 'PIN',
      value: '4821',
    });
  });

  it('treats a fast but short digit burst as a PIN, not a card', () => {
    expect(type(new WedgeScanner(), '123', 1000, 5)).toEqual({
      credentialType: 'PIN',
      value: '123',
    });
  });

  it('ignores non-digit slow input and modifier keys', () => {
    const w = new WedgeScanner();
    w.feed('Shift', 0);
    expect(type(w, 'abcdefg', 1000, 400)).toBeNull();
  });

  it('discards a stale partial buffer after a long pause', () => {
    const w = new WedgeScanner();
    w.feed('9', 0);
    w.feed('9', 100);
    expect(type(w, '04A1B2C3', 10_000, 8)).toEqual({
      credentialType: 'NFC_CARD',
      value: '04A1B2C3',
    });
  });

  it('Enter with nothing typed yields nothing', () => {
    expect(new WedgeScanner().feed('Enter', 5)).toBeNull();
  });
});
