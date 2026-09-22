import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, type FetchLike } from './client';
import { newIdempotencyKey } from './idempotency';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function mockFetch(status = 200, body: unknown = {}) {
  return vi.fn<FetchLike>(() =>
    Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

function headersOf(fetchFn: ReturnType<typeof mockFetch>, call = 0): Record<string, string> {
  const init = fetchFn.mock.calls[call]?.[1];
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('ApiClient', () => {
  it('sends an Idempotency-Key (UUID) on mutating requests', async () => {
    const fetchFn = mockFetch(204);
    const client = new ApiClient({ baseUrl: 'http://api.test/', fetch: fetchFn });

    await client.requestTransition('t-1', 'ACCEPTED');

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/api/v1/kds/tickets/t-1/transitions');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ to: 'ACCEPTED' }));
    expect(headersOf(fetchFn)['Idempotency-Key']).toMatch(UUID_V4);
  });

  it('uses a fresh key per request', async () => {
    const fetchFn = mockFetch(204);
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: fetchFn });
    await client.requestTransition('t-1', 'ACCEPTED');
    await client.requestTransition('t-1', 'IN_PROGRESS');
    expect(headersOf(fetchFn, 0)['Idempotency-Key']).not.toBe(
      headersOf(fetchFn, 1)['Idempotency-Key'],
    );
  });

  it('does not send an Idempotency-Key on GET', async () => {
    const fetchFn = mockFetch(200, { name: '007 Resort & Spa API' });
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: fetchFn });

    await expect(client.getSystemInfo()).resolves.toEqual({ name: '007 Resort & Spa API' });
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://api.test/api/v1/system/info');
    expect(headersOf(fetchFn)['Idempotency-Key']).toBeUndefined();
  });

  it('throws ApiError on non-2xx', async () => {
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: mockFetch(409, 'no') });
    await expect(client.requestTransition('t-1', 'READY')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('newIdempotencyKey', () => {
  it('produces a UUID v4', () => {
    expect(newIdempotencyKey()).toMatch(UUID_V4);
  });

  it('falls back to getRandomValues when randomUUID is unavailable (insecure context)', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    try {
      expect(newIdempotencyKey()).toMatch(UUID_V4);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
