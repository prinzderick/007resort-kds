import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api/client';
import { KdsApp } from './app';
import { DeviceStorage } from './device/storage';
import { KdsRealtime } from './realtime/kds-realtime';
import { memoryStorage, TEST_CONFIG } from './test/fakes';
import { createMockServer, type MockServer } from '../mock/server.ts';

/**
 * End-to-end against the mock server: real ApiClient, real Laravel Echo + pusher-js speaking the
 * Pusher protocol over a real WebSocket, real KdsApp. No fakes except the audio chime.
 */

let mock: MockServer;
const chime = { play: vi.fn() };

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function makeApp(): { app: KdsApp; realtime: { states: string[] } } {
  const states: string[] = [];
  const config = {
    ...TEST_CONFIG,
    apiBaseUrl: mock.url,
    reverb: { host: '127.0.0.1', port: mock.port, scheme: 'http' as const, key: mock.reverbKey },
    idleLockSeconds: 0,
  };
  const app = new KdsApp({
    config,
    storage: new DeviceStorage(memoryStorage()),
    chime,
    makeApi: (hooks) => new ApiClient({ baseUrl: mock.url, ...hooks }),
    makeRealtime: (hooks, handlers) =>
      new KdsRealtime(
        {
          reverb: config.reverb,
          authUrl: `${mock.url}/api/v1/broadcasting/auth`,
          ...hooks,
          random: () => 0,
        },
        {
          ...handlers,
          onState: (s) => {
            states.push(s);
            handlers.onState(s);
          },
        },
      ),
  });
  app.boot();
  return { app, realtime: { states } };
}

async function signInToFirstStation(app: KdsApp): Promise<void> {
  expect(await app.registerDevice('Test KDS', 'KDS-1234')).toBe(true);
  expect(await app.login({ credentialType: 'PIN', secret: '1234' })).toBe(true);
  await until(() => (app.getState().stations?.length ?? 0) > 0, 'stations');
  app.chooseStation(app.getState().stations![0]!);
  await until(() => app.getState().connection === 'online' && app.getState().synced, 'live board');
}

beforeAll(async () => {
  mock = await createMockServer({ port: 0, healthEverySeconds: 0, staticDir: null });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.reset();
  chime.play.mockClear();
});

describe('KDS <-> mock server (real Echo / Pusher protocol)', () => {
  it('connects, loads the seeded board, receives live tickets and chimes', async () => {
    const { app } = makeApp();
    await signInToFirstStation(app);
    const station = app.getState().station!;
    expect(app.getState().board.tickets.size).toBe(7);

    const created = mock.createTicket(station.id);
    await until(() => app.getState().board.tickets.has(created.id), 'live ticket');
    expect(chime.play).toHaveBeenCalledTimes(1);
    app.signOut();
  });

  it('bumps a ticket through the API: optimistic pending, then server truth, and other screens see the event', async () => {
    const { app } = makeApp();
    await signInToFirstStation(app);
    const station = app.getState().station!;
    const newTicket = [...app.getState().board.tickets.values()].find((t) => t.status === 'NEW')!;

    await app.bump(newTicket.id);
    expect(mock.tickets.get(newTicket.id)?.status).toBe('ACCEPTED');
    expect(app.getState().board.tickets.get(newTicket.id)).toMatchObject({
      status: 'ACCEPTED',
      version: 2,
    });
    expect(app.getState().pending.size).toBe(0);
    expect(app.getState().station?.id).toBe(station.id);
    app.signOut();
  });

  it('shows the server explanation when the API rejects an illegal transition, then re-syncs', async () => {
    const { app } = makeApp();
    await signInToFirstStation(app);
    const t = [...app.getState().board.tickets.values()].find((x) => x.status === 'NEW')!;
    // server-side drift the KDS has not heard about (same rowVersion, different status)
    mock.tickets.get(t.id)!.status = 'READY';

    await app.bump(t.id); // KDS thinks NEW -> asks ACCEPTED
    await until(
      () => app.getState().board.tickets.get(t.id)?.status === 'READY',
      'reconciled board',
    );
    expect(app.getState().toasts[0]?.text).toMatch(/cannot move from READY to ACCEPTED/);
    expect(app.getState().pending.size).toBe(0);
    app.signOut();
  });

  it('after a dropped socket it reconnects and fully reloads the list (missed events recovered)', async () => {
    const { app, realtime } = makeApp();
    await signInToFirstStation(app);
    const station = app.getState().station!;
    const victim = [...app.getState().board.tickets.values()][0]!;

    mock.dropSockets();
    // While the KDS is disconnected: one ticket is served, one new arrives, with NO events delivered.
    mock.tickets.get(victim.id)!.status = 'DISPENSED';
    const fresh = mock.createTicket(station.id);

    await until(() => realtime.states.includes('reconnecting'), 'reconnecting state');
    await until(
      () => app.getState().connection === 'online' && app.getState().synced,
      'reconnected',
    );
    await until(() => app.getState().board.tickets.has(fresh.id), 'reloaded new ticket');
    expect(app.getState().board.tickets.has(victim.id)).toBe(false);
    app.signOut();
  });

  it('read-only during an outage: last-known board stays, then recovers by itself', async () => {
    const { app } = makeApp();
    await signInToFirstStation(app);
    const before = app.getState().board.tickets.size;
    mock.outage(1.5);
    await until(() => app.getState().connection === 'reconnecting', 'reconnecting');
    expect(app.getState().board.tickets.size).toBe(before);
    await app.bump([...app.getState().board.tickets.keys()][0]!);
    expect(app.getState().toasts.at(-1)?.text).toMatch(/Reconnecting/);
    await until(
      () => app.getState().connection === 'online' && app.getState().synced,
      'recovery',
      15000,
    );
    app.signOut();
  }, 20000);

  it('an expired access token is refreshed transparently and the action still succeeds', async () => {
    const { app } = makeApp();
    await signInToFirstStation(app);
    const t = [...app.getState().board.tickets.values()].find((x) => x.status === 'NEW')!;
    mock.expireTokens();
    await app.bump(t.id);
    expect(mock.tickets.get(t.id)?.status).toBe('ACCEPTED');
    expect(app.getState().auth).toBe('active');
    app.signOut();
  });

  it('device commands from the server reach the kiosk (LOCK)', async () => {
    const { app } = makeApp();
    await signInToFirstStation(app);
    const deviceId = app.getState().device!.id;
    mock.deviceCommand(deviceId, 'LOCK');
    await until(() => app.getState().auth === 'locked', 'lock command');
    app.signOut();
  });
});
