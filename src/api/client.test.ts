import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, NetworkError, type FetchLike } from './client';
import { newIdempotencyKey } from './idempotency';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function mockFetch(status = 200, body: unknown = {}, headers: Record<string, string> = {}) {
  return vi.fn<FetchLike>(() =>
    Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    ),
  );
}

function headersOf(fetchFn: ReturnType<typeof mockFetch>, call = 0): Record<string, string> {
  const init = fetchFn.mock.calls[call]?.[1];
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('ApiClient transitions', () => {
  it('POSTs {to} with Idempotency-Key, If-Match, bearer and device token', async () => {
    const fetchFn = mockFetch(200, {
      id: 't-1',
      number: 'K-1',
      status: 'ACCEPTED',
      createdAt: '2026-09-22T10:00:00Z',
      rowVersion: 2,
      items: [],
    });
    const client = new ApiClient({
      baseUrl: 'http://api.test/',
      fetch: fetchFn,
      getToken: () => 'tok',
      getDeviceToken: () => 'dev',
    });

    const t = await client.transition('t-1', 'ACCEPTED', 'key-1', '"1"');

    expect(t?.status).toBe('ACCEPTED');
    expect(t?.version).toBe(2);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('http://api.test/api/v1/prep-tickets/t-1/transition');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ to: 'ACCEPTED' }));
    const h = headersOf(fetchFn);
    expect(h['Idempotency-Key']).toBe('key-1');
    expect(h['If-Match']).toBe('"1"');
    expect(h.Authorization).toBe('Bearer tok');
    expect(h['X-Device-Token']).toBe('dev');
    expect(h['X-Correlation-Id']).toMatch(UUID_V4);
  });

  it('generates a fresh Idempotency-Key per mutating request when none is given', async () => {
    const fetchFn = mockFetch(200, {});
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: fetchFn });
    await client.request('POST', '/x', { body: {} });
    await client.request('POST', '/x', { body: {} });
    expect(headersOf(fetchFn, 0)['Idempotency-Key']).toMatch(UUID_V4);
    expect(headersOf(fetchFn, 0)['Idempotency-Key']).not.toBe(
      headersOf(fetchFn, 1)['Idempotency-Key'],
    );
  });

  it('does not send an Idempotency-Key on GET', async () => {
    const fetchFn = mockFetch(200, { items: [], nextCursor: null });
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: fetchFn });
    await client.listStations();
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://api.test/api/v1/kds/stations');
    expect(headersOf(fetchFn)['Idempotency-Key']).toBeUndefined();
  });

  it('parses problem+json into ApiError with a stable code', async () => {
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(409, {
        code: 'order_state_invalid',
        title: 'Illegal',
        detail: 'K-1 cannot move',
      }),
    });
    const err = await client.transition('t-1', 'READY', 'k', '"1"').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('order_state_invalid');
    expect((err as ApiError).userMessage).toBe('K-1 cannot move');
  });

  it('wraps transport failures in NetworkError', async () => {
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetch: () => Promise.reject(new TypeError('failed to fetch')),
    });
    await expect(client.listStations()).rejects.toBeInstanceOf(NetworkError);
  });

  it('reads the ETag when fetching a single ticket', async () => {
    const fetchFn = mockFetch(
      200,
      {
        id: 't-1',
        number: 'K-1',
        status: 'NEW',
        createdAt: '2026-09-22T10:00:00Z',
        rowVersion: 3,
        items: [],
      },
      { ETag: '"3"' },
    );
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: fetchFn });
    const { ticket, etag } = await client.getTicket('t-1');
    expect(etag).toBe('"3"');
    expect(ticket.version).toBe(3);
  });
});

describe('ApiClient auth', () => {
  it('sends {credentialType, identifier, secret} anonymously and parses the session', async () => {
    const fetchFn = mockFetch(200, {
      accessToken: 'a',
      refreshToken: 'r',
      expiresInSeconds: 900,
      staff: { id: 's', displayName: 'Ada', permissions: ['prep_ticket.transition'] },
    });
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchFn,
      getToken: () => 'old',
    });
    const s = await client.login({ credentialType: 'PASSWORD', identifier: 'kds', secret: 'pw' });
    expect(s).toMatchObject({
      accessToken: 'a',
      refreshToken: 'r',
      staffName: 'Ada',
      permissions: ['prep_ticket.transition'],
    });
    expect(fetchFn.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ credentialType: 'PASSWORD', identifier: 'kds', secret: 'pw' }),
    );
    expect(headersOf(fetchFn).Authorization).toBeUndefined();
  });

  it('refreshes once on 401 and retries with the SAME Idempotency-Key', async () => {
    let calls = 0;
    const fetchFn = vi.fn<FetchLike>(() => {
      calls++;
      return Promise.resolve(
        calls === 1
          ? new Response(JSON.stringify({ code: 'token_expired' }), { status: 401 })
          : new Response(
              JSON.stringify({
                id: 't',
                number: 'K',
                status: 'READY',
                createdAt: '2026-09-22T10:00:00Z',
                rowVersion: 5,
                items: [],
              }),
              { status: 200 },
            ),
      );
    });
    let token = 'old';
    const onUnauthorized = vi.fn(() => {
      token = 'new';
      return Promise.resolve(true);
    });
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetch: fetchFn,
      getToken: () => token,
      onUnauthorized,
    });

    await client.transition('t', 'READY', 'idem-9', '"4"');

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(headersOf(fetchFn, 0).Authorization).toBe('Bearer old');
    expect(headersOf(fetchFn, 1).Authorization).toBe('Bearer new');
    expect(headersOf(fetchFn, 1)['Idempotency-Key']).toBe('idem-9');
  });

  it('gives up (and throws) when the refresh fails', async () => {
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(401, { code: 'unauthenticated' }),
      getToken: () => 't',
      onUnauthorized: () => false,
    });
    await expect(client.listStations()).rejects.toMatchObject({ status: 401 });
  });

  it('reports a revoked device', async () => {
    const onDeviceRejected = vi.fn();
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetch: mockFetch(403, { code: 'device_revoked' }),
      onDeviceRejected,
    });
    await expect(client.listStations()).rejects.toBeInstanceOf(ApiError);
    expect(onDeviceRejected).toHaveBeenCalledOnce();
  });
});

describe('ApiClient lists', () => {
  it('follows cursors to load the whole board', async () => {
    const page = (id: string, next: string | null) => ({
      items: [
        {
          id,
          number: id,
          status: 'NEW',
          createdAt: '2026-09-22T10:00:00Z',
          rowVersion: 1,
          items: [],
        },
      ],
      nextCursor: next,
    });
    const fetchFn = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(new Response(JSON.stringify(page('a', 'c2'))))
      .mockResolvedValueOnce(new Response(JSON.stringify(page('b', null))));
    const client = new ApiClient({ baseUrl: 'http://api.test', fetch: fetchFn });
    const tickets = await client.listTickets('st 1');
    expect(tickets.map((t) => t.id)).toEqual(['a', 'b']);
    expect(fetchFn.mock.calls[0]?.[0]).toBe('http://api.test/api/v1/kds/stations/st%201/tickets');
    expect(fetchFn.mock.calls[1]?.[0]).toContain('?cursor=c2');
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
