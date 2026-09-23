import Echo from 'laravel-echo';
import Pusher from 'pusher-js';
import type { ReverbConfig } from '../config';
import { eventIdOf, parseTicketPayload } from '../api/dto';
import type { Ticket } from '../state/tickets';

/**
 * Realtime transport: Laravel Reverb (Pusher protocol) through Laravel Echo (api/realtime.md).
 *
 * Channels (Echo prefixes `private-`):
 *  - `kds.station.{stationId}`  events `prep-ticket.created` / `prep-ticket.updated`
 *  - `site.status`              event `site.health` (also a 30 s liveness signal)
 *  - `device.{deviceId}`        event `device.command` (FORCE_LOGOUT | REFRESH_STATE | LOCK | REVOKE)
 * Channel auth: `POST /api/v1/broadcasting/auth` with `Authorization: Bearer` and `X-Device-Token`.
 *
 * Realtime is a HINT channel: delivery is at-least-once with no replay, so EVERY (re)subscription
 * of the station channel triggers `onSubscribed`, which the app answers with a full REST reload.
 * Reconnects use exponential backoff with jitter (1 s .. 30 s) that this class drives itself.
 */

export type ConnectionState =
  /** First connection attempt in progress. */
  | 'connecting'
  /** Socket connected and station channel subscribed: the board is live. */
  | 'online'
  /** Lost the socket; retrying forever. Board shows last-known data, read-only. */
  | 'reconnecting'
  /** The API refused the channel authorisation (token expired/revoked). */
  | 'auth-error';

export type SiteStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE';
export type DeviceCommandName = 'FORCE_LOGOUT' | 'REFRESH_STATE' | 'LOCK' | 'REVOKE';

export const STATION_CHANNEL = (stationId: string): string => `kds.station.${stationId}`;
export const SITE_CHANNEL = 'site.status';
export const DEVICE_CHANNEL = (deviceId: string): string => `device.${deviceId}`;
export const EVENT_CREATED = '.prep-ticket.created';
export const EVENT_UPDATED = '.prep-ticket.updated';
export const EVENT_HEALTH = '.site.health';
export const EVENT_DEVICE_COMMAND = '.device.command';

/** No `site.health` (30 s keep-alive) or other event for this long => the socket is stale. */
export const STALE_AFTER_MS = 75_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const SEEN_EVENT_CAP = 500;

/** The slice of Echo this module relies on; lets tests inject a fake. */
export interface ChannelLike {
  listen(event: string, cb: (payload: unknown) => void): ChannelLike;
  subscribed(cb: () => void): ChannelLike;
  error(cb: (err: unknown) => void): ChannelLike;
}
export interface EchoLike {
  private(channel: string): ChannelLike;
  leave(channel: string): void;
  /** Stops the socket (and pusher-js's own retry loop). */
  disconnect(): void;
  /** Opens the socket again; pusher-js re-subscribes and re-authorises every channel. */
  connect(): void;
  /** Pusher connection state changes ('connecting' | 'connected' | 'unavailable' | ...). */
  onConnectionState(cb: (current: string) => void): void;
}
export interface EchoFactoryOptions {
  readonly reverb: ReverbConfig;
  readonly authUrl: string;
  readonly getToken: () => string | null;
  readonly getDeviceToken?: () => string | null;
}
export type EchoFactory = (opts: EchoFactoryOptions) => EchoLike;

/** Real Echo instance. Pusher's activity/pong timeouts are tightened so a dead LAN is noticed fast. */
export const createEcho: EchoFactory = ({ reverb, authUrl, getToken, getDeviceToken }) => {
  const echo = new Echo({
    broadcaster: 'reverb',
    Pusher,
    key: reverb.key,
    wsHost: reverb.host,
    wsPort: reverb.port,
    wssPort: reverb.port,
    forceTLS: reverb.scheme === 'https',
    enabledTransports: ['ws', 'wss'],
    disableStats: true,
    activityTimeout: 20_000,
    pongTimeout: 8_000,
    unavailableTimeout: 5_000,
    authEndpoint: authUrl,
    channelAuthorization: {
      endpoint: authUrl,
      transport: 'ajax',
      headersProvider: () => {
        const headers: Record<string, string> = { Accept: 'application/json' };
        const token = getToken();
        if (token !== null) headers.Authorization = `Bearer ${token}`;
        const device = getDeviceToken?.() ?? null;
        if (device !== null) headers['X-Device-Token'] = device;
        return headers;
      },
    },
  });
  return {
    private: (channel) => echo.private(channel),
    leave: (channel) => {
      echo.leave(channel);
    },
    disconnect: () => {
      echo.disconnect();
    },
    connect: () => {
      echo.connector.pusher.connect();
    },
    onConnectionState: (cb) => {
      echo.connector.pusher.connection.bind('state_change', (s: { current: string }) => {
        cb(s.current);
      });
    },
  };
};

export interface RealtimeHandlers {
  readonly onTicket: (ticket: Ticket) => void;
  readonly onState: (state: ConnectionState) => void;
  /** Station channel (re)subscribed: reload the whole board from REST. */
  readonly onSubscribed: () => void;
  readonly onSiteHealth?: (status: SiteStatus) => void;
  readonly onDeviceCommand?: (command: DeviceCommandName) => void;
}

export interface RealtimeOptions extends EchoFactoryOptions {
  readonly factory?: EchoFactory;
  /** Deterministic jitter for tests. */
  readonly random?: () => number;
  readonly now?: () => number;
}

export class KdsRealtime {
  private readonly options: RealtimeOptions;
  private readonly handlers: RealtimeHandlers;
  private echo: EchoLike | null = null;
  private channels: string[] = [];
  private state: ConnectionState = 'connecting';
  private everOnline = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastActivity = 0;
  private healthSeen = false;
  private readonly seen = new Set<string>();

  constructor(options: RealtimeOptions, handlers: RealtimeHandlers) {
    this.options = options;
    this.handlers = handlers;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private setState(next: ConnectionState): void {
    if (next === this.state) return;
    this.state = next;
    this.handlers.onState(next);
  }

  /** Connects and subscribes to the station channel (plus site status and the device channel). */
  start(stationId: string, deviceId?: string): void {
    this.stop();
    this.everOnline = false;
    this.healthSeen = false;
    this.attempt = 0;
    this.seen.clear();
    this.lastActivity = this.now();
    this.state = 'connecting';
    this.handlers.onState('connecting');

    const echo = (this.options.factory ?? createEcho)(this.options);
    this.echo = echo;
    const stationName = STATION_CHANNEL(stationId);
    this.channels = [stationName, SITE_CHANNEL];

    echo.onConnectionState((current) => {
      if (this.echo !== echo) return;
      if (current === 'connected') {
        this.attempt = 0;
        return; // "online" is declared once the station channel is subscribed
      }
      if (current === 'unavailable' || current === 'failed' || current === 'disconnected') {
        this.beginBackoff(echo);
      } else if (current === 'connecting' && this.everOnline && this.state === 'online') {
        this.setState('reconnecting');
      }
    });

    /** Marks activity, drops duplicates (at-least-once delivery), returns false for repeats. */
    const accept = (payload: unknown): boolean => {
      this.lastActivity = this.now();
      const id = eventIdOf(payload);
      if (id === null) return true;
      if (this.seen.has(id)) return false;
      this.seen.add(id);
      if (this.seen.size > SEEN_EVENT_CAP) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
      return true;
    };
    const onTicket = (payload: unknown): void => {
      if (this.echo !== echo || !accept(payload)) return;
      const ticket = parseTicketPayload(payload);
      if (ticket !== null) this.handlers.onTicket(ticket);
    };

    echo
      .private(stationName)
      .listen(EVENT_CREATED, onTicket)
      .listen(EVENT_UPDATED, onTicket)
      .subscribed(() => {
        if (this.echo !== echo) return;
        this.lastActivity = this.now();
        this.everOnline = true;
        this.setState('online');
        this.handlers.onSubscribed();
      })
      .error((err) => {
        if (this.echo !== echo) return;
        const status = (err as { status?: unknown } | null)?.status;
        if (status === 401 || status === 403) this.setState('auth-error');
      });

    echo
      .private(SITE_CHANNEL)
      .listen(EVENT_HEALTH, (payload) => {
        if (this.echo !== echo || !accept(payload)) return;
        this.healthSeen = true;
        const status = healthStatusOf(payload);
        if (status !== null) this.handlers.onSiteHealth?.(status);
      })
      .error(() => {
        // Not fatal: without the health keep-alive we simply skip the stale-socket watchdog.
        this.healthSeen = false;
      });

    if (deviceId !== undefined) {
      const name = DEVICE_CHANNEL(deviceId);
      this.channels.push(name);
      echo.private(name).listen(EVENT_DEVICE_COMMAND, (payload) => {
        if (this.echo !== echo || !accept(payload)) return;
        const command = commandOf(payload);
        if (command !== null) this.handlers.onDeviceCommand?.(command);
      });
    }

    this.watchdog = setInterval(() => {
      if (this.echo !== echo || this.state !== 'online' || !this.healthSeen) return;
      if (this.now() - this.lastActivity > STALE_AFTER_MS) this.beginBackoff(echo, true);
    }, 5_000);
  }

  /** Exponential backoff with jitter, then `connect()`; stops pusher-js's own fixed-interval retry. */
  private beginBackoff(echo: EchoLike, immediate = false): void {
    if (this.retryTimer !== null) return; // already waiting (our own disconnect() re-enters here)
    this.setState(this.everOnline ? 'reconnecting' : 'connecting');
    const random = this.options.random ?? Math.random;
    const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const delay = immediate ? 0 : Math.round(ceiling * (0.5 + random() * 0.5));
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.echo !== echo) return;
      this.lastActivity = this.now();
      echo.connect();
    }, delay);
    echo.disconnect();
  }

  stop(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.retryTimer = null;
    this.watchdog = null;
    const echo = this.echo;
    this.echo = null;
    if (echo !== null) {
      for (const c of this.channels) echo.leave(c);
      echo.disconnect();
    }
    this.channels = [];
  }
}

function healthStatusOf(payload: unknown): SiteStatus | null {
  const data = (payload as { data?: { status?: unknown } } | null)?.data;
  const status = data?.status;
  return status === 'ONLINE' || status === 'DEGRADED' || status === 'OFFLINE' ? status : null;
}

function commandOf(payload: unknown): DeviceCommandName | null {
  const data = (payload as { data?: { command?: unknown } } | null)?.data;
  const c = data?.command;
  return c === 'FORCE_LOGOUT' || c === 'REFRESH_STATE' || c === 'LOCK' || c === 'REVOKE' ? c : null;
}
