/** Fires `onIdle` once after `timeoutMs` without `touch()`. Timer functions are injectable. */
export class IdleTimer {
  private handle: ReturnType<typeof setTimeout> | null = null;

  private readonly timeoutMs: number;
  private readonly onIdle: () => void;

  constructor(timeoutMs: number, onIdle: () => void) {
    this.timeoutMs = timeoutMs;
    this.onIdle = onIdle;
  }

  /** Starts (or restarts) the countdown. A timeout of 0 disables idle locking. */
  touch(): void {
    this.stop();
    if (this.timeoutMs <= 0) return;
    this.handle = setTimeout(() => {
      this.handle = null;
      this.onIdle();
    }, this.timeoutMs);
  }

  stop(): void {
    if (this.handle !== null) clearTimeout(this.handle);
    this.handle = null;
  }

  get running(): boolean {
    return this.handle !== null;
  }
}
