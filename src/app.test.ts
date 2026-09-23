import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KdsApp, POLL_MS } from './app';
import {
  harness,
  networkDown,
  problem,
  session,
  STATION,
  ticket,
  type Harness,
} from './test/fakes';
import type { Ticket } from './state/tickets';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-22T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

/** Boots, signs in with a PIN, picks the station and brings the socket "online". */
async function signedIn(h: Harness, tickets: Ticket[] = [ticket({ id: 'a' })]): Promise<KdsApp> {
  h.api.listTickets.mockResolvedValue(tickets);
  const app = new KdsApp(h.deps);
  app.boot();
  await app.login({ credentialType: 'PIN', secret: '1234' });
  app.chooseStation({ ...STATION });
  h.rt.handlers.onState('online');
  h.rt.handlers.onSubscribed();
  await flush();
  return app;
}

describe('device enrolment', () => {
  it('stores the device token after registration', async () => {
    const h = harness();
    h.storage.setDevice(null);
    const app = new KdsApp(h.deps);
    expect(app.getState().device).toBeNull();
    expect(await app.registerDevice('Pass 1', 'CODE')).toBe(true);
    expect(h.api.registerDevice).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Pass 1', registrationCode: 'CODE' }),
    );
    expect(app.getState().device).toEqual({ id: 'dev-1' });
    expect(h.storage.device()).toEqual({ id: 'dev-1', token: 'dt-1' });
  });

  it('shows a readable error for a rejected code', async () => {
    const h = harness();
    h.storage.setDevice(null);
    h.api.registerDevice.mockRejectedValue(problem(422, 'validation_failed'));
    const app = new KdsApp(h.deps);
    expect(await app.registerDevice('Pass 1', 'BAD')).toBe(false);
    expect(app.getState().registrationError).toMatch(/not accepted/);
    expect(app.getState().device).toBeNull();
  });

  it('a revoked device falls back to enrolment and drops the session', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.hooks.current?.onDeviceRejected();
    expect(app.getState().device).toBeNull();
    expect(app.getState().auth).toBe('signed-out');
    expect(h.storage.device()).toBeNull();
    expect(h.rt.stop).toHaveBeenCalled();
  });
});

describe('login and idle lock', () => {
  it('loads stations when no station is remembered, and remembers the pick per device', async () => {
    const h = harness();
    const app = new KdsApp(h.deps);
    app.boot();
    expect(await app.login({ credentialType: 'PIN', secret: '1234' })).toBe(true);
    expect(app.getState().auth).toBe('active');
    expect(app.getState().staffName).toBe('Chef Ada');
    await flush();
    expect(app.getState().stations).toEqual([STATION]);
    app.chooseStation({ ...STATION });
    expect(h.storage.station()).toMatchObject({ id: 'st-1' });
    expect(h.rt.start).toHaveBeenCalledWith('st-1', 'dev-1');

    // a fresh boot on the same device goes straight to the remembered station
    const h2 = harness({}, (s) => {
      s.setStation({ ...STATION });
    });
    const app2 = new KdsApp(h2.deps);
    app2.boot();
    expect(app2.getState().station?.id).toBe('st-1');
    await app2.login({ credentialType: 'NFC_CARD', secret: '04A1B2C3' });
    expect(h2.rt.start).toHaveBeenCalledWith('st-1', 'dev-1');
    expect(h2.api.listStations).not.toHaveBeenCalled();
  });

  it('shows a friendly message and stays signed out on bad credentials', async () => {
    const h = harness();
    h.api.login.mockRejectedValue(problem(401, 'invalid_credentials'));
    const app = new KdsApp(h.deps);
    expect(await app.login({ credentialType: 'PIN', secret: '0000' })).toBe(false);
    expect(app.getState()).toMatchObject({
      auth: 'signed-out',
      loginError: 'Not recognised. Try again.',
      loginBusy: false,
    });
  });

  it('locks after the idle timeout, keeps the board, and needs a fresh sign-in to act', async () => {
    const h = harness();
    const app = await signedIn(h);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(app.getState().auth).toBe('active');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(app.getState()).toMatchObject({ auth: 'locked', staffName: null });
    expect(app.getState().board.tickets.size).toBe(1); // still visible read-only
    expect(app.getState().connection).toBe('online'); // and still live

    await app.bump('a'); // locked: prompts sign-in instead of calling the API
    expect(app.getState().loginOpen).toBe(true);
    expect(h.api.getTicket).not.toHaveBeenCalled();

    h.api.login.mockResolvedValue(session({ accessToken: 'tok-B', staffName: 'Bar Tunde' }));
    await app.login({ credentialType: 'PIN', secret: '5678' });
    expect(app.getState()).toMatchObject({
      auth: 'active',
      staffName: 'Bar Tunde',
      loginOpen: false,
    });
    expect(h.api.logout).toHaveBeenCalledWith('tok-1'); // previous staff session ended
    expect(h.rt.start).toHaveBeenCalledTimes(1); // live connection was not restarted
  });

  it('activity postpones the lock', async () => {
    const h = harness();
    const app = await signedIn(h);
    await vi.advanceTimersByTimeAsync(50_000);
    app.activity();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(app.getState().auth).toBe('active');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(app.getState().auth).toBe('locked');
  });

  it('sign-out logs out server-side, stops realtime and forgets the token', async () => {
    const h = harness();
    const app = await signedIn(h);
    app.signOut();
    expect(h.api.logout).toHaveBeenCalledWith('tok-1');
    expect(h.rt.stop).toHaveBeenCalled();
    expect(app.getState()).toMatchObject({ auth: 'signed-out', loginOpen: true });
    expect(h.hooks.current?.getToken()).toBeNull();
  });
});

describe('session refresh', () => {
  it('rotates the token pair once even for concurrent 401s (refresh tokens are single-use)', async () => {
    const h = harness();
    await signedIn(h);
    const hooks = h.hooks.current;
    const [a, b] = await Promise.all([hooks?.onUnauthorized(), hooks?.onUnauthorized()]);
    expect([a, b]).toEqual([true, true]);
    expect(h.api.refresh).toHaveBeenCalledTimes(1);
    expect(h.api.refresh).toHaveBeenCalledWith('ref-1');
    expect(hooks?.getToken()).toBe('tok-2');
  });

  it('refreshes proactively at 80% of the access-token lifetime', async () => {
    const h = harness({ idleLockSeconds: 0 });
    await signedIn(h);
    await vi.advanceTimersByTimeAsync(719_000);
    expect(h.api.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.api.refresh).toHaveBeenCalledTimes(1);
  });

  it('signs out when the refresh is rejected', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.api.refresh.mockRejectedValue(problem(401, 'unauthenticated'));
    expect(await h.hooks.current?.onUnauthorized()).toBe(false);
    expect(app.getState()).toMatchObject({
      auth: 'signed-out',
      loginError: 'Session expired. Sign in again.',
    });
    expect(h.rt.stop).toHaveBeenCalled();
  });

  it('keeps the session through a network failure and retries the refresh', async () => {
    const h = harness({ idleLockSeconds: 0 });
    const app = await signedIn(h);
    h.api.refresh.mockRejectedValueOnce(networkDown());
    await h.hooks.current?.onUnauthorized();
    expect(app.getState().auth).toBe('active');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.api.refresh).toHaveBeenCalledTimes(2);
  });
});

describe('board reload (transport-agnostic display state)', () => {
  it('does a full REST reload on EVERY (re)subscription and replaces the board', async () => {
    const h = harness();
    const app = await signedIn(h, [ticket({ id: 'a' }), ticket({ id: 'b' })]);
    expect(h.api.listTickets).toHaveBeenCalledTimes(1);
    expect([...app.getState().board.tickets.keys()].sort()).toEqual(['a', 'b']);
    expect(app.getState().synced).toBe(true);

    // socket drops; while it is down 'b' was served and 'c' arrived (events lost)
    h.rt.handlers.onState('reconnecting');
    expect(app.getState()).toMatchObject({ connection: 'reconnecting', synced: false });
    h.api.listTickets.mockResolvedValue([ticket({ id: 'a' }), ticket({ id: 'c' })]);
    h.rt.handlers.onState('online');
    h.rt.handlers.onSubscribed();
    await flush();

    expect(h.api.listTickets).toHaveBeenCalledTimes(2);
    expect([...app.getState().board.tickets.keys()].sort()).toEqual(['a', 'c']);
    expect(app.getState().synced).toBe(true);
  });

  it('keeps an event that arrives while the reload is in flight (snapshot may be older)', async () => {
    const h = harness();
    const app = await signedIn(h);
    let release!: (t: Ticket[]) => void;
    h.api.listTickets.mockReturnValue(new Promise((r) => (release = r)));
    h.rt.handlers.onSubscribed();
    await flush();
    h.rt.handlers.onTicket(ticket({ id: 'a', status: 'ACCEPTED', version: 3 }));
    h.rt.handlers.onTicket(ticket({ id: 'new', version: 1 }));
    release([ticket({ id: 'a', status: 'NEW', version: 2 })]); // snapshot taken before v3
    await flush();
    expect(app.getState().board.tickets.get('a')?.status).toBe('ACCEPTED');
    expect(app.getState().board.tickets.has('new')).toBe(true);
  });

  it('shows the last-known board and retries with backoff when the reload fails', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.api.listTickets.mockRejectedValue(networkDown());
    h.rt.handlers.onSubscribed();
    await flush();
    expect(app.getState()).toMatchObject({ reloadFailed: true, synced: false });
    expect(app.getState().board.tickets.size).toBe(1); // last known, not wiped
    h.api.listTickets.mockResolvedValue([ticket({ id: 'z' })]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(app.getState()).toMatchObject({ reloadFailed: false, synced: true });
    expect([...app.getState().board.tickets.keys()]).toEqual(['z']);
  });

  it('offline: read-only, polls REST every 10 s until the socket is back', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.rt.handlers.onState('reconnecting');
    expect(h.api.listTickets).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(h.api.listTickets).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(h.api.listTickets).toHaveBeenCalledTimes(3);

    await app.bump('a'); // changes are refused while offline
    expect(h.api.transition).not.toHaveBeenCalled();
    expect(app.getState().toasts[0]?.text).toMatch(/Reconnecting/);

    h.rt.handlers.onState('online');
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(h.api.listTickets).toHaveBeenCalledTimes(3); // polling stopped
  });

  it('restores the cached board after a page reload, before any network', async () => {
    const h = harness();
    await signedIn(h, [ticket({ id: 'cached' })]);
    const again = new KdsApp(h.deps);
    again.boot();
    expect([...again.getState().board.tickets.keys()]).toEqual(['cached']);
    expect(again.getState().synced).toBe(false);
  });

  it('corrects elapsed timers with the server clock offset', async () => {
    const h = harness();
    h.api.getSystemInfo.mockResolvedValue({
      serverTimeMs: Date.now() + 90_000,
      realtime: null,
      minKdsVersion: null,
    });
    const app = await signedIn(h);
    expect(app.getState().clockOffsetMs).toBe(90_000);
  });
});

describe('bump: optimistic UI + server truth', () => {
  it('shows the target status as pending, then settles on the server ticket', async () => {
    const h = harness();
    const app = await signedIn(h);
    let done!: (t: Ticket) => void;
    h.api.transition.mockReturnValue(new Promise((r) => (done = r)));

    const p = app.bump('a');
    await flush();
    expect(app.getState().pending.get('a')).toEqual({ to: 'ACCEPTED' });
    expect(app.getState().board.tickets.get('a')?.status).toBe('NEW'); // store is never mutated optimistically

    done(ticket({ id: 'a', status: 'ACCEPTED', version: 2 }));
    await p;
    expect(app.getState().pending.size).toBe(0);
    expect(app.getState().board.tickets.get('a')).toMatchObject({ status: 'ACCEPTED', version: 2 });
  });

  it('sends the ETag fetched just before as If-Match and the next status as target', async () => {
    const h = harness();
    const app = await signedIn(h, [ticket({ id: 'a', status: 'IN_PROGRESS', version: 4 })]);
    h.api.getTicket.mockResolvedValue({
      ticket: ticket({ id: 'a', status: 'IN_PROGRESS', version: 4 }),
      etag: 'W/"4"',
    });
    h.api.transition.mockResolvedValue(ticket({ id: 'a', status: 'READY', version: 5 }));
    await app.bump('a');
    expect(h.api.transition).toHaveBeenCalledWith('a', 'READY', expect.any(String), 'W/"4"');
  });

  it('a served ticket leaves the board', async () => {
    const h = harness();
    const app = await signedIn(h, [ticket({ id: 'a', status: 'READY' })]);
    h.api.getTicket.mockResolvedValue({
      ticket: ticket({ id: 'a', status: 'READY' }),
      etag: '"1"',
    });
    h.api.transition.mockResolvedValue(ticket({ id: 'a', status: 'DISPENSED', version: 2 }));
    await app.bump('a');
    expect(app.getState().board.tickets.size).toBe(0);
  });

  it('rejected transition: reverts, explains why, and reloads server truth', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.api.transition.mockRejectedValue(
      problem(409, 'order_state_invalid', 'Ticket K-a cannot move from READY to ACCEPTED.'),
    );
    h.api.listTickets.mockResolvedValue([ticket({ id: 'a', status: 'READY', version: 9 })]);

    await app.bump('a');
    await flush();

    expect(app.getState().pending.size).toBe(0);
    expect(app.getState().toasts.map((t) => t.text)).toEqual([
      'Ticket K-a cannot move from READY to ACCEPTED.',
    ]);
    expect(app.getState().board.tickets.get('a')).toMatchObject({ status: 'READY', version: 9 }); // server truth
    expect(h.api.listTickets).toHaveBeenCalledTimes(2);
  });

  it('a concurrency conflict (If-Match failed) is explained and the board refreshed', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.api.transition.mockRejectedValue(problem(412, 'concurrency_conflict'));
    await app.bump('a');
    await flush();
    expect(app.getState().toasts[0]?.text).toMatch(/changed by someone else/);
    expect(app.getState().pending.size).toBe(0);
  });

  it('does not clobber a ticket another screen already moved', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.api.getTicket.mockResolvedValue({
      ticket: ticket({ id: 'a', status: 'ACCEPTED', version: 2 }),
      etag: '"2"',
    });
    await app.bump('a');
    expect(h.api.transition).not.toHaveBeenCalled();
    expect(app.getState().board.tickets.get('a')?.status).toBe('ACCEPTED');
    expect(app.getState().toasts[0]?.text).toMatch(/just updated/);
  });

  it('ignores a second tap while the first is in flight', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.api.transition.mockReturnValue(new Promise(() => undefined));
    void app.bump('a');
    await flush();
    await app.bump('a');
    expect(h.api.transition).toHaveBeenCalledTimes(1);
  });

  it('refuses when the account lacks prep_ticket.transition', async () => {
    const h = harness();
    h.api.login.mockResolvedValue(session({ permissions: ['prep_ticket.view'] }));
    const app = await signedIn(h);
    await app.bump('a');
    expect(h.api.getTicket).not.toHaveBeenCalled();
    expect(app.getState().toasts[0]?.text).toMatch(/not allowed/);
  });
});

describe('idempotency keys on transitions', () => {
  it('reuses the same key when the same action is retried after a network failure', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.api.transition.mockRejectedValueOnce(networkDown());
    await app.bump('a');
    expect(app.getState().toasts[0]?.text).toMatch(/not confirmed/);
    h.api.transition.mockResolvedValue(ticket({ id: 'a', status: 'ACCEPTED', version: 2 }));
    await app.bump('a');

    const keys = h.api.transition.mock.calls.map((c) => c[2]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses a different key for the next step of the same ticket', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.api.transition.mockResolvedValueOnce(ticket({ id: 'a', status: 'ACCEPTED', version: 2 }));
    await app.bump('a');
    h.api.getTicket.mockResolvedValue({
      ticket: ticket({ id: 'a', status: 'ACCEPTED', version: 2 }),
      etag: '"2"',
    });
    h.api.transition.mockResolvedValueOnce(ticket({ id: 'a', status: 'IN_PROGRESS', version: 3 }));
    await app.bump('a');
    const [k1, k2] = h.api.transition.mock.calls.map((c) => c[2]);
    expect(k1).not.toBe(k2);
  });

  it('drops the key after a definitive rejection so a later attempt is a new request', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.api.transition.mockRejectedValueOnce(problem(409, 'order_state_invalid', 'no'));
    await app.bump('a');
    await flush();
    h.api.transition.mockResolvedValue(ticket({ id: 'a', status: 'ACCEPTED', version: 2 }));
    await app.bump('a');
    const [k1, k2] = h.api.transition.mock.calls.map((c) => c[2]);
    expect(k1).not.toBe(k2);
  });
});

describe('sound, settings and device commands', () => {
  it('chimes for a new ticket after the first load, not during it, and honours mute', async () => {
    const h = harness();
    const app = await signedIn(h, [ticket({ id: 'a' })]);
    expect(h.chime.play).not.toHaveBeenCalled(); // initial load is silent
    h.rt.handlers.onTicket(ticket({ id: 'n1' }));
    expect(h.chime.play).toHaveBeenCalledTimes(1);
    h.rt.handlers.onTicket(ticket({ id: 'n1', status: 'ACCEPTED', version: 2 })); // not new
    h.rt.handlers.onTicket(ticket({ id: 'a', version: 1 })); // duplicate
    expect(h.chime.play).toHaveBeenCalledTimes(1);
    app.saveSettings({ muted: true });
    h.rt.handlers.onTicket(ticket({ id: 'n2' }));
    expect(h.chime.play).toHaveBeenCalledTimes(1);
  });

  it('threshold precedence: device override > station value > build config', async () => {
    const h = harness();
    const app = await signedIn(h);
    expect(app.thresholds()).toEqual({ warnAfterSeconds: 300, lateAfterSeconds: 600 });
    app.saveSettings({ warnAfterSeconds: 60, lateAfterSeconds: 120 });
    expect(app.thresholds()).toEqual({ warnAfterSeconds: 60, lateAfterSeconds: 120 });
    expect(h.storage.settings().warnAfterSeconds).toBe(60); // persisted per device
  });

  it('device commands: LOCK, REFRESH_STATE, FORCE_LOGOUT, REVOKE', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.rt.handlers.onDeviceCommand?.('REFRESH_STATE');
    await flush();
    expect(h.api.listTickets).toHaveBeenCalledTimes(2);
    h.rt.handlers.onDeviceCommand?.('LOCK');
    expect(app.getState().auth).toBe('locked');
    h.rt.handlers.onDeviceCommand?.('FORCE_LOGOUT');
    expect(app.getState().auth).toBe('signed-out');
    h.rt.handlers.onDeviceCommand?.('REVOKE');
    expect(app.getState().device).toBeNull();
  });

  it('site health is surfaced', async () => {
    const h = harness();
    const app = await signedIn(h);
    h.rt.handlers.onSiteHealth?.('DEGRADED');
    expect(app.getState().siteStatus).toBe('DEGRADED');
  });

  it('a refused channel auth tries one refresh and resubscribes', async () => {
    const h = harness();
    await signedIn(h);
    h.rt.start.mockClear();
    h.rt.handlers.onState('auth-error');
    await flush();
    expect(h.api.refresh).toHaveBeenCalledTimes(1);
    expect(h.rt.start).toHaveBeenCalledTimes(1);
  });
});
