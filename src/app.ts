import {
  ApiError,
  NetworkError,
  type LoginRequest,
  type RegisterDeviceRequest,
} from './api/client';
import type { DeviceRegistration, Station, StaffSession, SystemInfo } from './api/dto';
import { newIdempotencyKey } from './api/idempotency';
import type { KdsConfig } from './config';
import { DEFAULT_SETTINGS, type DeviceSettings, type DeviceStorage } from './device/storage';
import { IdleTimer } from './auth/idle';
import type {
  ConnectionState,
  DeviceCommandName,
  RealtimeHandlers,
  SiteStatus,
} from './realtime/kds-realtime';
import { normaliseThresholds, type Thresholds } from './state/elapsed';
import { applyEvent, emptyBoard, type BoardState, type Ticket } from './state/tickets';
import { nextAction, type TransitionTarget } from './state/transitions';

/**
 * Application controller: the single place that combines device enrolment, staff sessions, REST,
 * realtime and the display store. The UI renders `AppState` and calls the public methods; nothing
 * here decides business rules - transitions are requested from the API, which is authoritative.
 */

/** The API operations the KDS needs (implemented by `ApiClient`, faked in tests). */
export interface KdsApi {
  registerDevice(req: RegisterDeviceRequest): Promise<DeviceRegistration>;
  login(req: LoginRequest): Promise<StaffSession>;
  refresh(refreshToken: string): Promise<StaffSession>;
  logout(bearer?: string): Promise<void>;
  getSystemInfo(): Promise<SystemInfo>;
  listStations(): Promise<Station[]>;
  listTickets(stationId: string): Promise<Ticket[]>;
  getTicket(ticketId: string): Promise<{ ticket: Ticket; etag: string | null }>;
  transition(
    ticketId: string,
    to: TransitionTarget,
    key: string,
    etag: string,
  ): Promise<Ticket | null>;
}

export interface RealtimeControl {
  start(stationId: string, deviceId?: string): void;
  stop(): void;
}

export interface Chime {
  play(): void;
}

export interface ApiHooks {
  getToken: () => string | null;
  getDeviceToken: () => string | null;
  onUnauthorized: () => Promise<boolean>;
  onDeviceRejected: () => void;
}

export interface AppDeps {
  readonly config: KdsConfig;
  readonly storage: DeviceStorage;
  readonly makeApi: (hooks: ApiHooks) => KdsApi;
  readonly makeRealtime: (
    hooks: Pick<ApiHooks, 'getToken' | 'getDeviceToken'>,
    handlers: RealtimeHandlers,
  ) => RealtimeControl;
  readonly chime: Chime;
  readonly now?: () => number;
  /** Fixed for tests; production uses the browser install id. */
  readonly appVersion?: string;
}

export type AuthStatus =
  /** No session: full-screen sign-in, board (if any) is inert. */
  | 'signed-out'
  /** Idle-locked: board stays visible read-only; actions need a fresh sign-in. */
  | 'locked'
  | 'active';

export interface PendingTransition {
  readonly to: TransitionTarget;
}

export interface Toast {
  readonly id: number;
  readonly text: string;
}

export interface AppState {
  readonly booted: boolean;
  /** Enrolled device (`X-Device-Token`); null until the registration code is accepted. */
  readonly device: { readonly id: string } | null;
  readonly registrationBusy: boolean;
  readonly registrationError: string | null;
  readonly auth: AuthStatus;
  readonly staffName: string | null;
  /** Permission strings from login; null when the API did not send any. */
  readonly permissions: readonly string[] | null;
  /** Login sheet is shown while locked (always shown when signed out). */
  readonly loginOpen: boolean;
  readonly loginBusy: boolean;
  readonly loginError: string | null;
  readonly stations: readonly Station[] | null;
  readonly stationsError: string | null;
  readonly station: Station | null;
  readonly board: BoardState;
  readonly pending: ReadonlyMap<string, PendingTransition>;
  readonly connection: ConnectionState;
  readonly siteStatus: SiteStatus | null;
  /** True once the current subscription has been followed by a successful full reload. */
  readonly synced: boolean;
  readonly reloadFailed: boolean;
  readonly lastSyncMs: number | null;
  /** serverNow - localNow, from `GET /system/info` (0 if unknown). */
  readonly clockOffsetMs: number;
  readonly toasts: readonly Toast[];
  readonly settings: DeviceSettings;
  readonly menuOpen: boolean;
}

const TOAST_MS = 8_000;
const RELOAD_RETRY_MS = [2_000, 5_000, 10_000, 30_000];
/** While the socket is down the board is refreshed over REST at this interval (contract). */
export const POLL_MS = 10_000;
const REFRESH_AT = 0.8; // refresh the access token at 80% of its lifetime
const REFRESH_RETRY_MS = 15_000;
const PERM_TRANSITION = 'prep_ticket.transition';

export class KdsApp {
  private state: AppState;
  private readonly listeners = new Set<(s: AppState) => void>();
  private readonly api: KdsApi;
  private readonly realtime: RealtimeControl;
  private readonly idle: IdleTimer;
  private readonly now: () => number;
  private readonly deps: AppDeps;

  /** In-memory only; never persisted. Retained while idle-locked so the board keeps updating. */
  private token: string | null = null;
  private refreshToken: string | null = null;
  private deviceToken: string | null = null;
  private refreshInFlight: Promise<boolean> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /** Idempotency keys per (ticket, target, version): a retry replays instead of double-applying. */
  private readonly keys = new Map<string, string>();
  private toastSeq = 0;
  private reloadSeq = 0;
  private reloadInFlight = false;
  private retryAttempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Realtime tickets received while a reload is in flight; replayed over the snapshot. */
  private duringReload = new Map<string, Ticket>();
  private boardLoadedOnce = false;
  private realtimeRunning = false;

  constructor(deps: AppDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    const device = deps.storage.device();
    this.deviceToken = device?.token ?? null;
    this.state = {
      booted: false,
      device: device === null ? null : { id: device.id },
      registrationBusy: false,
      registrationError: null,
      auth: 'signed-out',
      staffName: null,
      permissions: null,
      loginOpen: true,
      loginBusy: false,
      loginError: null,
      stations: null,
      stationsError: null,
      station: null,
      board: emptyBoard,
      pending: new Map(),
      connection: 'connecting',
      siteStatus: null,
      synced: false,
      reloadFailed: false,
      lastSyncMs: null,
      clockOffsetMs: 0,
      toasts: [],
      settings: deps.storage.settings(),
      menuOpen: false,
    };
    const tokens = { getToken: () => this.token, getDeviceToken: () => this.deviceToken };
    this.api = deps.makeApi({
      ...tokens,
      onUnauthorized: async () => {
        // Expired access token: rotate once; anything else ends the session.
        if (await this.refreshSession()) return true;
        this.handleUnauthorized();
        return false;
      },
      onDeviceRejected: () => {
        this.handleDeviceRevoked();
      },
    });
    this.realtime = deps.makeRealtime(tokens, {
      onTicket: (t) => {
        this.handleTicket(t);
      },
      onState: (c) => {
        this.handleConnection(c);
      },
      onSubscribed: () => {
        void this.reload();
      },
      onSiteHealth: (siteStatus) => {
        if (siteStatus !== this.state.siteStatus) this.set({ siteStatus });
      },
      onDeviceCommand: (c) => {
        this.handleDeviceCommand(c);
      },
    });
    this.idle = new IdleTimer(deps.config.idleLockSeconds * 1000, () => {
      this.lock();
    });
  }

  // ---- observation -------------------------------------------------------------------------

  getState(): AppState {
    return this.state;
  }

  subscribe(fn: (s: AppState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  nowMs(): number {
    return this.now();
  }

  /** Effective ageing thresholds: device override > station value > build config. */
  thresholds(): Thresholds {
    const { settings, station } = this.state;
    const c = this.deps.config;
    return normaliseThresholds({
      warnAfterSeconds:
        settings.warnAfterSeconds ?? station?.warnAfterSeconds ?? c.warnAfterSeconds,
      lateAfterSeconds:
        settings.lateAfterSeconds ?? station?.lateAfterSeconds ?? c.lateAfterSeconds,
    });
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of [...this.listeners]) fn(this.state);
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  /** Restores the remembered station and cached board; the user must still sign in. */
  boot(): void {
    const station = this.deps.storage.station();
    const cache = station === null ? null : this.deps.storage.boardCache(station.id);
    this.set({
      booted: true,
      station,
      board:
        cache === null
          ? emptyBoard
          : applyEvent(emptyBoard, { type: 'snapshot', tickets: cache.tickets }),
      lastSyncMs: cache?.savedAtMs ?? null,
    });
  }

  // ---- device enrolment --------------------------------------------------------------------

  /** One-time enrolment with the code from the admin UI. */
  async registerDevice(name: string, registrationCode: string): Promise<boolean> {
    if (this.state.registrationBusy) return false;
    this.set({ registrationBusy: true, registrationError: null });
    try {
      const reg = await this.api.registerDevice({
        name,
        registrationCode,
        hardwareId: this.deps.storage.deviceId(),
        appVersion: this.deps.appVersion ?? 'web',
      });
      this.deviceToken = reg.deviceToken;
      this.deps.storage.setDevice({ id: reg.deviceId, token: reg.deviceToken });
      this.set({ device: { id: reg.deviceId }, registrationBusy: false });
      return true;
    } catch (e) {
      this.set({ registrationBusy: false, registrationError: describeRegistrationError(e) });
      return false;
    }
  }

  private handleDeviceRevoked(): void {
    this.forgetSession();
    this.deviceToken = null;
    this.deps.storage.setDevice(null);
    this.set({
      device: null,
      registrationError: 'This screen is no longer registered. Enter a new registration code.',
    });
  }

  private handleDeviceCommand(command: DeviceCommandName): void {
    switch (command) {
      case 'FORCE_LOGOUT':
        this.signOut();
        break;
      case 'LOCK':
        this.lock();
        break;
      case 'REFRESH_STATE':
        void this.reload();
        break;
      case 'REVOKE':
        this.handleDeviceRevoked();
        break;
    }
  }

  // ---- authentication ----------------------------------------------------------------------

  async login(req: LoginRequest): Promise<boolean> {
    if (this.state.loginBusy) return false;
    this.set({ loginBusy: true, loginError: null });
    try {
      const previousToken = this.token;
      const session = await this.api.login(req);
      // Whoever was signed in before (idle-locked) is logged out server-side.
      if (previousToken !== null) void this.api.logout(previousToken).catch(() => undefined);
      this.applySession(session);
      this.set({ auth: 'active', loginOpen: false, loginBusy: false, loginError: null });
      this.idle.touch();
      this.afterSignIn();
      return true;
    } catch (e) {
      this.set({ loginBusy: false, loginError: describeLoginError(e) });
      return false;
    }
  }

  private applySession(session: StaffSession): void {
    this.token = session.accessToken;
    this.refreshToken = session.refreshToken;
    this.set({ staffName: session.staffName, permissions: session.permissions });
    this.scheduleRefresh(session.expiresInSeconds);
  }

  private scheduleRefresh(expiresInSeconds: number): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    if (this.refreshToken === null) return;
    const ms = Math.max(5_000, expiresInSeconds * 1000 * REFRESH_AT);
    this.refreshTimer = setTimeout(() => {
      void this.refreshSession();
    }, ms);
  }

  /**
   * Rotates the token pair (single-flight: refresh tokens are single-use). True on success.
   * A network failure keeps the session and retries shortly; a rejection ends it.
   */
  refreshSession(): Promise<boolean> {
    if (this.refreshInFlight !== null) return this.refreshInFlight;
    const rt = this.refreshToken;
    if (rt === null) return Promise.resolve(false);
    const run = async (): Promise<boolean> => {
      try {
        const session = await this.api.refresh(rt);
        this.token = session.accessToken;
        this.refreshToken = session.refreshToken;
        this.scheduleRefresh(session.expiresInSeconds);
        return true;
      } catch (e) {
        if (e instanceof NetworkError || (e instanceof ApiError && e.status >= 500)) {
          if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
          this.refreshTimer = setTimeout(() => {
            void this.refreshSession();
          }, REFRESH_RETRY_MS);
          return this.token !== null; // token may still be valid for a while
        }
        return false;
      }
    };
    this.refreshInFlight = run().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private afterSignIn(): void {
    const { station } = this.state;
    if (station === null) {
      void this.loadStations();
    } else if (!this.realtimeRunning) {
      this.startBoard(station);
    }
  }

  /** Idle-lock: hide identity, keep the board updating read-only. */
  lock(): void {
    if (this.state.auth !== 'active') return;
    this.idle.stop();
    this.set({
      auth: 'locked',
      staffName: null,
      loginOpen: false,
      menuOpen: false,
      loginError: null,
    });
  }

  signOut(): void {
    const token = this.token;
    if (token !== null) void this.api.logout(token).catch(() => undefined);
    this.forgetSession();
    this.set({ loginOpen: true, loginError: null });
  }

  /** Drops credentials and live connections (board stays visible but inert). */
  private forgetSession(): void {
    this.idle.stop();
    this.token = null;
    this.refreshToken = null;
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.stopRealtime();
    this.stopTimers();
    this.set({
      auth: 'signed-out',
      staffName: null,
      permissions: null,
      menuOpen: false,
      connection: 'connecting',
      synced: false,
      pending: new Map(),
    });
  }

  private handleUnauthorized(): void {
    if (this.state.auth === 'signed-out') return;
    this.forgetSession();
    this.set({ loginOpen: true, loginError: 'Session expired. Sign in again.' });
  }

  openLogin(): void {
    if (this.state.auth === 'active') return;
    this.set({ loginOpen: true, loginError: null });
  }

  closeLogin(): void {
    if (this.state.auth === 'locked') this.set({ loginOpen: false, loginError: null });
  }

  /** Any user interaction; keeps an active session from idling out. */
  activity(): void {
    if (this.state.auth === 'active') this.idle.touch();
  }

  // ---- stations ----------------------------------------------------------------------------

  async loadStations(): Promise<void> {
    this.set({ stationsError: null });
    try {
      const stations = await this.api.listStations();
      this.set({ stations });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      this.set({ stationsError: 'Could not load stations.' });
    }
  }

  chooseStation(station: Station): void {
    if (this.state.auth !== 'active') return;
    this.deps.storage.setStation(station);
    const cache = this.deps.storage.boardCache(station.id);
    this.boardLoadedOnce = false;
    this.set({
      station,
      board:
        cache === null
          ? emptyBoard
          : applyEvent(emptyBoard, { type: 'snapshot', tickets: cache.tickets }),
      pending: new Map(),
      lastSyncMs: cache?.savedAtMs ?? null,
      menuOpen: false,
    });
    this.startBoard(station);
  }

  /** Back to the station picker (requires an active session). */
  changeStation(): void {
    if (this.state.auth !== 'active') return;
    this.stopRealtime();
    this.stopTimers();
    this.deps.storage.setStation(null);
    this.set({ station: null, board: emptyBoard, menuOpen: false, synced: false, stations: null });
    void this.loadStations();
  }

  private startBoard(station: Station): void {
    this.set({ connection: 'connecting', synced: false });
    this.realtime.start(station.id, this.state.device?.id);
    this.realtimeRunning = true;
    const every = this.deps.config.resyncIntervalSeconds * 1000;
    if (this.resyncTimer !== null) clearInterval(this.resyncTimer);
    if (every > 0) {
      this.resyncTimer = setInterval(() => {
        if (this.state.connection === 'online') void this.reload();
      }, every);
    }
  }

  private stopRealtime(): void {
    this.realtime.stop();
    this.realtimeRunning = false;
  }

  private stopTimers(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.resyncTimer !== null) clearInterval(this.resyncTimer);
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.retryTimer = null;
    this.resyncTimer = null;
    this.pollTimer = null;
    this.reloadSeq++;
  }

  // ---- board data --------------------------------------------------------------------------

  /** Full reload of the station's ticket list (initial load, every reconnect, safety resync). */
  async reload(): Promise<void> {
    const station = this.state.station;
    if (station === null || this.token === null) return;
    const seq = ++this.reloadSeq;
    this.duringReload = new Map();
    this.reloadInFlight = true;
    try {
      // Server time is best-effort: it only corrects elapsed timers on a skewed kiosk clock.
      const [tickets, info] = await Promise.all([
        this.api.listTickets(station.id),
        this.api.getSystemInfo().catch(() => null),
      ]);
      if (seq !== this.reloadSeq) return; // superseded by a newer reload / station change
      const before = this.state.board;
      let board = applyEvent(emptyBoard, { type: 'snapshot', tickets });
      // Realtime events that arrived mid-flight may be newer than the snapshot.
      for (const t of this.duringReload.values()) {
        board = applyEvent(board, { type: 'ticketUpserted', ticket: t });
      }
      this.announceNew(before, board);
      this.retryAttempt = 0;
      this.boardLoadedOnce = true;
      this.setBoard(board, {
        synced: true,
        reloadFailed: false,
        lastSyncMs: this.now(),
        clockOffsetMs:
          info?.serverTimeMs == null ? this.state.clockOffsetMs : info.serverTimeMs - this.now(),
      });
    } catch (e) {
      if (seq !== this.reloadSeq) return;
      if (e instanceof ApiError && e.status === 401) return; // handled by the client's 401 hook
      if (e instanceof ApiError && e.status === 403 && e.code === 'permission_denied') {
        this.handleStationForbidden();
        return;
      }
      // While the socket is down the 10 s poll is the retry; otherwise back off.
      if (this.state.connection !== 'online') return;
      this.set({ reloadFailed: true, synced: false });
      const delay =
        RELOAD_RETRY_MS[Math.min(this.retryAttempt++, RELOAD_RETRY_MS.length - 1)] ?? 30_000;
      if (this.retryTimer !== null) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        void this.reload();
      }, delay);
    } finally {
      if (seq === this.reloadSeq) this.reloadInFlight = false;
    }
  }

  private handleTicket(ticket: Ticket): void {
    if (this.reloadInFlight) this.duringReload.set(ticket.id, ticket);
    const before = this.state.board;
    const board = applyEvent(before, { type: 'ticketUpserted', ticket });
    if (board === before) return;
    this.announceNew(before, board);
    // A realtime event confirms/overrides an optimistic bump for that ticket.
    const pending = this.state.pending;
    if (pending.has(ticket.id)) {
      const next = new Map(pending);
      next.delete(ticket.id);
      this.setBoard(board, { pending: next });
    } else {
      this.setBoard(board, {});
    }
  }

  private handleConnection(connection: ConnectionState): void {
    if (connection === this.state.connection) return;
    if (connection === 'online') {
      if (this.pollTimer !== null) clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.set({ connection }); // `synced` flips after the reload triggered by onSubscribed
      return;
    }
    this.set({ connection, synced: false });
    if (connection === 'forbidden') {
      this.handleStationForbidden();
    } else if (connection === 'auth-error') {
      void this.recoverAuth();
    } else if (this.pollTimer === null && this.token !== null) {
      // Socket down: keep the board fresh over REST every 10 s until it is back.
      this.pollTimer = setInterval(() => {
        void this.reload();
      }, POLL_MS);
    }
  }

  /**
   * The API said 403 for this station (channel auth or board load): this staff member has no
   * access to it (facility scope). Not a session problem - go back to the station picker.
   */
  private handleStationForbidden(): void {
    const name = this.state.station?.name ?? 'this station';
    this.stopRealtime();
    this.stopTimers();
    this.deps.storage.setStation(null);
    this.set({
      station: null,
      board: emptyBoard,
      synced: false,
      stations: null,
      connection: 'connecting',
    });
    this.toast(`Your account has no access to ${name}. Choose another station.`);
    void this.loadStations();
  }

  /** Channel auth was refused: try one token refresh and resubscribe, else sign out. */
  private async recoverAuth(): Promise<void> {
    const station = this.state.station;
    if (station !== null && (await this.refreshSession())) {
      this.startBoard(station);
    } else {
      this.handleUnauthorized();
    }
  }

  private setBoard(board: BoardState, patch: Partial<AppState>): void {
    this.set({ ...patch, board });
    const station = this.state.station;
    if (station !== null && this.boardLoadedOnce) {
      this.deps.storage.saveBoardCache({
        stationId: station.id,
        savedAtMs: this.now(),
        tickets: [...board.tickets.values()],
      });
    }
  }

  /** Chime when a brand-new ticket lands in NEW (not on the very first load). */
  private announceNew(before: BoardState, after: BoardState): void {
    if (!this.boardLoadedOnce) return; // initial load (or cache restore): stay quiet
    for (const [id, t] of after.tickets) {
      if (t.status === 'NEW' && !before.tickets.has(id)) {
        if (!this.state.settings.muted) this.deps.chime.play();
        return;
      }
    }
  }

  // ---- actions -----------------------------------------------------------------------------

  /**
   * Bumps a ticket to its next status: optimistic (shown as pending) then reconciled with the
   * server's answer. Read-only when locked or when the connection is down. The transition carries
   * `If-Match` (ETag fetched just before) so a ticket moved from another screen is not clobbered.
   */
  async bump(ticketId: string): Promise<void> {
    if (this.state.auth !== 'active') {
      this.openLogin();
      return;
    }
    this.activity();
    const ticket = this.state.board.tickets.get(ticketId);
    if (ticket === undefined) return;
    if (this.state.pending.has(ticketId)) return;
    const action = nextAction(ticket.status);
    if (action === null) return;
    if (this.state.connection !== 'online') {
      this.toast('Reconnecting - cannot send changes until the connection is back.');
      return;
    }
    const perms = this.state.permissions;
    if (perms !== null && !perms.includes(PERM_TRANSITION)) {
      this.toast('Your account is not allowed to update tickets.');
      return;
    }

    const keyId = `${ticket.id}:${action.to}:${String(ticket.version)}`;
    let key = this.keys.get(keyId);
    if (key === undefined) {
      key = newIdempotencyKey();
      this.keys.set(keyId, key);
    }
    this.setPending(ticketId, { to: action.to });
    try {
      const current = await this.api.getTicket(ticketId);
      if (current.ticket.version !== ticket.version) {
        // Someone (another screen, the POS) changed it since this screen last saw it.
        this.clearPending(ticketId);
        this.keys.delete(keyId);
        this.handleTicket(current.ticket);
        this.toast(`Ticket #${ticket.number} was just updated. Check it and tap again.`);
        return;
      }
      const etag = current.etag ?? `"${String(current.ticket.version)}"`;
      const updated = await this.api.transition(ticketId, action.to, key, etag);
      this.keys.delete(keyId);
      this.clearPending(ticketId);
      if (updated !== null) {
        this.handleTicket(updated);
      } else {
        await this.reload();
      }
    } catch (e) {
      this.clearPending(ticketId);
      if (e instanceof NetworkError) {
        // Outcome unknown; keep the key so a retry replays the same request.
        this.toast('No connection - the change was not confirmed. Check the board and retry.');
      } else if (e instanceof ApiError && e.status === 401) {
        // session dropped; handled by the client's 401 hook
      } else if (e instanceof ApiError) {
        // The server said no (illegal transition, changed elsewhere, no permission): show why,
        // then reconcile with server truth.
        if (e.status >= 400 && e.status < 500) this.keys.delete(keyId);
        this.toast(describeTransitionError(e));
        void this.reload();
      } else {
        this.toast('Something went wrong. Please retry.');
      }
    }
  }

  private setPending(id: string, p: PendingTransition): void {
    const next = new Map(this.state.pending);
    next.set(id, p);
    this.set({ pending: next });
  }

  private clearPending(id: string): void {
    if (!this.state.pending.has(id)) return;
    const next = new Map(this.state.pending);
    next.delete(id);
    this.set({ pending: next });
  }

  // ---- toasts, menu, settings --------------------------------------------------------------

  toast(text: string): void {
    const id = ++this.toastSeq;
    this.set({ toasts: [...this.state.toasts, { id, text }] });
    setTimeout(() => {
      this.dismissToast(id);
    }, TOAST_MS);
  }

  dismissToast(id: number): void {
    if (!this.state.toasts.some((t) => t.id === id)) return;
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  toggleMenu(open?: boolean): void {
    if (this.state.auth !== 'active') return;
    this.set({ menuOpen: open ?? !this.state.menuOpen });
  }

  saveSettings(patch: Partial<DeviceSettings>): void {
    const settings = { ...DEFAULT_SETTINGS, ...this.state.settings, ...patch };
    this.deps.storage.saveSettings(settings);
    this.set({ settings });
  }
}

function describeLoginError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'invalid_credentials':
        return 'Not recognised. Try again.';
      case 'account_locked':
        return 'This account is locked. Ask a supervisor.';
      case 'device_not_registered':
      case 'device_revoked':
        return 'This screen is not registered.';
      case 'rate_limited':
        return 'Too many attempts. Wait a moment.';
      default:
        return e.status === 401 || e.status === 422 ? 'Not recognised. Try again.' : e.userMessage;
    }
  }
  return e instanceof NetworkError ? 'Cannot reach the server.' : 'Sign-in failed.';
}

function describeRegistrationError(e: unknown): string {
  if (e instanceof ApiError) {
    return e.status === 422 || e.status === 409 || e.status === 404
      ? 'That registration code was not accepted. Check it or ask IT for a new one.'
      : e.userMessage;
  }
  return e instanceof NetworkError ? 'Cannot reach the server.' : 'Registration failed.';
}

function describeTransitionError(e: ApiError): string {
  switch (e.code) {
    case 'concurrency_conflict':
      return 'That ticket was changed by someone else. The board has been refreshed.';
    case 'permission_denied':
      return 'Your account is not allowed to do that.';
    default:
      return e.userMessage;
  }
}
