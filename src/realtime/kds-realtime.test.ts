import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KdsRealtime,
  STALE_AFTER_MS,
  type ChannelLike,
  type ConnectionState,
  type EchoFactory,
  type EchoLike,
  type RealtimeHandlers,
} from './kds-realtime';
import type { Ticket } from '../state/tickets';

class FakeChannel implements ChannelLike {
  readonly listeners = new Map<string, (p: unknown) => void>();
  subscribedCb: (() => void) | null = null;
  errorCb: ((e: unknown) => void) | null = null;
  listen(event: string, cb: (p: unknown) => void): this {
    this.listeners.set(event, cb);
    return this;
  }
  subscribed(cb: () => void): this {
    this.subscribedCb = cb;
    return this;
  }
  error(cb: (e: unknown) => void): this {
    this.errorCb = cb;
    return this;
  }
}

class FakeEcho implements EchoLike {
  readonly channels = new Map<string, FakeChannel>();
  readonly left: string[] = [];
  disconnects = 0;
  connects = 0;
  stateCb: ((s: string) => void) | null = null;
  private(name: string): FakeChannel {
    const ch = new FakeChannel();
    this.channels.set(name, ch);
    return ch;
  }
  leave(name: string): void {
    this.left.push(name);
  }
  disconnect(): void {
    this.disconnects++;
    this.stateCb?.('disconnected'); // pusher-js reports our own disconnect too
  }
  connect(): void {
    this.connects++;
    this.stateCb?.('connecting');
  }
  onConnectionState(cb: (s: string) => void): void {
    this.stateCb = cb;
  }
  /** Simulates the socket coming up and the server confirming all subscriptions. */
  up(): void {
    this.stateCb?.('connected');
    for (const ch of this.channels.values()) ch.subscribedCb?.();
  }
}

const wireTicket = (id: string, rowVersion = 1, status = 'NEW') => ({
  id,
  number: `K-${id}`,
  stationId: 'st-1',
  status,
  items: [],
  createdAt: '2026-09-23T10:15:30Z',
  rowVersion,
});
const envelope = (eventId: string, ticket: unknown) => ({
  eventId,
  occurredAt: 'x',
  data: { ticket },
});

function setup(now: () => number = Date.now) {
  const echo = new FakeEcho();
  const factory: EchoFactory = () => echo;
  const states: ConnectionState[] = [];
  const tickets: string[] = [];
  const handlers: RealtimeHandlers = {
    onTicket: vi.fn((t: Ticket) => {
      tickets.push(`${t.id}@${String(t.version)}`);
    }),
    onState: vi.fn((s: ConnectionState) => {
      states.push(s);
    }),
    onSubscribed: vi.fn(),
    onSiteHealth: vi.fn(),
    onDeviceCommand: vi.fn(),
  };
  const rt = new KdsRealtime(
    {
      reverb: { host: 'h', port: 1, scheme: 'http', key: 'k' },
      authUrl: 'http://a/auth',
      getToken: () => 't',
      factory,
      random: () => 1,
      now,
    },
    handlers,
  );
  return { echo, rt, handlers, states, tickets };
}

describe('KdsRealtime subscriptions', () => {
  it('subscribes to the private station, site and device channels', () => {
    const { echo, rt } = setup();
    rt.start('st-1', 'dev-9');
    expect([...echo.channels.keys()]).toEqual(['kds.station.st-1', 'site.status', 'device.dev-9']);
    expect([...(echo.channels.get('kds.station.st-1')?.listeners.keys() ?? [])]).toEqual([
      '.prep-ticket.created',
      '.prep-ticket.updated',
    ]);
  });

  it('goes online on subscription and asks for a full reload', () => {
    const { echo, rt, handlers, states } = setup();
    rt.start('st-1');
    echo.up();
    expect(states).toEqual(['connecting', 'online']);
    expect(handlers.onSubscribed).toHaveBeenCalledTimes(1);
  });

  it('passes ticket events from the envelope and dedupes by eventId', () => {
    const { echo, rt, tickets } = setup();
    rt.start('st-1');
    const created = echo.channels.get('kds.station.st-1')?.listeners.get('.prep-ticket.created');
    const updated = echo.channels.get('kds.station.st-1')?.listeners.get('.prep-ticket.updated');
    created?.(envelope('e1', wireTicket('a')));
    created?.(envelope('e1', wireTicket('a'))); // at-least-once redelivery
    updated?.(envelope('e2', wireTicket('a', 2, 'ACCEPTED')));
    updated?.({ eventId: 'e3', data: { ticket: { nonsense: true } } }); // unparseable: ignored
    expect(tickets).toEqual(['a@1', 'a@2']);
  });

  it('forwards site health and device commands', () => {
    const { echo, rt, handlers } = setup();
    rt.start('st-1', 'dev-9');
    echo.channels.get('site.status')?.listeners.get('.site.health')?.({
      eventId: 'h1',
      data: { status: 'DEGRADED' },
    });
    echo.channels.get('device.dev-9')?.listeners.get('.device.command')?.({
      eventId: 'c1',
      data: { id: 'x', command: 'LOCK', payload: {} },
    });
    expect(handlers.onSiteHealth).toHaveBeenCalledWith('DEGRADED');
    expect(handlers.onDeviceCommand).toHaveBeenCalledWith('LOCK');
  });

  it('reports auth-error when the API refuses the channel', () => {
    const { echo, rt, states } = setup();
    rt.start('st-1');
    echo.channels.get('kds.station.st-1')?.errorCb?.({ status: 403 });
    expect(states.at(-1)).toBe('auth-error');
  });

  it('stop() leaves channels and disconnects; late events are ignored', () => {
    const { echo, rt, tickets } = setup();
    rt.start('st-1');
    const created = echo.channels.get('kds.station.st-1')?.listeners.get('.prep-ticket.created');
    rt.stop();
    created?.(envelope('e9', wireTicket('z')));
    expect(echo.left).toEqual(['kds.station.st-1', 'site.status']);
    expect(echo.disconnects).toBe(1);
    expect(tickets).toEqual([]);
  });
});

describe('KdsRealtime reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports reconnecting, backs off exponentially (1s, 2s, 4s...), and reloads on every resubscribe', () => {
    const { echo, rt, handlers, states } = setup();
    rt.start('st-1');
    echo.up();
    expect(handlers.onSubscribed).toHaveBeenCalledTimes(1);

    echo.stateCb?.('unavailable'); // socket lost
    expect(states.at(-1)).toBe('reconnecting');
    expect(echo.disconnects).toBe(1); // we stop pusher-js's own fixed retry
    vi.advanceTimersByTime(999);
    expect(echo.connects).toBe(0);
    vi.advanceTimersByTime(1);
    expect(echo.connects).toBe(1); // 1st retry after 1 s (random()=1 => full ceiling)

    echo.stateCb?.('unavailable'); // still down
    vi.advanceTimersByTime(1999);
    expect(echo.connects).toBe(1);
    vi.advanceTimersByTime(1);
    expect(echo.connects).toBe(2); // 2nd retry after 2 s

    echo.up(); // back
    expect(states.at(-1)).toBe('online');
    expect(handlers.onSubscribed).toHaveBeenCalledTimes(2); // full reload on reconnect
  });

  it('caps the backoff at 30 s and resets it after a successful connection', () => {
    const { echo, rt } = setup();
    rt.start('st-1');
    echo.up();
    for (let i = 0; i < 8; i++) {
      echo.stateCb?.('unavailable');
      vi.advanceTimersByTime(30_000);
    }
    const before = echo.connects;
    echo.stateCb?.('unavailable');
    vi.advanceTimersByTime(29_999);
    expect(echo.connects).toBe(before);
    vi.advanceTimersByTime(1);
    expect(echo.connects).toBe(before + 1);

    echo.up(); // success resets attempt
    echo.stateCb?.('unavailable');
    vi.advanceTimersByTime(1_000);
    expect(echo.connects).toBe(before + 2);
  });

  it('jitters retries between 50% and 100% of the ceiling', () => {
    const echo = new FakeEcho();
    const rt = new KdsRealtime(
      {
        reverb: { host: 'h', port: 1, scheme: 'http', key: 'k' },
        authUrl: 'a',
        getToken: () => null,
        factory: () => echo,
        random: () => 0,
      },
      { onTicket: vi.fn(), onState: vi.fn(), onSubscribed: vi.fn() },
    );
    rt.start('st-1');
    echo.up();
    echo.stateCb?.('unavailable');
    vi.advanceTimersByTime(499);
    expect(echo.connects).toBe(0);
    vi.advanceTimersByTime(1);
    expect(echo.connects).toBe(1);
  });

  it('forces a reconnect when the socket goes silent (no site.health for 75 s)', () => {
    let clock = 1_000_000;
    const { echo, rt, states } = setup(() => clock);
    rt.start('st-1');
    echo.up();
    echo.channels.get('site.status')?.listeners.get('.site.health')?.({
      eventId: 'h1',
      data: { status: 'ONLINE' },
    });

    clock += STALE_AFTER_MS - 1_000;
    vi.advanceTimersByTime(5_000);
    expect(states.at(-1)).toBe('online');

    clock += 2_000;
    vi.advanceTimersByTime(5_000);
    expect(states.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(1);
    expect(echo.connects).toBe(1);
  });
});
