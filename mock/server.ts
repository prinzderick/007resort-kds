import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { STAFF, STATIONS, mulberry32, pick, type MockStation } from './data.ts';

/**
 * Mock of the 007 Resort & Spa API surface the KDS uses, plus a Pusher-protocol (Laravel Reverb
 * compatible) WebSocket endpoint, so the KDS can be demoed and tested without the backend.
 *
 * Follows api/openapi/v1.yaml + api/realtime.md:
 * REST  : /system/info, /devices/register (code KDS-1234), /auth/staff/login|refresh|logout,
 *         /kds/stations, /kds/stations/{id}/tickets, /prep-tickets/{id} (ETag),
 *         /prep-tickets/{id}/transition (Idempotency-Key + If-Match), /broadcasting/auth
 * WS    : /app/{key}  Pusher protocol 7: connection_established, subscribe to private channels
 *         with HMAC auth, ping/pong. Channels private-kds.station.{id} (prep-ticket.created/
 *         updated), private-site.status (site.health every 30 s), private-device.{id}.
 * Admin : /mock/* (create ticket, drop sockets, outage, expire tokens, device command, reset).
 *
 * Demo credentials: registration code KDS-1234 (reusable in the mock); PIN 1234 (Chef Ada, may
 * transition), PIN 5678 (Trainee Tunde, view only), NFC card 04A1B2C3 (+ Ada's PIN 1234), password `kds` /
 * `kds-pass`. Like the real node, PIN and card logins must send an `identifier` (staff no. / card uid).
 */

/** Ladder plus the two skips the contract allows (NEW->IN_PROGRESS, ACCEPTED->READY). */
export const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  NEW: ['ACCEPTED', 'IN_PROGRESS'],
  ACCEPTED: ['IN_PROGRESS', 'READY'],
  IN_PROGRESS: ['READY'],
  READY: ['DISPENSED'],
};
const ACTIVE = ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'READY'];

export interface MockTicket {
  id: string;
  number: string;
  stationId: string;
  orderId: string;
  orderNumber: string;
  facilityId: string;
  tableLabel: string;
  status: string;
  items: {
    orderLineId: string;
    name: string;
    quantity: number;
    notes: string | null;
    status: string;
  }[];
  createdAt: string;
  acceptedAt: string | null;
  readyAt: string | null;
  waiterStaffId: string;
  waiterName: string;
  rowVersion: number;
}

export interface MockOptions {
  port?: number; // 0 = ephemeral
  host?: string;
  reverbKey?: string;
  reverbSecret?: string;
  /** Second listener for the Pusher socket (in addition to the API port). */
  reverbPort?: number | null;
  /** Seconds between simulated new tickets (0 = off). */
  simulateEverySeconds?: number;
  /** Seconds between `site.health` keep-alives (contract: 30). 0 = off. */
  healthEverySeconds?: number;
  /** Access token lifetime in seconds (contract: about 900). */
  accessTokenSeconds?: number;
  seed?: boolean;
  staticDir?: string | null;
  now?: () => number;
  log?: (line: string) => void;
}

export interface MockServer {
  readonly port: number;
  readonly url: string;
  readonly reverbKey: string;
  readonly tickets: Map<string, MockTicket>;
  createTicket(stationId?: string, ageSeconds?: number): MockTicket;
  /** Sends a `device.command` event to a device channel. */
  deviceCommand(deviceId: string, command: string): void;
  dropSockets(): void;
  outage(seconds: number): void;
  expireTokens(): void;
  reset(): void;
  socketCount(): number;
  close(): Promise<void>;
}

interface Socket {
  ws: WebSocket;
  id: string;
  channels: Set<string>;
}

interface Session {
  staffName: string;
  staffId: string;
  permissions: string[];
  expiresAt: number;
  revoked: boolean;
  refreshToken: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
};

const FACILITY_ID = '0190a000-0000-7000-8000-0000000000f1';
const REGISTRATION_CODE = 'KDS-1234';
const VIEW_ONLY = ['prep_ticket.view'];
const CAN_BUMP = ['prep_ticket.view', 'prep_ticket.transition'];

export async function createMockServer(options: MockOptions = {}): Promise<MockServer> {
  const key = options.reverbKey ?? 'r007-local-key';
  const secret = options.reverbSecret ?? 'r007-local-secret';
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const host = options.host ?? '127.0.0.1';
  const accessTtl = (options.accessTokenSeconds ?? 900) * 1000;

  const tickets = new Map<string, MockTicket>();
  const sessions = new Map<string, Session>(); // access token -> session
  const refreshIndex = new Map<string, string>(); // refresh token -> access token (single-use)
  const devices = new Map<string, string>(); // device token -> device id
  const idem = new Map<string, { fp: string; status: number; body: string }>();
  const sockets = new Set<Socket>();
  let outageUntil = 0;
  let seq = 41;
  let rand = mulberry32(7);

  const inOutage = (): boolean => now() < outageUntil;
  const stationBy = (id: string): MockStation | undefined => STATIONS.find((s) => s.id === id);
  const iso = (ms: number): string => new Date(ms).toISOString();

  // ---------- data ----------
  function createTicket(
    stationId?: string,
    ageSeconds = 0,
    status = 'NEW',
    announce = true,
  ): MockTicket {
    const st = stationId === undefined ? pick(rand, STATIONS) : stationBy(stationId);
    if (st === undefined) throw new Error(`unknown station ${String(stationId)}`);
    seq += 1;
    const lines = 1 + Math.floor(rand() * 3);
    const items = Array.from({ length: lines }, () => {
      const dish = pick(rand, st.menu);
      const parts = dish.modifiers.filter(() => rand() < 0.35);
      if (dish.notes !== undefined && rand() < 0.5) parts.push(pick(rand, dish.notes));
      return {
        orderLineId: randomUUID(),
        name: dish.name,
        quantity: 1 + Math.floor(rand() * 3),
        notes: parts.length > 0 ? parts.join(', ') : null,
        status,
      };
    });
    const created = now() - ageSeconds * 1000;
    const t: MockTicket = {
      id: randomUUID(),
      number: `K-${String(seq).padStart(3, '0')}`,
      stationId: st.id,
      orderId: randomUUID(),
      orderNumber: `RST1-${String(120 + seq).padStart(6, '0')}`,
      facilityId: FACILITY_ID,
      tableLabel: pick(rand, st.tables),
      status,
      items,
      createdAt: iso(created),
      acceptedAt: status === 'NEW' ? null : iso(created + 30_000),
      readyAt: status === 'READY' ? iso(created + 240_000) : null,
      waiterStaffId: randomUUID(),
      waiterName: pick(rand, STAFF),
      rowVersion: 1,
    };
    tickets.set(t.id, t);
    if (announce) broadcast(`private-kds.station.${st.id}`, 'prep-ticket.created', { ticket: t });
    return t;
  }

  function seed(): void {
    tickets.clear();
    seq = 41;
    rand = mulberry32(7);
    const spec: [number, string][] = [
      [40, 'NEW'],
      [130, 'NEW'],
      [340, 'ACCEPTED'],
      [455, 'IN_PROGRESS'],
      [690, 'IN_PROGRESS'],
      [520, 'READY'],
      [80, 'READY'],
    ];
    for (const st of STATIONS)
      for (const [age, status] of spec) createTicket(st.id, age, status, false);
  }

  // ---------- realtime ----------
  function send(s: Socket, message: Record<string, unknown>): void {
    if (s.ws.readyState === s.ws.OPEN) s.ws.send(JSON.stringify(message));
  }

  /** Contract envelope: `{ eventId, occurredAt, correlationId, data }` as the Pusher data string. */
  function broadcast(channel: string, event: string, data: Record<string, unknown>): void {
    const payload = JSON.stringify({
      eventId: randomUUID(),
      occurredAt: iso(now()),
      correlationId: randomUUID(),
      data,
    });
    for (const s of sockets)
      if (s.channels.has(channel)) send(s, { event, channel, data: payload });
  }

  const signature = (socketId: string, channel: string): string =>
    `${key}:${createHmac('sha256', secret).update(`${socketId}:${channel}`).digest('hex')}`;

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const appKey = /^\/app\/([^/?]+)/.exec(req.url ?? '')?.[1];
    if (appKey !== key) {
      ws.send(
        JSON.stringify({
          event: 'pusher:error',
          data: JSON.stringify({ code: 4001, message: `App key ${String(appKey)} not found` }),
        }),
      );
      ws.close(4001);
      return;
    }
    const s: Socket = {
      ws,
      id: `${String(Math.floor(rand() * 1e6))}.${String(Math.floor(rand() * 1e6))}`,
      channels: new Set(),
    };
    sockets.add(s);
    send(s, {
      event: 'pusher:connection_established',
      data: JSON.stringify({ socket_id: s.id, activity_timeout: 30 }),
    });
    ws.on('close', () => sockets.delete(s));
    ws.on('error', () => sockets.delete(s));
    ws.on('message', (raw) => {
      let msg: { event?: string; data?: unknown };
      try {
        msg = JSON.parse(
          Array.isArray(raw)
            ? Buffer.concat(raw).toString('utf8')
            : Buffer.from(raw as ArrayBuffer).toString('utf8'),
        ) as typeof msg;
      } catch {
        return;
      }
      const data = (): { channel?: string; auth?: string } =>
        (typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data) as {
          channel?: string;
          auth?: string;
        };
      if (msg.event === 'pusher:ping') {
        send(s, { event: 'pusher:pong', data: '{}' });
      } else if (msg.event === 'pusher:subscribe') {
        const d = data();
        const channel = d.channel ?? '';
        if (!channel.startsWith('private-') || d.auth !== signature(s.id, channel)) {
          send(s, {
            event: 'pusher:subscription_error',
            channel,
            data: { type: 'AuthError', error: 'Invalid signature', status: 403 },
          });
          return;
        }
        s.channels.add(channel);
        send(s, { event: 'pusher_internal:subscription_succeeded', channel, data: '{}' });
      } else if (msg.event === 'pusher:unsubscribe') {
        s.channels.delete(data().channel ?? '');
      }
    });
  });

  // ---------- http ----------
  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, Idempotency-Key, If-Match, Accept, X-Correlation-Id, X-Device-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'ETag, Idempotent-Replayed',
  };

  function json(
    res: ServerResponse,
    status: number,
    body: unknown,
    extra: Record<string, string> = {},
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...cors, ...extra });
    res.end(JSON.stringify(body));
  }
  function problem(
    res: ServerResponse,
    status: number,
    code: string,
    title: string,
    detail?: string,
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/problem+json', ...cors });
    res.end(
      JSON.stringify({
        type: `https://api.007resort.com/problems/${code}`,
        title,
        status,
        code,
        detail,
      }),
    );
  }

  function session(req: IncomingMessage): Session | 'expired' | null {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    const s = token === undefined ? undefined : sessions.get(token);
    if (s === undefined || s.revoked) return null;
    return s.expiresAt <= now() ? 'expired' : s;
  }
  const deviceOf = (req: IncomingMessage): string | null => {
    const t = req.headers['x-device-token'];
    return typeof t === 'string' ? (devices.get(t) ?? null) : null;
  };

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  const PEOPLE: Record<string, Record<string, { name: string; id: string; perms: string[] }>> = {
    PIN: {
      '1234': { name: 'Chef Ada', id: 'staff-ada', perms: CAN_BUMP },
      '5678': { name: 'Trainee Tunde', id: 'staff-tunde', perms: VIEW_ONLY },
    },
    PASSWORD: { 'kds:kds-pass': { name: 'KDS Supervisor', id: 'staff-sup', perms: CAN_BUMP } },
  };

  /** Card uid -> staff (the PIN of that same person is required as the secret). */
  const CARDS: Record<string, { name: string; id: string; perms: string[] }> = {
    '04A1B2C3': PEOPLE.PIN?.['1234'] as { name: string; id: string; perms: string[] },
  };

  function issue(who: { name: string; id: string; perms: string[] }): Record<string, unknown> {
    const accessToken = `mock.${randomUUID()}`;
    const refreshToken = `mockr.${randomUUID()}`;
    sessions.set(accessToken, {
      staffName: who.name,
      staffId: who.id,
      permissions: who.perms,
      expiresAt: now() + accessTtl,
      revoked: false,
      refreshToken,
    });
    refreshIndex.set(refreshToken, accessToken);
    return {
      accessToken,
      refreshToken,
      expiresInSeconds: Math.round(accessTtl / 1000),
      staff: { id: who.id, displayName: who.name, roles: ['KDS'], permissions: who.perms },
      session: { id: randomUUID(), expiresAt: iso(now() + 8 * 3600_000) },
    };
  }

  const wireTicket = (t: MockTicket): MockTicket => t; // already contract-shaped

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (inOutage()) {
      problem(res, 503, 'server_error', 'Simulated outage');
      return;
    }

    if (method === 'GET' && path === '/system/info') {
      const addr = http.address() as AddressInfo;
      json(res, 200, {
        service: '007resort-api-mock',
        apiVersion: '1.0.0',
        deploymentMode: 'local',
        serverTime: iso(now()),
        timezone: 'Africa/Lagos',
        currency: 'NGN',
        minClientVersion: { kds: '0.1.0' },
        realtime: {
          scheme: 'ws',
          host: (req.headers.host ?? 'localhost').split(':')[0] ?? 'localhost',
          port: options.reverbPort ?? addr.port,
          appKey: key,
        },
      });
      return;
    }

    if (method === 'POST' && path === '/devices/register') {
      const b = JSON.parse((await readBody(req)) || '{}') as {
        registrationCode?: string;
        name?: string;
        kind?: string;
      };
      if (b.registrationCode !== REGISTRATION_CODE) {
        problem(res, 422, 'validation_failed', 'Invalid registration code');
        return;
      }
      const deviceToken = `dev.${randomUUID()}`;
      const id = randomUUID();
      devices.set(deviceToken, id);
      json(res, 201, {
        device: {
          id,
          name: b.name ?? 'KDS Screen',
          kind: b.kind ?? 'KDS_SCREEN',
          status: 'ACTIVE',
          facilityId: FACILITY_ID,
        },
        deviceToken,
      });
      return;
    }

    if (method === 'POST' && path === '/auth/staff/login') {
      const b = JSON.parse((await readBody(req)) || '{}') as {
        credentialType?: string;
        identifier?: string;
        secret?: string;
      };
      if (
        (b.credentialType === 'PIN' || b.credentialType === 'NFC_CARD') &&
        deviceOf(req) === null
      ) {
        problem(res, 403, 'device_not_registered', 'PIN and card login need a registered device');
        return;
      }
      if (b.credentialType !== 'PASSWORD' && (b.identifier ?? '') === '') {
        // Like the real node: a bare PIN / bare card is never accepted.
        problem(res, 422, 'validation_failed', 'The identifier field is required.');
        return;
      }
      let who: { name: string; id: string; perms: string[] } | undefined;
      if (b.credentialType === 'NFC_CARD') {
        // Real node: identifier = card uid, secret = that staff member's PIN.
        const owner = CARDS[b.identifier ?? ''];
        who = owner !== undefined && PEOPLE.PIN?.[b.secret ?? ''] === owner ? owner : undefined;
      } else {
        const k =
          b.credentialType === 'PASSWORD'
            ? `${b.identifier ?? ''}:${b.secret ?? ''}`
            : (b.secret ?? '');
        who = PEOPLE[b.credentialType ?? '']?.[k];
      }
      if (who === undefined) {
        problem(res, 401, 'invalid_credentials', 'Invalid credentials');
        return;
      }
      json(res, 200, issue(who));
      return;
    }

    if (method === 'POST' && path === '/auth/staff/refresh') {
      const b = JSON.parse((await readBody(req)) || '{}') as { refreshToken?: string };
      const old = b.refreshToken === undefined ? undefined : refreshIndex.get(b.refreshToken);
      const prev = old === undefined ? undefined : sessions.get(old);
      if (prev === undefined || prev.revoked) {
        // Reuse of a consumed refresh token revokes the session family.
        for (const s of sessions.values()) if (s.refreshToken === b.refreshToken) s.revoked = true;
        problem(res, 401, 'unauthenticated', 'Refresh token is not valid');
        return;
      }
      refreshIndex.delete(b.refreshToken ?? '');
      sessions.delete(old ?? '');
      json(res, 200, issue({ name: prev.staffName, id: prev.staffId, perms: prev.permissions }));
      return;
    }

    const s = session(req);
    if (s === 'expired') {
      problem(res, 401, 'token_expired', 'Access token expired');
      return;
    }
    if (s === null) {
      problem(res, 401, 'unauthenticated', 'Unauthenticated');
      return;
    }

    if (method === 'POST' && path === '/auth/staff/logout') {
      s.revoked = true;
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (method === 'POST' && path === '/broadcasting/auth') {
      const raw = await readBody(req);
      const isJson = (req.headers['content-type'] ?? '').includes('json');
      const form = isJson ? null : new URLSearchParams(raw);
      const body = isJson ? (JSON.parse(raw || '{}') as Record<string, string>) : {};
      const socketId = form?.get('socket_id') ?? body.socket_id ?? '';
      const channel = form?.get('channel_name') ?? body.channel_name ?? '';
      const dev = deviceOf(req);
      if (dev === null) {
        problem(res, 403, 'device_not_registered', 'X-Device-Token is required');
        return;
      }
      const ok =
        (channel.startsWith('private-kds.station.') &&
          s.permissions.includes('prep_ticket.view')) ||
        channel === 'private-site.status' ||
        channel === `private-device.${dev}`;
      if (!ok) {
        problem(res, 403, 'permission_denied', 'Not allowed to subscribe to that channel');
        return;
      }
      json(res, 200, { auth: signature(socketId, channel) });
      return;
    }

    if (method === 'GET' && path === '/kds/stations') {
      json(res, 200, {
        items: STATIONS.map((st) => ({
          id: st.id,
          facilityId: FACILITY_ID,
          name: st.name,
          kind: st.code.includes('BAR') ? 'BAR' : 'KITCHEN',
          active: true,
        })),
        nextCursor: null,
      });
      return;
    }

    const list = /^\/kds\/stations\/([^/]+)\/tickets$/.exec(path);
    if (method === 'GET' && list?.[1] !== undefined) {
      if (!s.permissions.includes('prep_ticket.view')) {
        problem(res, 403, 'permission_denied', 'Forbidden');
        return;
      }
      const st = stationBy(decodeURIComponent(list[1]));
      if (st === undefined) {
        problem(res, 404, 'not_found', 'Station not found');
        return;
      }
      const items = [...tickets.values()]
        .filter((t) => t.stationId === st.id && ACTIVE.includes(t.status))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(wireTicket);
      json(res, 200, { items, nextCursor: null });
      return;
    }

    const one = /^\/prep-tickets\/([^/]+)$/.exec(path);
    if (method === 'GET' && one?.[1] !== undefined) {
      const t = tickets.get(decodeURIComponent(one[1]));
      if (t === undefined) {
        problem(res, 404, 'not_found', 'Ticket not found');
        return;
      }
      json(res, 200, wireTicket(t), { ETag: `"${String(t.rowVersion)}"` });
      return;
    }

    const tr = /^\/prep-tickets\/([^/]+)\/transition$/.exec(path);
    if (method === 'POST' && tr?.[1] !== undefined) {
      const idemKey = req.headers['idempotency-key'];
      if (typeof idemKey !== 'string' || idemKey === '') {
        problem(res, 400, 'idempotency_key_missing', 'Idempotency-Key header is required');
        return;
      }
      const raw = await readBody(req);
      const fp = `${path}|${raw}`;
      const prior = idem.get(idemKey);
      if (prior !== undefined) {
        if (prior.fp !== fp) {
          problem(
            res,
            422,
            'idempotency_key_reused',
            'Idempotency-Key was used with a different request',
          );
          return;
        }
        res.writeHead(prior.status, {
          'Content-Type': prior.status >= 400 ? 'application/problem+json' : 'application/json',
          'Idempotent-Replayed': 'true',
          ...cors,
        });
        res.end(prior.body);
        return;
      }
      const remember = (
        status: number,
        body: unknown,
        extra: Record<string, string> = {},
      ): void => {
        const text = JSON.stringify(body);
        idem.set(idemKey, { fp, status, body: text });
        res.writeHead(status, {
          'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json',
          ...cors,
          ...extra,
        });
        res.end(text);
      };
      if (!s.permissions.includes('prep_ticket.transition')) {
        problem(res, 403, 'permission_denied', 'Missing permission prep_ticket.transition');
        return;
      }
      const ticket = tickets.get(decodeURIComponent(tr[1]));
      if (ticket === undefined) {
        problem(res, 404, 'not_found', 'Ticket not found');
        return;
      }
      const ifMatch = req.headers['if-match'];
      if (typeof ifMatch !== 'string') {
        problem(res, 428, 'concurrency_conflict', 'If-Match header is required');
        return;
      }
      if (ifMatch !== `"${String(ticket.rowVersion)}"`) {
        problem(
          res,
          412,
          'concurrency_conflict',
          'Ticket changed',
          'The ticket was modified by someone else.',
        );
        return;
      }
      const body = JSON.parse(raw || '{}') as { to?: string };
      if (!['ACCEPTED', 'IN_PROGRESS', 'READY', 'DISPENSED'].includes(body.to ?? '')) {
        remember(422, {
          type: 'https://api.007resort.com/problems/validation_failed',
          title: 'Validation failed',
          status: 422,
          code: 'validation_failed',
          errors: { to: ['invalid'] },
        });
        return;
      }
      if (!(ALLOWED[ticket.status] ?? []).includes(body.to ?? '')) {
        remember(409, {
          type: 'https://api.007resort.com/problems/order_state_invalid',
          title: 'Illegal transition',
          status: 409,
          code: 'order_state_invalid',
          detail: `Ticket ${ticket.number} cannot move from ${ticket.status} to ${String(body.to)}.`,
        });
        return;
      }
      const previousStatus = ticket.status;
      ticket.status = body.to ?? ticket.status;
      ticket.rowVersion += 1;
      if (ticket.status === 'ACCEPTED') ticket.acceptedAt = iso(now());
      if (ticket.status === 'READY') ticket.readyAt = iso(now());
      for (const it of ticket.items) it.status = ticket.status;
      broadcast(`private-kds.station.${ticket.stationId}`, 'prep-ticket.updated', {
        ticket,
        previousStatus,
      });
      log(
        `ticket ${ticket.number} ${previousStatus} -> ${ticket.status} (v${String(ticket.rowVersion)})`,
      );
      remember(200, wireTicket(ticket), { ETag: `"${String(ticket.rowVersion)}"` });
      return;
    }

    problem(res, 404, 'not_found', 'Not found');
  }

  async function handleMock(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    url: URL,
  ): Promise<void> {
    if (path === '/mock/tickets' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}') as {
        stationId?: string;
        ageSeconds?: number;
      };
      json(res, 201, createTicket(b.stationId, b.ageSeconds ?? 0));
      return;
    }
    if (path === '/mock/drop-sockets') {
      api.dropSockets();
      json(res, 200, { ok: true });
      return;
    }
    if (path === '/mock/outage') {
      api.outage(Number(url.searchParams.get('seconds') ?? '15'));
      json(res, 200, { ok: true });
      return;
    }
    if (path === '/mock/expire-tokens') {
      api.expireTokens();
      json(res, 200, { ok: true });
      return;
    }
    if (path === '/mock/device-command') {
      const b = JSON.parse((await readBody(req)) || '{}') as {
        deviceId?: string;
        command?: string;
      };
      const id = b.deviceId ?? [...devices.values()][0] ?? '';
      api.deviceCommand(id, b.command ?? 'REFRESH_STATE');
      json(res, 200, { ok: true });
      return;
    }
    if (path === '/mock/reset') {
      api.reset();
      json(res, 200, { ok: true });
      return;
    }
    if (path === '/mock/state') {
      json(res, 200, {
        tickets: tickets.size,
        sockets: sockets.size,
        sessions: sessions.size,
      });
      return;
    }
    problem(res, 404, 'not_found', 'Not found');
  }

  const staticDir = options.staticDir === null ? null : resolve(options.staticDir ?? 'dist');
  function serveStatic(res: ServerResponse, path: string): boolean {
    if (staticDir === null || !existsSync(staticDir)) return false;
    let file = normalize(join(staticDir, path === '/' ? 'index.html' : path));
    if (!file.startsWith(resolve(staticDir))) return false;
    if (!existsSync(file) || !statSync(file).isFile()) file = join(staticDir, 'index.html');
    if (!existsSync(file)) return false;
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
    return true;
  }

  const http: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const run = (): Promise<void> => {
      if (path.startsWith('/api/v1/')) return handleApi(req, res, path.slice('/api/v1'.length));
      if (path.startsWith('/mock/')) return handleMock(req, res, path, url);
      if (path === '/config.json') {
        // Same-origin demo: the served bundle talks to whichever host/port serves it.
        json(res, 200, { VITE_R007_API_BASE_URL: 'origin' });
        return Promise.resolve();
      }
      if (!serveStatic(res, path)) problem(res, 404, 'not_found', 'Not found');
      return Promise.resolve();
    };
    run().catch((e: unknown) => {
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) problem(res, 500, 'server_error', 'Internal error');
      else res.end();
    });
  });

  const servers: Server[] = [http];
  const extraPort = options.reverbPort;
  if (extraPort !== undefined && extraPort !== null) {
    const extra = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    servers.push(extra);
    await new Promise<void>((ok) => extra.listen(extraPort, host, ok));
  }
  for (const srv of servers) {
    srv.on('upgrade', (req, socket, head) => {
      if (inOutage() || !(req.url ?? '').startsWith('/app/')) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  }

  await new Promise<void>((ok) => http.listen(options.port ?? 0, host, ok));
  const port = (http.address() as AddressInfo).port;

  if (options.seed !== false) seed();

  const timers: ReturnType<typeof setInterval>[] = [];
  const every = (options.simulateEverySeconds ?? 0) * 1000;
  if (every > 0) {
    timers.push(
      setInterval(() => {
        const t = createTicket();
        log(`new ticket ${t.number}`);
      }, every),
    );
  }
  const healthEvery = (options.healthEverySeconds ?? 30) * 1000;
  if (healthEvery > 0) {
    timers.push(
      setInterval(() => {
        broadcast('private-site.status', 'site.health', {
          status: 'ONLINE',
          checks: { database: 'ok', redis: 'ok', queue: 'ok', cloudLink: 'ok' },
          outboxDepth: 0,
          serverTime: iso(now()),
        });
      }, healthEvery),
    );
  }

  const api: MockServer = {
    port,
    url: `http://${host}:${String(port)}`,
    reverbKey: key,
    tickets,
    createTicket: (stationId, age) => createTicket(stationId, age),
    deviceCommand: (deviceId, command) => {
      broadcast(`private-device.${deviceId}`, 'device.command', {
        id: randomUUID(),
        command,
        issuedAt: iso(now()),
        payload: {},
      });
    },
    dropSockets: () => {
      for (const s of sockets) s.ws.terminate();
      sockets.clear();
    },
    outage: (seconds) => {
      outageUntil = now() + seconds * 1000;
      api.dropSockets();
    },
    expireTokens: () => {
      for (const s of sessions.values()) s.expiresAt = 0;
    },
    reset: () => {
      idem.clear();
      seed();
      for (const t of tickets.values()) {
        broadcast(`private-kds.station.${t.stationId}`, 'prep-ticket.updated', {
          ticket: t,
          previousStatus: t.status,
        });
      }
    },
    socketCount: () => sockets.size,
    close: async () => {
      for (const t of timers) clearInterval(t);
      api.dropSockets();
      wss.close();
      await Promise.all(
        servers.map(
          (srv) =>
            new Promise<void>((ok) => {
              srv.close(() => {
                ok();
              });
              srv.closeAllConnections();
            }),
        ),
      );
    },
  };
  return api;
}
