import { vi } from 'vitest';
import { ApiError, NetworkError } from '../api/client';
import type { KdsApi, RealtimeControl, AppDeps } from '../app';
import type { StaffSession } from '../api/dto';
import type { KdsConfig } from '../config';
import { DeviceStorage } from '../device/storage';
import type { RealtimeHandlers } from '../realtime/kds-realtime';
import type { Ticket } from '../state/tickets';

export const STATION = { id: 'st-1', code: 'MAIN_KITCHEN', name: 'Main Kitchen' } as const;

export function ticket(o: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket {
  return {
    number: `K-${o.id}`,
    stationCode: '',
    status: 'NEW',
    createdAtUtc: '2026-09-22T10:00:00Z',
    version: 1,
    items: [{ name: 'Jollof rice', quantity: 1 }],
    ...o,
  };
}

export function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => {
      m.clear();
    },
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}

export const TEST_CONFIG: KdsConfig = {
  apiBaseUrl: 'http://api.test',
  reverb: { host: 'api.test', port: 8080, scheme: 'http', key: 'k' },
  reverbExplicit: true,
  stationCode: null,
  warnAfterSeconds: 300,
  lateAfterSeconds: 600,
  idleLockSeconds: 60,
  resyncIntervalSeconds: 0,
};

export function session(o: Partial<StaffSession> = {}): StaffSession {
  return {
    accessToken: 'tok-1',
    refreshToken: 'ref-1',
    expiresInSeconds: 900,
    staffName: 'Chef Ada',
    staffId: 's1',
    permissions: ['prep_ticket.view', 'prep_ticket.transition'],
    ...o,
  };
}

export class FakeRealtime implements RealtimeControl {
  handlers!: RealtimeHandlers;
  start = vi.fn<(stationId: string, deviceId?: string) => void>();
  stop = vi.fn<() => void>();
}

export function fakeApi(): { [K in keyof KdsApi]: ReturnType<typeof vi.fn<KdsApi[K]>> } {
  return {
    registerDevice: vi.fn<KdsApi['registerDevice']>(() =>
      Promise.resolve({ deviceId: 'dev-1', deviceToken: 'dt-1' }),
    ),
    login: vi.fn<KdsApi['login']>(() => Promise.resolve(session())),
    refresh: vi.fn<KdsApi['refresh']>(() =>
      Promise.resolve(session({ accessToken: 'tok-2', refreshToken: 'ref-2' })),
    ),
    logout: vi.fn<KdsApi['logout']>(() => Promise.resolve()),
    getSystemInfo: vi.fn<KdsApi['getSystemInfo']>(() =>
      Promise.resolve({ serverTimeMs: null, realtime: null, minKdsVersion: null }),
    ),
    listStations: vi.fn<KdsApi['listStations']>(() => Promise.resolve([{ ...STATION }])),
    listTickets: vi.fn<KdsApi['listTickets']>(() => Promise.resolve([])),
    getTicket: vi.fn<KdsApi['getTicket']>((id) =>
      Promise.resolve({ ticket: ticket({ id }), etag: '"1"' }),
    ),
    transition: vi.fn<KdsApi['transition']>(() => Promise.resolve(null)),
  };
}

export const problem = (status: number, code: string, detail?: string): ApiError =>
  new ApiError(status, JSON.stringify({ status, code, title: code, detail }));
export const networkDown = (): NetworkError => new NetworkError(new Error('down'));

export interface Harness {
  api: ReturnType<typeof fakeApi>;
  rt: FakeRealtime;
  chime: { play: ReturnType<typeof vi.fn> };
  storage: DeviceStorage;
  deps: AppDeps;
  hooks: { current: Parameters<AppDeps['makeApi']>[0] | null };
}

export function harness(
  over: Partial<KdsConfig> = {},
  prefill?: (s: DeviceStorage) => void,
): Harness {
  const api = fakeApi();
  const rt = new FakeRealtime();
  const chime = { play: vi.fn() };
  const storage = new DeviceStorage(memoryStorage());
  storage.setDevice({ id: 'dev-1', token: 'dt-1' });
  prefill?.(storage);
  const hooks: Harness['hooks'] = { current: null };
  const deps: AppDeps = {
    config: { ...TEST_CONFIG, ...over },
    storage,
    chime,
    makeApi: (h) => {
      hooks.current = h;
      return api;
    },
    makeRealtime: (_h, handlers) => {
      rt.handlers = handlers;
      return rt;
    },
    now: () => Date.now(),
    appVersion: 'test',
  };
  return { api, rt, chime, storage, deps, hooks };
}
