import { newIdempotencyKey } from './idempotency';
import type { TicketStatus } from '../state/tickets';

/**
 * Thin fetch wrapper for the 007 Resort & Spa API.
 *
 * The API is authoritative: it validates every status transition and records
 * the staff member and timestamps. This client only transports requests.
 * Every mutating request carries an `Idempotency-Key` header.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`API request failed with status ${String(status)}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly idempotencyKey?: () => string;
}

const API_PREFIX = '/api/v1';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly idempotencyKey: () => string;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.idempotencyKey = options.idempotencyKey ?? newIdempotencyKey;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const upper = method.toUpperCase();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (MUTATING_METHODS.has(upper)) headers['Idempotency-Key'] = this.idempotencyKey();

    const init: RequestInit = { method: upper, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    const response = await this.fetchFn(`${this.baseUrl}${API_PREFIX}${path}`, init);
    if (!response.ok) {
      throw new ApiError(response.status, await response.text());
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** GET /api/v1/system/info - connectivity smoke check. */
  getSystemInfo(): Promise<Record<string, unknown>> {
    return this.request('GET', '/system/info');
  }

  /**
   * Requests a ticket status transition. The API decides whether it is
   * allowed. Endpoint path is a placeholder until the contract is published
   * in 007resort-docs.
   */
  requestTransition(ticketId: string, to: TicketStatus): Promise<void> {
    return this.request('POST', `/kds/tickets/${encodeURIComponent(ticketId)}/transitions`, {
      to,
    });
  }
}
