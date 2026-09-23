import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api/client';
import { KdsApp } from './app';
import { DeviceStorage } from './device/storage';
import { KdsRealtime, type SiteStatus } from './realtime/kds-realtime';
import { memoryStorage, TEST_CONFIG } from './test/fakes';

/**
 * End-to-end against the REAL local node (Laravel API + Reverb), not the mock. Skipped unless
 * `R007_API_BASE_URL` is set, e.g.
 *
 *   R007_API_BASE_URL=http://127.0.0.1:8080 npm test -- real-node
 *
 * Relies on the seeded demo data documented in work/LOCAL_NODE.md (deterministic dev device tokens,
 * staff PIN 1234, Restaurant food routed to the Main Kitchen, drinks to the Restaurant Bar).
 * It creates real orders (it mutates the dev database) and is re-runnable. Optional:
 * `scripts/real-viewer-user.sh` creates the view-only user `kdsview1` (that test is skipped
 * without it).
 */
const BASE = process.env.R007_API_BASE_URL?.replace(/\/+$/, '');
const V1 = `${BASE ?? ''}/api/v1`;

const KDS_KITCHEN = {
  token: 'r7d_dev_kds_main_kitchen',
  id: '12c5c733-2b18-555d-a1a3-ede6f991e925',
};
const KDS_POOL = { token: 'r7d_dev_kds_pool_bar', id: '' };
const KITCHEN_ST = {
  id: '9ac72d5b-5285-55ed-92a1-f4528a7debbc',
  code: 'MK',
  name: 'Main Kitchen Pass',
};
const POOL_ST = { id: '7c1ec1bc-7abb-5a45-a6c2-06ca888f3fe0', code: 'PB', name: 'Pool Bar' };
const RESTAURANT = 'a206b41c-f916-5185-b405-db8a5b67b4db';
const WAITER = { token: 'r7d_dev_tablet_waiter_01', id: 'e612c5af-f79f-508d-98ae-73f229403ebb' };

interface Res {
  status: number;
  json: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  etag: string | null;
}
async function call(
  path: string,
  o: {
    token?: string;
    device?: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Res> {
  const r = await fetch(V1 + path, {
    method: o.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': `kds-e2e-${String(Math.random())}`,
      ...(o.token === undefined ? {} : { Authorization: `Bearer ${o.token}` }),
      ...(o.device === undefined ? {} : { 'X-Device-Token': o.device }),
      ...o.headers,
    },
    ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
  });
  const text = await r.text();
  return {
    status: r.status,
    json: text === '' ? {} : JSON.parse(text),
    etag: r.headers.get('etag'),
  };
}
const login = async (
  identifier: string,
  device: string,
): Promise<{ token: string; staffId: string }> => {
  const r = await call('/auth/staff/login', {
    device,
    method: 'POST',
    body: { credentialType: 'PIN', identifier, secret: '1234' },
  });
  if (r.status !== 200) throw new Error(`login ${identifier} -> ${String(r.status)}`);
  return { token: r.json.accessToken as string, staffId: r.json.staffId as string };
};

/** wait1 on tablet 01 (checked out to RESTAURANT) sends an order: Jollof (kitchen) + beer (bar). */
async function sendRestaurantOrder(qty = 1): Promise<string> {
  const { token, staffId } = await login('wait1', WAITER.token);
  const h = { token, device: WAITER.token };
  const body = { staffId, facilityId: RESTAURANT };
  let co = await call(`/devices/${WAITER.id}/checkout`, { ...h, method: 'POST', body });
  if (co.status === 409) {
    await call(`/devices/${WAITER.id}/checkin`, { ...h, method: 'POST', body: {} });
    co = await call(`/devices/${WAITER.id}/checkout`, { ...h, method: 'POST', body });
  }
  expect(co.status).toBe(200);
  const products = await call(`/catalog/products?facilityId=${RESTAURANT}&limit=200`, h);
  const pid = (sku: string): string =>
    (products.json.items as { sku: string; id: string }[]).find((p) => p.sku === sku)!.id;
  const tables = await call(`/tables?facilityId=${RESTAURANT}&limit=200`, h);
  const free = (tables.json.items as { status: string; id: string }[]).find(
    (t) => t.status === 'FREE' || t.status === 'AVAILABLE',
  );
  if (free !== undefined) await call(`/tables/${free.id}/open`, { ...h, method: 'POST', body: {} });
  const created = await call('/orders', {
    ...h,
    method: 'POST',
    body: {
      facilityId: RESTAURANT,
      channel: 'DINE_IN',
      ...(free === undefined ? {} : { tableId: free.id }),
      lines: [
        { productId: pid('FD-JOL-CH'), quantity: qty, notes: 'no pepper' },
        { productId: pid('BR-STAR'), quantity: qty },
      ],
    },
  });
  expect(created.status).toBe(201);
  const sent = await call(`/orders/${created.json.id as string}/send`, {
    ...h,
    method: 'POST',
    body: {},
    headers: { 'If-Match': created.etag ?? '' },
  });
  expect(sent.status).toBe(200);
  return created.json.id as string;
}

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

async function makeApp(
  device: { token: string; id: string },
  health?: SiteStatus[],
  presetStation?: typeof KITCHEN_ST,
): Promise<KdsApp> {
  const info = (await (await fetch(`${V1}/system/info`)).json()) as {
    realtime: { host: string; port: number; appKey: string };
  };
  const storage = new DeviceStorage(memoryStorage());
  storage.setDevice({ id: device.id, token: device.token });
  if (presetStation !== undefined) storage.setStation({ ...presetStation });
  const config = {
    ...TEST_CONFIG,
    apiBaseUrl: BASE!,
    // clients dial the API host; the node advertises its LAN address (see LOCAL_NODE.md)
    reverb: {
      host: new URL(BASE!).hostname,
      port: info.realtime.port,
      scheme: 'http' as const,
      key: info.realtime.appKey,
    },
    idleLockSeconds: 0,
  };
  const app = new KdsApp({
    config,
    storage,
    chime: { play: vi.fn() },
    makeApi: (hooks) => new ApiClient({ baseUrl: BASE!, ...hooks }),
    makeRealtime: (hooks, handlers) =>
      new KdsRealtime(
        { reverb: config.reverb, authUrl: `${BASE!}/api/v1/broadcasting/auth`, ...hooks },
        {
          ...handlers,
          onSiteHealth: (s) => {
            health?.push(s);
            handlers.onSiteHealth?.(s);
          },
        },
      ),
  });
  app.boot();
  return app;
}

async function liveAt(app: KdsApp, staffNo: string, station: typeof KITCHEN_ST): Promise<void> {
  expect(await app.login({ credentialType: 'PIN', identifier: staffNo, secret: '1234' })).toBe(
    true,
  );
  await until(() => (app.getState().stations?.length ?? 0) > 0, 'stations');
  const st = app.getState().stations!.find((s) => s.id === station.id);
  expect(st, `station ${station.name} offered to ${staffNo}`).toBeDefined();
  app.chooseStation(st!);
  await until(() => app.getState().connection === 'online' && app.getState().synced, 'live board');
}

describe.skipIf(BASE === undefined)('KDS <-> REAL local node (Laravel + Reverb)', () => {
  it('Main Kitchen: live ticket via Reverb, then bump NEW -> ACCEPTED -> IN_PROGRESS -> READY -> DISPENSED with If-Match', async () => {
    const health: SiteStatus[] = [];
    const app = await makeApp(KDS_KITCHEN, health);
    await liveAt(app, 'S-0004', KITCHEN_ST); // kitchen1 by staff number + PIN
    const known = new Set(app.getState().board.tickets.keys());

    const orderId = await sendRestaurantOrder(2);
    await until(
      () => [...app.getState().board.tickets.values()].some((t) => !known.has(t.id)),
      'live ticket',
    );
    const ticket = [...app.getState().board.tickets.values()].find((t) => !known.has(t.id))!;
    expect(ticket.status).toBe('NEW');
    expect(ticket.items.map((i) => i.name)).toEqual(['Jollof Rice & Chicken']); // the beer went to the bar
    expect(ticket.items[0]?.quantity).toBe(2);

    const kt = await login('kitchen1', KDS_KITCHEN.token);
    const server = async (): Promise<Res> =>
      call(`/prep-tickets/${ticket.id}`, { token: kt.token, device: KDS_KITCHEN.token });

    for (const [status, version] of [
      ['ACCEPTED', 2],
      ['IN_PROGRESS', 3],
      ['READY', 4],
    ] as const) {
      await app.bump(ticket.id);
      const s = await server();
      expect(s.json.status).toBe(status);
      expect(s.json.rowVersion).toBe(version);
      expect(s.etag).toBe(`"${String(version)}"`);
      expect(app.getState().board.tickets.get(ticket.id)?.status).toBe(status);
      expect(app.getState().pending.size).toBe(0);
    }
    await app.bump(ticket.id); // Served
    expect((await server()).json.status).toBe('DISPENSED');
    expect(app.getState().board.tickets.has(ticket.id)).toBe(false);
    expect(orderId).toBeTruthy();

    // site.health keep-alive (every 30 s): the cloudLink check must not make the kitchen look degraded
    await until(() => health.length > 0, 'site.health', 45_000);
    expect(health.at(-1)).toBe('ONLINE');
    app.signOut();
  }, 90_000);

  it('rejects a stale If-Match (412) and an illegal jump, and the app reconciles with a toast', async () => {
    const app = await makeApp(KDS_KITCHEN);
    await liveAt(app, 'S-0004', KITCHEN_ST);
    await sendRestaurantOrder(1);
    await until(
      () => [...app.getState().board.tickets.values()].some((t) => t.status === 'NEW'),
      'new ticket',
    );
    const t = [...app.getState().board.tickets.values()].find((x) => x.status === 'NEW')!;
    const kt = await login('kitchen1', KDS_KITCHEN.token);
    const h = {
      token: kt.token,
      device: KDS_KITCHEN.token,
      method: 'POST',
      body: { to: 'ACCEPTED' },
    };
    const stale = await call(`/prep-tickets/${t.id}/transition`, {
      ...h,
      headers: { 'If-Match': '"99"' },
    });
    expect(stale.status).toBe(412);
    expect(stale.json.code).toBe('concurrency_conflict');
    const none = await call(`/prep-tickets/${t.id}/transition`, h);
    expect(none.status).toBe(428); // If-Match is mandatory
    const illegal = await call(`/prep-tickets/${t.id}/transition`, {
      ...h,
      body: { to: 'DISPENSED' },
      headers: { 'If-Match': '"1"' },
    });
    expect(illegal.status).toBe(409);
    expect(illegal.json.code).toBe('order_state_invalid');
    app.signOut();
  }, 30_000);

  it('another screen moves the ticket first: the KDS sees the live update and no double transition happens', async () => {
    const app = await makeApp(KDS_KITCHEN);
    await liveAt(app, 'S-0004', KITCHEN_ST);
    await sendRestaurantOrder(1);
    await until(
      () => [...app.getState().board.tickets.values()].some((t) => t.status === 'NEW'),
      'new ticket',
    );
    const t = [...app.getState().board.tickets.values()].find((x) => x.status === 'NEW')!;
    const kt = await login('kitchen1', KDS_KITCHEN.token);
    const cur = await call(`/prep-tickets/${t.id}`, { token: kt.token, device: KDS_KITCHEN.token });
    await call(`/prep-tickets/${t.id}/transition`, {
      token: kt.token,
      device: KDS_KITCHEN.token,
      method: 'POST',
      body: { to: 'ACCEPTED' },
      headers: { 'If-Match': cur.etag ?? '' },
    });
    await until(
      () => app.getState().board.tickets.get(t.id)?.status === 'ACCEPTED',
      'live update from another screen',
    );
    app.signOut();
  }, 30_000);

  it('station isolation: a Pool Bar screen cannot open the kitchen station (REST, channel auth, kiosk)', async () => {
    const bt = await login('bartender1', KDS_POOL.token);
    const rest = await call(`/kds/stations/${KITCHEN_ST.id}/tickets`, {
      token: bt.token,
      device: KDS_POOL.token,
    });
    expect(rest.status).toBe(403);
    expect(rest.json.code).toBe('permission_denied');
    const chan = (name: string): Promise<Res> =>
      call('/broadcasting/auth', {
        token: bt.token,
        device: KDS_POOL.token,
        method: 'POST',
        body: { socket_id: '123.456', channel_name: name },
      });
    expect((await chan(`private-kds.station.${KITCHEN_ST.id}`)).status).toBe(403);
    expect((await chan(`private-facility.${RESTAURANT}.orders`)).status).toBe(403);
    expect((await chan(`private-kds.station.${POOL_ST.id}`)).status).toBe(200);

    // A kiosk forced onto the kitchen station goes back to the picker with an explanation (not "session expired")
    const app = await makeApp({ token: KDS_POOL.token, id: '' }, undefined, KITCHEN_ST);
    expect(await app.login({ credentialType: 'PIN', identifier: 'S-0003', secret: '1234' })).toBe(
      true,
    );
    await until(() => app.getState().station === null, 'back at the picker');
    expect(app.getState().auth).toBe('active');
    expect(app.getState().toasts.at(-1)?.text).toMatch(/no access/);
    await until(() => (app.getState().stations?.length ?? 0) > 0, 'station list');
    expect(app.getState().stations!.map((s) => s.name)).not.toContain('Main Kitchen Pass');
    app.signOut();
  }, 30_000);

  it('a Pool Bar screen does not see the restaurant kitchen ticket', async () => {
    const app = await makeApp(KDS_POOL);
    await liveAt(app, 'S-0003', POOL_ST);
    const before = app.getState().board.tickets.size;
    await sendRestaurantOrder(1);
    await new Promise((r) => setTimeout(r, 2000));
    expect(app.getState().board.tickets.size).toBe(before);
    app.signOut();
  }, 30_000);

  it('without prep_ticket.transition the session is view-only (API refuses too)', async (ctx) => {
    const probe = await call('/auth/staff/login', {
      device: KDS_KITCHEN.token,
      method: 'POST',
      body: { credentialType: 'PIN', identifier: 'kdsview1', secret: '1234' },
    });
    if (probe.status !== 200) ctx.skip(); // run scripts/real-viewer-user.sh to create the user
    const app = await makeApp(KDS_KITCHEN);
    await liveAt(app, 'kdsview1', KITCHEN_ST);
    await sendRestaurantOrder(1);
    await until(
      () => [...app.getState().board.tickets.values()].some((t) => t.status === 'NEW'),
      'new ticket',
    );
    const t = [...app.getState().board.tickets.values()].find((x) => x.status === 'NEW')!;
    await app.bump(t.id);
    expect(app.getState().toasts.at(-1)?.text).toMatch(/not allowed/);
    expect(app.getState().board.tickets.get(t.id)?.status).toBe('NEW');
    const cur = await call(`/prep-tickets/${t.id}`, {
      token: probe.json.accessToken as string,
      device: KDS_KITCHEN.token,
    });
    const tr = await call(`/prep-tickets/${t.id}/transition`, {
      token: probe.json.accessToken as string,
      device: KDS_KITCHEN.token,
      method: 'POST',
      body: { to: 'ACCEPTED' },
      headers: { 'If-Match': cur.etag ?? '' },
    });
    expect(tr.status).toBe(403);
    expect(tr.json.code).toBe('permission_denied');
    app.signOut();
  }, 30_000);

  it('PIN login without a staff number is refused by the node (422): the KDS always sends an identifier', async () => {
    const r = await call('/auth/staff/login', {
      device: KDS_KITCHEN.token,
      method: 'POST',
      body: { credentialType: 'PIN', secret: '1234' },
    });
    expect(r.status).toBe(422);
  });
});
