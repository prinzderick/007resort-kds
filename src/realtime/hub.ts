import {
  HubConnectionBuilder,
  LogLevel,
  type HubConnection,
  type IRetryPolicy,
  type RetryContext,
} from '@microsoft/signalr';

/** Placeholder hub path; final path is defined by the API contract. */
export const KDS_HUB_PATH = '/hubs/kds';

const RETRY_DELAYS_MS = [0, 2_000, 5_000, 10_000, 30_000];

/**
 * Kiosks must never give up reconnecting: retry forever, backing off to a
 * 30 s ceiling. After every reconnect the board should re-fetch a snapshot
 * from the API, because events may have been missed while offline.
 */
export const kioskRetryPolicy: IRetryPolicy = {
  nextRetryDelayInMilliseconds(ctx: RetryContext): number {
    const index = Math.min(ctx.previousRetryCount, RETRY_DELAYS_MS.length - 1);
    return RETRY_DELAYS_MS[index] ?? 30_000;
  },
};

export interface KdsHubOptions {
  readonly apiBaseUrl: string;
  readonly stationCode: string;
  /** Supplies a bearer token once kiosk authentication is designed. */
  readonly accessTokenFactory?: () => string | Promise<string>;
}

/** Creates (but does not start) the SignalR connection for a KDS station. */
export function createKdsHubConnection(options: KdsHubOptions): HubConnection {
  const url = `${options.apiBaseUrl.replace(/\/+$/, '')}${KDS_HUB_PATH}?station=${encodeURIComponent(options.stationCode)}`;
  const builder = new HubConnectionBuilder()
    .withUrl(
      url,
      options.accessTokenFactory ? { accessTokenFactory: options.accessTokenFactory } : {},
    )
    .withAutomaticReconnect(kioskRetryPolicy)
    .configureLogging(import.meta.env.DEV ? LogLevel.Information : LogLevel.Warning);
  return builder.build();
}
