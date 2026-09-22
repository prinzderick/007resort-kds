import { describe, expect, it } from 'vitest';
import { DEFAULT_API_BASE_URL, parseConfig } from './config';

describe('parseConfig', () => {
  it('uses defaults when nothing is set', () => {
    expect(parseConfig({})).toEqual({ apiBaseUrl: DEFAULT_API_BASE_URL, stationCode: null });
  });

  it('reads and normalises values', () => {
    expect(
      parseConfig({
        VITE_OTUEKE_API_BASE_URL: ' http://192.168.10.5:5080/ ',
        VITE_KDS_STATION_CODE: 'pool_bar',
      }),
    ).toEqual({ apiBaseUrl: 'http://192.168.10.5:5080', stationCode: 'POOL_BAR' });
  });

  it('treats blank or malformed station codes as not configured', () => {
    expect(parseConfig({ VITE_KDS_STATION_CODE: '  ' }).stationCode).toBeNull();
    expect(parseConfig({ VITE_KDS_STATION_CODE: 'main kitchen!' }).stationCode).toBeNull();
  });

  it('throws on an invalid API URL', () => {
    expect(() => parseConfig({ VITE_OTUEKE_API_BASE_URL: 'not a url' })).toThrow();
  });
});
