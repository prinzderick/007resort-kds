import type { Chime } from '../app';

/**
 * New-ticket chime synthesised with WebAudio (no asset files, works offline).
 * Browsers only allow audio after a user gesture; `unlock()` is called on the first touch/click.
 * On a dedicated kiosk start Chromium with --autoplay-policy=no-user-gesture-required.
 */
export class WebAudioChime implements Chime {
  private ctx: AudioContext | null = null;

  unlock(): void {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  play(): void {
    const ctx = this.ctx;
    if (ctx?.state !== 'running') return;
    const t0 = ctx.currentTime;
    [880, 1175].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.4, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
  }
}
