import { newIdempotencyKey } from '../api/idempotency';
import type { Station } from '../api/dto';
import type { Ticket } from '../state/tickets';

/**
 * Per-device settings kept in localStorage (station choice, sound, thresholds, last-known board).
 * Storage can be unavailable or full (private mode, kiosk policies): every access is guarded and
 * the app works without it. Nothing secret is stored - the access token lives in memory only.
 */

const PREFIX = 'r007.kds.';

export interface DeviceSettings {
  readonly muted: boolean;
  /** Per-device threshold overrides in seconds; null = use station/config defaults. */
  readonly warnAfterSeconds: number | null;
  readonly lateAfterSeconds: number | null;
}

export const DEFAULT_SETTINGS: DeviceSettings = {
  muted: false,
  warnAfterSeconds: null,
  lateAfterSeconds: null,
};

export interface BoardCache {
  readonly stationId: string;
  readonly savedAtMs: number;
  readonly tickets: readonly Ticket[];
}

export class DeviceStorage {
  private readonly store: Storage | null;

  constructor(store: Storage | null = safeLocalStorage()) {
    this.store = store;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller-asserted JSON shape
  private get<T>(key: string): T | null {
    try {
      const raw = this.store?.getItem(PREFIX + key);
      return raw === null || raw === undefined ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  }

  private set(key: string, value: unknown): void {
    try {
      this.store?.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* storage full / unavailable: degrade silently */
    }
  }

  private remove(key: string): void {
    try {
      this.store?.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  }

  /** Stable random id for this browser profile (sent with login so the API can attribute the device). */
  deviceId(): string {
    const existing = this.get<string>('deviceId');
    if (typeof existing === 'string' && existing !== '') return existing;
    const id = newIdempotencyKey();
    this.set('deviceId', id);
    return id;
  }

  /** Device enrolment (`POST /devices/register`). The token is a long-lived secret for this kiosk. */
  device(): { id: string; token: string } | null {
    const d = this.get<{ id?: unknown; token?: unknown }>('device');
    return typeof d?.id === 'string' && typeof d.token === 'string'
      ? { id: d.id, token: d.token }
      : null;
  }
  setDevice(device: { id: string; token: string } | null): void {
    if (device === null) this.remove('device');
    else this.set('device', device);
  }

  station(): Station | null {
    const s = this.get<Station>('station');
    return s !== null && typeof s.id === 'string' && typeof s.name === 'string' ? s : null;
  }
  setStation(station: Station | null): void {
    if (station === null) this.remove('station');
    else this.set('station', station);
  }

  settings(): DeviceSettings {
    return { ...DEFAULT_SETTINGS, ...(this.get<Partial<DeviceSettings>>('settings') ?? {}) };
  }
  saveSettings(settings: DeviceSettings): void {
    this.set('settings', settings);
  }

  boardCache(stationId: string): BoardCache | null {
    const c = this.get<BoardCache>('board');
    return c !== null && c.stationId === stationId && Array.isArray(c.tickets) ? c : null;
  }
  saveBoardCache(cache: BoardCache): void {
    this.set('board', cache);
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
