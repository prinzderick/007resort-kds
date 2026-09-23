import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockServer, type MockServer } from './server.ts';

let mock: MockServer;
let token: string;
let device: string;
let stationId: string;
let ticketId: string;

const call = (path: string, init: RequestInit = {}, auth = true) =>
  fetch(`${mock.url}/api/v1${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      'X-Device-Token': device,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

beforeAll(async () => {
  mock = await createMockServer({ port: 0, healthEverySeconds: 0, staticDir: null });
  const reg = (await (
    await fetch(`${mock.url}/api/v1/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'r1' },
      body: JSON.stringify({ registrationCode: 'KDS-1234', name: 'x', kind: 'KDS_SCREEN' }),
    })
  ).json()) as { deviceToken: string };
  device = reg.deviceToken;
  const login = await call(
    '/auth/staff/login',
    {
      method: 'POST',
      body: JSON.stringify({ credentialType: 'PIN', identifier: 'S-0004', secret: '1234' }),
    },
    false,
  );
  token = ((await login.json()) as { accessToken: string }).accessToken;
  const stations = (await (await call('/kds/stations')).json()) as { items: { id: string }[] };
  stationId = stations.items[0]!.id;
  const list = (await (await call(`/kds/stations/${stationId}/tickets`)).json()) as {
    items: { id: string; status: string }[];
  };
  ticketId = list.items.find((t) => t.status === 'NEW')!.id;
});
afterAll(async () => {
  await mock.close();
});

describe('mock server contract behaviour', () => {
  it('requires a registered device for PIN login and rejects bad credentials', async () => {
    const noDevice = await fetch(`${mock.url}/api/v1/auth/staff/login`, {
      method: 'POST',
      body: JSON.stringify({ credentialType: 'PIN', identifier: 'S-0004', secret: '1234' }),
    });
    expect(noDevice.status).toBe(403);
    const bad = await call(
      '/auth/staff/login',
      {
        method: 'POST',
        body: JSON.stringify({ credentialType: 'PIN', identifier: 'S-0004', secret: '0000' }),
      },
      false,
    );
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { code: string }).code).toBe('invalid_credentials');
  });

  it('seeds realistic tickets in contract shape', async () => {
    const r = (await (await call(`/kds/stations/${stationId}/tickets`)).json()) as {
      items: Record<string, unknown>[];
    };
    expect(r.items.length).toBeGreaterThanOrEqual(5);
    expect(r.items[0]).toMatchObject({
      rowVersion: 1,
      status: expect.any(String),
      number: expect.stringMatching(/^K-\d+$/),
    });
    expect(Array.isArray(r.items[0]?.items)).toBe(true);
  });

  it('transition needs Idempotency-Key (400) and If-Match (428/412)', async () => {
    const t = (path: string, headers: Record<string, string>) =>
      call(`/prep-tickets/${ticketId}/transition${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ to: 'ACCEPTED' }),
      });
    expect((await t('', {})).status).toBe(400);
    expect((await t('', { 'Idempotency-Key': 'k-noif' })).status).toBe(428);
    expect((await t('', { 'Idempotency-Key': 'k-badif', 'If-Match': '"99"' })).status).toBe(412);
  });

  it('applies a legal transition once; a replay with the same key returns the original result', async () => {
    const send = (key: string, etag: string) =>
      call(`/prep-tickets/${ticketId}/transition`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key, 'If-Match': etag },
        body: JSON.stringify({ to: 'ACCEPTED' }),
      });
    const first = await send('k-1', '"1"');
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe('"2"');
    const firstBody = (await first.json()) as { status: string; rowVersion: number };
    expect(firstBody).toMatchObject({ status: 'ACCEPTED', rowVersion: 2 });

    const replay = await send('k-1', '"1"'); // stale If-Match, but the key was already served
    expect(replay.status).toBe(200);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(((await replay.json()) as { rowVersion: number }).rowVersion).toBe(2); // not applied twice

    const reused = await call(`/prep-tickets/${ticketId}/transition`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-1', 'If-Match': '"2"' },
      body: JSON.stringify({ to: 'READY' }),
    });
    expect(reused.status).toBe(422);
    expect(((await reused.json()) as { code: string }).code).toBe('idempotency_key_reused');
  });

  it('rejects an illegal transition with 409 order_state_invalid', async () => {
    const r = await call(`/prep-tickets/${ticketId}/transition`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-illegal', 'If-Match': '"2"' },
      body: JSON.stringify({ to: 'DISPENSED' }),
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe('order_state_invalid');
  });

  it('view-only staff cannot transition', async () => {
    const l = await call(
      '/auth/staff/login',
      {
        method: 'POST',
        body: JSON.stringify({ credentialType: 'PIN', identifier: 'S-0004', secret: '5678' }),
      },
      false,
    );
    const viewer = ((await l.json()) as { accessToken: string }).accessToken;
    const r = await call(`/prep-tickets/${ticketId}/transition`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${viewer}`, 'Idempotency-Key': 'k-v', 'If-Match': '"2"' },
      body: JSON.stringify({ to: 'IN_PROGRESS' }),
    });
    expect(r.status).toBe(403);
  });

  it('refresh tokens are single-use', async () => {
    const l = await call(
      '/auth/staff/login',
      {
        method: 'POST',
        body: JSON.stringify({ credentialType: 'PIN', identifier: 'S-0004', secret: '1234' }),
      },
      false,
    );
    const { refreshToken } = (await l.json()) as { refreshToken: string };
    const ok = await call(
      '/auth/staff/refresh',
      { method: 'POST', body: JSON.stringify({ refreshToken }) },
      false,
    );
    expect(ok.status).toBe(200);
    const again = await call(
      '/auth/staff/refresh',
      { method: 'POST', body: JSON.stringify({ refreshToken }) },
      false,
    );
    expect(again.status).toBe(401);
  });

  it('authorises private channels only with token + device and the right channel', async () => {
    const auth = (channel: string, headers: Record<string, string> = {}) =>
      call('/broadcasting/auth', {
        method: 'POST',
        headers,
        body: JSON.stringify({ socket_id: '1.2', channel_name: channel }),
      });
    expect((await auth(`private-kds.station.${stationId}`)).status).toBe(200);
    expect(
      ((await (await auth(`private-kds.station.${stationId}`)).json()) as { auth: string }).auth,
    ).toMatch(/^r007-local-key:[0-9a-f]{64}$/);
    expect((await auth('private-facility.x.orders')).status).toBe(403);
    expect((await auth(`private-kds.station.${stationId}`, { 'X-Device-Token': '' })).status).toBe(
      403,
    );
  });
});
