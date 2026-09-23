import { newIdempotencyKey } from './idempotency';
import {
  parseDeviceRegistration,
  parseLogin,
  parseStation,
  parseSystemInfo,
  parseTicket,
  parseTicketPayload,
  type DeviceRegistration,
  type Station,
  type StaffSession,
  type SystemInfo,
} from './dto';
import type { Ticket } from '../state/tickets';
import type { TransitionTarget } from '../state/transitions';

/**
 * Thin fetch wrapper for the 007 Resort & Spa API.
 *
 * The API is authoritative: it validates every status transition and records the staff member and
 * timestamps. This client only transports requests. Every mutating request carries an
 * `Idempotency-Key` header; callers pass the same key when retrying the same action.
 */

/** Non-2xx response. Fields follow RFC 7807 problem+json with a stable `code`. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  readonly code: string | null;
  readonly title: string | null;
  readonly detail: string | null;

  constructor(status: number, body: string) {
    let code: string | null = null;
    let title: string | null = null;
    let detail: string | null = null;
    try {
      const p: unknown = JSON.parse(body);
      if (typeof p === 'object' && p !== null) {
        const o = p as Record<string, unknown>;
        code = typeof o.code === 'string' ? o.code : null;
        title = typeof o.title === 'string' ? o.title : null;
        detail = typeof o.detail === 'string' ? o.detail : null;
      }
    } catch {
      /* not JSON */
    }
    super(`API request failed with status ${String(status)}${code === null ? '' : ` (${code})`}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.code = code;
    this.title = title;
    this.detail = detail;
  }

  /** Human text for the kitchen, preferring the server's own explanation. */
  get userMessage(): string {
    return this.detail ?? this.title ?? `Request failed (${String(this.status)})`;
  }
}

/** The request never got a response (LAN down, server restarting, timeout). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Cannot reach the server', { cause });
    this.name = 'NetworkError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly idempotencyKey?: () => string;
  /** Bearer token supplier (read on every request). */
  readonly getToken?: () => string | null;
  /** `X-Device-Token` supplier (sent on every request when present). */
  readonly getDeviceToken?: () => string | null;
  /**
   * Called on a 401 that is not a login failure. Resolve `true` when the session was refreshed:
   * the request is then retried once (same Idempotency-Key). Otherwise the app drops the session.
   */
  readonly onUnauthorized?: () => Promise<boolean> | boolean;
  /** Called on 403 `device_revoked` / `device_not_registered`. */
  readonly onDeviceRejected?: () => void;
  readonly timeoutMs?: number;
}

export interface RequestOptions {
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Skip the Authorization header (login, refresh, register, system info). */
  readonly anonymous?: boolean;
  /** Use this bearer instead of the current one (e.g. logging out a previous session). */
  readonly bearer?: string;
}

export interface WithHeaders<T> {
  readonly data: T;
  readonly headers: Headers;
}

export type CredentialType = 'PIN' | 'PASSWORD' | 'NFC_CARD';

export interface LoginRequest {
  readonly credentialType: CredentialType;
  /** PIN, password, or NFC card UID (contract field `secret`). */
  readonly secret: string;
  /** Staff username / number (PASSWORD, PIN). Omitted for NFC_CARD. */
  readonly identifier?: string;
}

export interface RegisterDeviceRequest {
  readonly name: string;
  readonly registrationCode: string;
  readonly hardwareId: string;
  readonly appVersion: string;
}

const API_PREFIX = '/api/v1';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_PAGES = 20;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly newKey: () => string;
  private readonly getToken: () => string | null;
  private readonly getDeviceToken: () => string | null;
  private readonly onUnauthorized: (() => Promise<boolean> | boolean) | undefined;
  private readonly onDeviceRejected: (() => void) | undefined;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.newKey = options.idempotencyKey ?? newIdempotencyKey;
    this.getToken = options.getToken ?? (() => null);
    this.getDeviceToken = options.getDeviceToken ?? (() => null);
    this.onUnauthorized = options.onUnauthorized;
    this.onDeviceRejected = options.onDeviceRejected;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Full URL for an API path. */
  url(path: string): string {
    return `${this.baseUrl}${API_PREFIX}${path}`;
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.requestWithHeaders<T>(method, path, opts)).data;
  }

  async requestWithHeaders<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
    retried = false,
  ): Promise<WithHeaders<T>> {
    const upper = method.toUpperCase();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Correlation-Id': newIdempotencyKey(),
      ...opts.headers,
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    // Same key across the refresh-retry: a replay returns the original result.
    const idemKey = MUTATING_METHODS.has(upper) ? (opts.idempotencyKey ?? this.newKey()) : null;
    if (idemKey !== null) headers['Idempotency-Key'] = idemKey;
    const token = opts.anonymous === true ? null : (opts.bearer ?? this.getToken());
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    const deviceToken = this.getDeviceToken();
    if (deviceToken !== null) headers['X-Device-Token'] = deviceToken;

    const init: RequestInit = { method: upper, headers };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (this.timeoutMs > 0 && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(this.timeoutMs);
    }

    let response: Response;
    try {
      response = await this.fetchFn(this.url(path), init);
    } catch (e) {
      throw new NetworkError(e);
    }
    if (!response.ok) {
      const error = new ApiError(response.status, await response.text());
      if (response.status === 401 && opts.anonymous !== true && opts.bearer === undefined) {
        if (!retried && this.onUnauthorized !== undefined && (await this.onUnauthorized())) {
          return this.requestWithHeaders<T>(
            method,
            path,
            { ...opts, ...(idemKey === null ? {} : { idempotencyKey: idemKey }) },
            true,
          );
        }
      } else if (
        response.status === 403 &&
        (error.code === 'device_revoked' || error.code === 'device_not_registered')
      ) {
        this.onDeviceRejected?.();
      }
      throw error;
    }
    if (response.status === 204) return { data: undefined as T, headers: response.headers };
    const text = await response.text();
    return { data: (text === '' ? undefined : JSON.parse(text)) as T, headers: response.headers };
  }

  /** GET /api/v1/system/info (unauthenticated). */
  async getSystemInfo(): Promise<SystemInfo> {
    return parseSystemInfo(await this.request('GET', '/system/info', { anonymous: true }));
  }

  /** POST /api/v1/devices/register with the one-time code from the admin UI. */
  async registerDevice(req: RegisterDeviceRequest): Promise<DeviceRegistration> {
    const raw = await this.request<unknown>('POST', '/devices/register', {
      body: { ...req, kind: 'KDS_SCREEN', platform: 'web' },
      anonymous: true,
    });
    const reg = parseDeviceRegistration(raw);
    if (reg === null) throw new Error('Registration response did not contain a device token');
    return reg;
  }

  /** POST /api/v1/auth/staff/login. */
  async login(req: LoginRequest): Promise<StaffSession> {
    const raw = await this.request<unknown>('POST', '/auth/staff/login', {
      body: req,
      anonymous: true,
    });
    const session = parseLogin(raw);
    if (session === null) throw new Error('Login response did not contain an access token');
    return session;
  }

  /** POST /api/v1/auth/staff/refresh - rotates the pair; each refresh token is single-use. */
  async refresh(refreshToken: string): Promise<StaffSession> {
    const raw = await this.request<unknown>('POST', '/auth/staff/refresh', {
      body: { refreshToken },
      anonymous: true,
    });
    const session = parseLogin(raw);
    if (session === null) throw new Error('Refresh response did not contain an access token');
    return session;
  }

  /** POST /api/v1/auth/staff/logout (best effort; ends the session server-side). */
  async logout(bearer?: string): Promise<void> {
    await this.request<undefined>(
      'POST',
      '/auth/staff/logout',
      bearer === undefined ? {} : { bearer },
    );
  }

  /** GET /api/v1/kds/stations. */
  async listStations(): Promise<Station[]> {
    const raw = await this.request<unknown>('GET', '/kds/stations');
    return itemsOf(raw).flatMap((s) => {
      const st = parseStation(s);
      return st === null ? [] : [st];
    });
  }

  /**
   * GET /api/v1/kds/stations/{id}/tickets - the full current board (follows cursors). The contract
   * default filter is NEW,ACCEPTED,IN_PROGRESS,READY.
   */
  async listTickets(stationId: string): Promise<Ticket[]> {
    const tickets: Ticket[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const q: string = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      const raw = await this.request<unknown>(
        'GET',
        `/kds/stations/${encodeURIComponent(stationId)}/tickets${q}`,
      );
      for (const t of itemsOf(raw)) {
        const parsed = parseTicket(t);
        if (parsed !== null) tickets.push(parsed);
      }
      const next: unknown =
        typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>).nextCursor
          : null;
      cursor = typeof next === 'string' && next !== '' ? next : null;
      if (cursor === null) break;
    }
    return tickets;
  }

  /** GET /api/v1/prep-tickets/{id}: the current ticket plus its ETag (for If-Match). */
  async getTicket(ticketId: string): Promise<{ ticket: Ticket; etag: string | null }> {
    const { data, headers } = await this.requestWithHeaders<unknown>(
      'GET',
      `/prep-tickets/${encodeURIComponent(ticketId)}`,
    );
    const ticket = parseTicketPayload(data);
    if (ticket === null) throw new Error('Unreadable ticket response');
    return { ticket, etag: headers.get('ETag') };
  }

  /**
   * POST /api/v1/prep-tickets/{id}/transition `{to}` with `If-Match` and `Idempotency-Key`.
   * The API decides whether the move is legal. Returns the updated ticket.
   */
  async transition(
    ticketId: string,
    to: TransitionTarget,
    idempotencyKey: string,
    etag: string,
  ): Promise<Ticket | null> {
    const raw = await this.request<unknown>(
      'POST',
      `/prep-tickets/${encodeURIComponent(ticketId)}/transition`,
      { body: { to }, idempotencyKey, headers: { 'If-Match': etag } },
    );
    return raw === undefined ? null : parseTicketPayload(raw);
  }
}

function itemsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>;
    const list = o.items ?? o.data;
    if (Array.isArray(list)) return list;
  }
  return [];
}
