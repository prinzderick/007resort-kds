import { describe, expect, it } from 'vitest';
import { DEFAULT_API_BASE_URL, fetchRuntimeOverrides, parseConfig } from './config';

describe('parseConfig', () => {
  it('uses defaults when nothing is set', () => {
    const c = parseConfig({});
    expect(c.apiBaseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(c.stationCode).toBeNull();
    expect(c.reverb).toEqual({
      host: 'localhost',
      port: 8081,
      scheme: 'http',
      key: 'r007-local-key',
    });
    expect([c.warnAfterSeconds, c.lateAfterSeconds]).toEqual([300, 600]);
    expect(c.idleLockSeconds).toBe(120);
  });

  it('reads and normalises values', () => {
    const c = parseConfig({
      VITE_R007_API_BASE_URL: ' https://kds.example.ng/ ',
      VITE_R007_REVERB_HOST: 'ws.example.ng',
      VITE_R007_REVERB_PORT: '443',
      VITE_R007_REVERB_SCHEME: 'https',
      VITE_R007_REVERB_KEY: 'abc',
      VITE_KDS_STATION_CODE: 'pool_bar',
      VITE_KDS_WARN_MINUTES: '3',
      VITE_KDS_LATE_MINUTES: '8',
      VITE_KDS_IDLE_LOCK_SECONDS: '30',
    });
    expect(c.apiBaseUrl).toBe('https://kds.example.ng');
    expect(c.reverb).toEqual({ host: 'ws.example.ng', port: 443, scheme: 'https', key: 'abc' });
    expect(c.stationCode).toBe('POOL_BAR');
    expect([c.warnAfterSeconds, c.lateAfterSeconds, c.idleLockSeconds]).toEqual([180, 480, 30]);
  });

  it('derives the Reverb host and scheme from the API URL', () => {
    const c = parseConfig({ VITE_R007_API_BASE_URL: 'https://api.example.ng' });
    expect(c.reverb.host).toBe('api.example.ng');
    expect(c.reverb.scheme).toBe('https');
  });

  it('supports same-origin deployment via "origin"', () => {
    const c = parseConfig({ VITE_R007_API_BASE_URL: 'origin' }, 'http://192.168.1.10');
    expect(c.apiBaseUrl).toBe('http://192.168.1.10');
    expect(c.reverb.host).toBe('192.168.1.10');
  });

  it('never lets the late threshold be below the warning threshold', () => {
    const c = parseConfig({ VITE_KDS_WARN_MINUTES: '9', VITE_KDS_LATE_MINUTES: '2' });
    expect(c.lateAfterSeconds).toBe(c.warnAfterSeconds);
  });

  it('treats blank, malformed or invalid values as defaults', () => {
    expect(parseConfig({ VITE_KDS_STATION_CODE: '  ' }).stationCode).toBeNull();
    expect(parseConfig({ VITE_KDS_STATION_CODE: 'main kitchen!' }).stationCode).toBeNull();
    expect(parseConfig({ VITE_R007_REVERB_PORT: 'x' }).reverb.port).toBe(8081);
  });

  it('throws on an invalid API URL', () => {
    expect(() => parseConfig({ VITE_R007_API_BASE_URL: 'not a url' })).toThrow();
  });
});

describe('fetchRuntimeOverrides', () => {
  it('returns only VITE_ keys from config.json', async () => {
    const f = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ VITE_KDS_WARN_MINUTES: 2, other: 'x' })),
      )) as typeof fetch;
    await expect(fetchRuntimeOverrides(f)).resolves.toEqual({ VITE_KDS_WARN_MINUTES: '2' });
  });

  it('returns {} when missing or broken', async () => {
    const missing = (() => Promise.resolve(new Response('', { status: 404 }))) as typeof fetch;
    const broken = (() => Promise.resolve(new Response('not json'))) as typeof fetch;
    const failing = (() => Promise.reject(new Error('net'))) as typeof fetch;
    await expect(fetchRuntimeOverrides(missing)).resolves.toEqual({});
    await expect(fetchRuntimeOverrides(broken)).resolves.toEqual({});
    await expect(fetchRuntimeOverrides(failing)).resolves.toEqual({});
  });
});
