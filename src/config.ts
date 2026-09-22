/**
 * Kiosk configuration, read from Vite env variables at build time.
 *
 * - VITE_OTUEKE_API_BASE_URL: base URL of the Otueke API (no `/api/v1`).
 * - VITE_KDS_STATION_CODE: which KDS station this screen is, e.g. MAIN_KITCHEN.
 *
 * These values are compiled into the bundle and are NOT secret.
 */

/** Stations planned for Phase 1. The API's station registry is authoritative. */
export const KNOWN_STATIONS = [
  'MAIN_KITCHEN',
  'RESTAURANT_COUNTER',
  'POOL_BAR',
  'BUSH_BAR',
] as const;

export const DEFAULT_API_BASE_URL = 'http://localhost:5080';

export interface KdsConfig {
  /** API base URL without trailing slash. */
  readonly apiBaseUrl: string;
  /** Station code, or null when this kiosk has not been configured. */
  readonly stationCode: string | null;
}

export interface KdsEnv {
  readonly VITE_OTUEKE_API_BASE_URL?: string | undefined;
  readonly VITE_KDS_STATION_CODE?: string | undefined;
}

const STATION_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

export function parseConfig(env: KdsEnv): KdsConfig {
  const rawUrl = env.VITE_OTUEKE_API_BASE_URL?.trim();
  const apiBaseUrl = (
    rawUrl !== undefined && rawUrl !== '' ? rawUrl : DEFAULT_API_BASE_URL
  ).replace(/\/+$/, '');
  // Throws on a malformed URL so a misconfigured kiosk fails loudly at start-up.
  new URL(apiBaseUrl);

  const rawStation = env.VITE_KDS_STATION_CODE?.trim().toUpperCase() ?? '';
  const stationCode = STATION_CODE_PATTERN.test(rawStation) ? rawStation : null;

  return { apiBaseUrl, stationCode };
}

export function loadConfig(): KdsConfig {
  return parseConfig(import.meta.env);
}
