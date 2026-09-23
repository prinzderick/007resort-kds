import { TICKET_STATUSES, type Ticket, type TicketItem, type TicketStatus } from '../state/tickets';

/**
 * Wire (JSON) -> view-model mapping. Tolerant of a few aliases so the KDS keeps working while
 * the API contract settles; anything that cannot be understood is dropped, never guessed.
 */

export interface Station {
  readonly id: string;
  /** Short code when the API provides one; falls back to the id. */
  readonly code: string;
  readonly name: string;
  /** KITCHEN | BAR | DISPENSE */
  readonly kind?: string;
  /** Optional per-station ageing thresholds supplied by the API. */
  readonly warnAfterSeconds?: number;
  readonly lateAfterSeconds?: number;
}

export interface StaffSession {
  readonly accessToken: string;
  /** Single-use, rotating. Kept in memory only. */
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number;
  readonly staffName: string;
  readonly staffId: string | null;
  /** Permission strings such as `prep_ticket.transition`; null when the API did not send any. */
  readonly permissions: readonly string[] | null;
}

export interface RealtimeInfo {
  readonly scheme: 'ws' | 'wss';
  readonly host: string;
  readonly port: number;
  readonly appKey: string;
}

export interface SystemInfo {
  readonly serverTimeMs: number | null;
  readonly realtime: RealtimeInfo | null;
  readonly minKdsVersion: string | null;
}

export interface DeviceRegistration {
  readonly deviceId: string;
  readonly deviceToken: string;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined;
}
function posNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function parseItem(raw: unknown): TicketItem | null {
  if (!isObj(raw)) return null;
  const name = str(raw.name ?? raw.productName);
  if (name === undefined) return null;
  const quantity = posNum(raw.quantity ?? raw.qty) ?? 1;
  const modifiers = Array.isArray(raw.modifiers)
    ? raw.modifiers.flatMap((m: unknown) => {
        const label = isObj(m) ? str(m.name ?? m.label) : str(m);
        return label === undefined ? [] : [label];
      })
    : [];
  const notes = str(raw.notes ?? raw.note);
  return {
    name,
    quantity,
    ...(modifiers.length > 0 ? { modifiers } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseTicket(raw: unknown): Ticket | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  const status = str(raw.status);
  const createdAtUtc = str(raw.createdAt ?? raw.createdAtUtc);
  const version = posNum(raw.rowVersion ?? raw.version);
  if (
    id === undefined ||
    status === undefined ||
    !(TICKET_STATUSES as readonly string[]).includes(status) ||
    createdAtUtc === undefined ||
    Number.isNaN(Date.parse(createdAtUtc)) ||
    version === undefined
  ) {
    return null;
  }
  const items = (Array.isArray(raw.items) ? raw.items : []).flatMap((i: unknown) => {
    const item = parseItem(i);
    return item === null ? [] : [item];
  });
  const number = str(raw.number ?? raw.ticketNumber) ?? id.slice(-4);
  const tableLabel = str(raw.tableLabel ?? raw.table);
  const orderNumber = str(raw.orderNumber ?? raw.orderRef);
  const serverName = str(raw.waiterName ?? raw.serverName);
  const acceptedAtUtc = str(raw.acceptedAt);
  const readyAtUtc = str(raw.readyAt);
  const notes = str(raw.notes ?? raw.note);
  return {
    id,
    number,
    stationCode: str(raw.stationCode) ?? str(raw.stationId) ?? '',
    status: status as TicketStatus,
    createdAtUtc,
    version,
    items,
    ...(tableLabel !== undefined ? { tableLabel } : {}),
    ...(orderNumber !== undefined ? { orderNumber } : {}),
    ...(serverName !== undefined ? { serverName } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(acceptedAtUtc !== undefined ? { acceptedAtUtc } : {}),
    ...(readyAtUtc !== undefined ? { readyAtUtc } : {}),
  };
}

/**
 * A ticket arrives bare (REST), as `{ ticket }`, or inside the realtime envelope
 * `{ eventId, occurredAt, data: { ticket } }`.
 */
export function parseTicketPayload(raw: unknown): Ticket | null {
  if (isObj(raw)) {
    const data = raw.data;
    const inner = (isObj(data) ? data.ticket : undefined) ?? raw.ticket ?? data;
    if (isObj(inner)) return parseTicket(inner);
  }
  return parseTicket(raw);
}

/** Realtime envelope metadata (`eventId` is used to dedupe at-least-once delivery). */
export function eventIdOf(raw: unknown): string | null {
  return isObj(raw) ? (str(raw.eventId) ?? null) : null;
}

export function parseStation(raw: unknown): Station | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id);
  if (id === undefined) return null;
  const code = str(raw.code) ?? id;
  const warn = posNum(raw.warnAfterSeconds);
  const late = posNum(raw.lateAfterSeconds);
  const kind = str(raw.kind);
  if (raw.active === false) return null;
  return {
    id,
    code,
    name: str(raw.name) ?? code,
    ...(kind !== undefined ? { kind } : {}),
    ...(warn !== undefined ? { warnAfterSeconds: warn } : {}),
    ...(late !== undefined ? { lateAfterSeconds: late } : {}),
  };
}

export function parseLogin(raw: unknown): StaffSession | null {
  if (!isObj(raw)) return null;
  const accessToken = str(raw.accessToken);
  if (accessToken === undefined) return null;
  const staff = isObj(raw.staff) ? raw.staff : {};
  const perms = Array.isArray(staff.permissions)
    ? staff.permissions.filter((p): p is string => typeof p === 'string')
    : null;
  return {
    accessToken,
    refreshToken: str(raw.refreshToken) ?? null,
    expiresInSeconds: posNum(raw.expiresInSeconds) ?? 900,
    staffName: str(staff.displayName ?? staff.name) ?? 'Staff',
    staffId: str(staff.id) ?? null,
    permissions: perms,
  };
}

export function parseSystemInfo(raw: unknown): SystemInfo {
  const o = isObj(raw) ? raw : {};
  const t = str(o.serverTime);
  const rt = isObj(o.realtime) ? o.realtime : null;
  const min = isObj(o.minClientVersion) ? str(o.minClientVersion.kds) : undefined;
  let realtime: RealtimeInfo | null = null;
  if (rt !== null) {
    const host = str(rt.host);
    const port = posNum(rt.port);
    const appKey = str(rt.appKey);
    if (host !== undefined && port !== undefined && appKey !== undefined) {
      realtime = { scheme: rt.scheme === 'wss' ? 'wss' : 'ws', host, port, appKey };
    }
  }
  return {
    serverTimeMs: t !== undefined && !Number.isNaN(Date.parse(t)) ? Date.parse(t) : null,
    realtime,
    minKdsVersion: min ?? null,
  };
}

export function parseDeviceRegistration(raw: unknown): DeviceRegistration | null {
  if (!isObj(raw)) return null;
  const device = isObj(raw.device) ? raw.device : {};
  const deviceToken = str(raw.deviceToken);
  const deviceId = str(device.id);
  return deviceToken === undefined || deviceId === undefined ? null : { deviceId, deviceToken };
}
