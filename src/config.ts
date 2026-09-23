/**
 * Kiosk configuration.
 *
 * Sources (later wins): Vite build-time env (`VITE_*`) -> optional runtime
 * `config.json` served next to `index.html` (same keys). The runtime file lets
 * one static bundle be deployed unchanged to the Local and Cloud nodes.
 *
 * None of these values are secret - they are visible to anyone who can load the page.
 */

import type { RealtimeInfo } from './api/dto';

export const DEFAULT_API_BASE_URL = 'http://localhost:5080';
export const DEFAULT_REVERB_PORT = 8081;

export interface ReverbConfig {
  readonly host: string;
  readonly port: number;
  readonly scheme: 'http' | 'https';
  /** Reverb app key (public identifier, not the app secret). */
  readonly key: string;
}

export interface KdsConfig {
  /** API base URL without trailing slash and without `/api/v1`. */
  readonly apiBaseUrl: string;
  readonly reverb: ReverbConfig;
  /** True when any VITE_R007_REVERB_* value was set explicitly (else `/system/info` may supply it). */
  readonly reverbExplicit: boolean;
  /** Pre-set station code (optional). The per-device choice made on the setup screen wins. */
  readonly stationCode: string | null;
  /** Default elapsed-time thresholds in seconds (overridable per device / per station). */
  readonly warnAfterSeconds: number;
  readonly lateAfterSeconds: number;
  /** Idle time after which staff are signed out of actions (board stays visible). 0 = never. */
  readonly idleLockSeconds: number;
  /** Safety-net full reload while connected, in seconds. 0 = disabled. */
  readonly resyncIntervalSeconds: number;
}

/** Keys that may appear in the environment or in `config.json`. */
export interface KdsEnv {
  readonly VITE_R007_API_BASE_URL?: string | undefined;
  readonly VITE_R007_REVERB_HOST?: string | undefined;
  readonly VITE_R007_REVERB_PORT?: string | undefined;
  readonly VITE_R007_REVERB_SCHEME?: string | undefined;
  readonly VITE_R007_REVERB_KEY?: string | undefined;
  readonly VITE_KDS_STATION_CODE?: string | undefined;
  readonly VITE_KDS_WARN_MINUTES?: string | undefined;
  readonly VITE_KDS_LATE_MINUTES?: string | undefined;
  readonly VITE_KDS_IDLE_LOCK_SECONDS?: string | undefined;
  readonly VITE_KDS_RESYNC_SECONDS?: string | undefined;
}

const STATION_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

function blank(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v === undefined || v === '' ? undefined : v;
}

function num(value: string | undefined, fallback: number, min = 0): number {
  const v = blank(value);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * @param origin the page origin, used when the API URL is empty or the literal
 *   `origin` (same-origin deployment: the API/Reverb proxy sits behind the same web server).
 */
export function parseConfig(env: KdsEnv, origin = 'http://localhost'): KdsConfig {
  const rawUrl = blank(env.VITE_R007_API_BASE_URL);
  const base = rawUrl === undefined ? DEFAULT_API_BASE_URL : rawUrl === 'origin' ? origin : rawUrl;
  const apiBaseUrl = base.replace(/\/+$/, '');
  // Throws on a malformed URL so a misconfigured kiosk fails loudly at start-up.
  const api = new URL(apiBaseUrl);

  const scheme = blank(env.VITE_R007_REVERB_SCHEME)?.toLowerCase() === 'https' ? 'https' : 'http';
  const schemeGiven = blank(env.VITE_R007_REVERB_SCHEME) !== undefined;
  const reverb: ReverbConfig = {
    host: blank(env.VITE_R007_REVERB_HOST) ?? api.hostname,
    port: Math.trunc(num(env.VITE_R007_REVERB_PORT, DEFAULT_REVERB_PORT, 1)),
    scheme: schemeGiven ? scheme : api.protocol === 'https:' ? 'https' : 'http',
    key: blank(env.VITE_R007_REVERB_KEY) ?? 'r007-local-key',
  };

  const rawStation = env.VITE_KDS_STATION_CODE?.trim().toUpperCase() ?? '';
  const warn = num(env.VITE_KDS_WARN_MINUTES, 5, 0) * 60;
  const late = num(env.VITE_KDS_LATE_MINUTES, 10, 0) * 60;

  return {
    apiBaseUrl,
    reverb,
    reverbExplicit: [
      env.VITE_R007_REVERB_HOST,
      env.VITE_R007_REVERB_PORT,
      env.VITE_R007_REVERB_SCHEME,
      env.VITE_R007_REVERB_KEY,
    ].some((v) => blank(v) !== undefined),
    stationCode: STATION_CODE_PATTERN.test(rawStation) ? rawStation : null,
    warnAfterSeconds: warn,
    lateAfterSeconds: Math.max(late, warn),
    idleLockSeconds: num(env.VITE_KDS_IDLE_LOCK_SECONDS, 120, 0),
    resyncIntervalSeconds: num(env.VITE_KDS_RESYNC_SECONDS, 300, 0),
  };
}

/**
 * Uses the node's advertised Reverb settings (`GET /system/info` -> `realtime`) unless the
 * kiosk was configured explicitly.
 */
export function withAdvertisedRealtime(config: KdsConfig, info: RealtimeInfo | null): KdsConfig {
  if (config.reverbExplicit || info === null) return config;
  return {
    ...config,
    reverb: {
      host: info.host,
      port: info.port,
      scheme: info.scheme === 'wss' ? 'https' : 'http',
      key: info.appKey,
    },
  };
}

/** Best-effort fetch of the optional runtime `config.json` (relative to the page). */
export async function fetchRuntimeOverrides(
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
  url = 'config.json',
): Promise<KdsEnv> {
  try {
    const response = await fetchFn(url, { cache: 'no-store' });
    if (!response.ok) return {};
    const json: unknown = await response.json();
    if (typeof json !== 'object' || json === null) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(json)) {
      if (k.startsWith('VITE_') && (typeof v === 'string' || typeof v === 'number')) {
        out[k] = String(v);
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadConfig(): Promise<KdsConfig> {
  const overrides = await fetchRuntimeOverrides();
  return parseConfig({ ...import.meta.env, ...overrides }, window.location.origin);
}
