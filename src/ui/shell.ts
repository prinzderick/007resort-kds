import type { AppState, KdsApp } from '../app';
import { visibleTickets } from '../state/tickets';
import { Board } from './board';
import { clockText, h, setText } from './dom';
import { LoginSheet } from './login';
import { RegisterScreen } from './register';
import { SetupScreen } from './setup';
import type { WebAudioChime } from './sound';

/** Wires the controller state to the DOM. Rendering is idempotent; state changes just re-run it. */

export interface Shell {
  /** Per-second refresh (timers, clock). Exposed for tests. */
  tick(): void;
  destroy(): void;
}

export function mountShell(root: HTMLElement, app: KdsApp, chime?: WebAudioChime): Shell {
  const board = new Board({
    onBump: (id) => {
      void app.bump(id);
    },
  });
  const setup = new SetupScreen({
    onPick: (s) => {
      app.chooseStation(s);
    },
    onRetry: () => {
      void app.loadStations();
    },
  });
  const register = new RegisterScreen({
    onSubmit: (name, code) => {
      void app.registerDevice(name, code);
    },
  });
  const login = new LoginSheet({
    onSubmit: (req) => {
      void app.login(req);
    },
    onCancel: () => {
      app.closeLogin();
    },
  });

  // ---- header ----
  const title = h('span', { class: 'hdr-station' });
  const chip = h('span', { class: 'chip', role: 'status' });
  const staff = h('button', {
    class: 'btn hdr-staff',
    onClick: () => {
      if (app.getState().auth === 'active') app.lock();
      else app.openLogin();
    },
  });
  const clock = h('span', { class: 'hdr-clock' });
  const sound = h('button', {
    class: 'btn icon',
    ariaLabel: 'Toggle sound',
    onClick: () => {
      app.saveSettings({ muted: !app.getState().settings.muted });
    },
  });
  const menuBtn = h('button', {
    class: 'btn icon',
    text: '☰',
    ariaLabel: 'Menu',
    onClick: () => {
      app.toggleMenu();
    },
  });
  const header = h(
    'header',
    { class: 'hdr' },
    title,
    chip,
    h('span', { class: 'spacer' }),
    clock,
    staff,
    sound,
    menuBtn,
  );

  const banner = h('div', { class: 'banner', role: 'status', ariaLive: 'polite', hidden: true });
  const content = h('div', { class: 'content' });
  const toasts = h('div', { class: 'toasts', ariaLive: 'assertive' });

  // ---- menu sheet ----
  const warnIn = h('input', { type: 'number', min: '0', max: '600', ariaLabel: 'Warning minutes' });
  const lateIn = h('input', { type: 'number', min: '0', max: '600', ariaLabel: 'Late minutes' });
  const applyThresholds = (): void => {
    const w = warnIn.value === '' ? null : Number(warnIn.value) * 60;
    const l = lateIn.value === '' ? null : Number(lateIn.value) * 60;
    app.saveSettings({ warnAfterSeconds: w, lateAfterSeconds: l });
  };
  warnIn.addEventListener('change', applyThresholds);
  lateIn.addEventListener('change', applyThresholds);
  const menu = h(
    'div',
    { class: 'overlay', role: 'dialog', ariaLabel: 'Menu', hidden: true },
    h(
      'div',
      { class: 'sheet menu' },
      h('h2', { text: 'Menu' }),
      h('button', {
        class: 'btn big',
        text: 'Change station',
        onClick: () => {
          app.changeStation();
        },
      }),
      h('button', {
        class: 'btn big',
        text: 'Lock screen',
        onClick: () => {
          app.lock();
        },
      }),
      h('button', {
        class: 'btn big',
        text: 'Sign out',
        onClick: () => {
          app.signOut();
        },
      }),
      h(
        'div',
        { class: 'thresholds' },
        h('h3', { text: 'Ticket colours (minutes)' }),
        h('label', {}, h('span', { text: 'Amber after' }), warnIn),
        h('label', {}, h('span', { text: 'Red after' }), lateIn),
        h('button', {
          class: 'btn link',
          text: 'Reset to defaults',
          onClick: () => {
            app.saveSettings({ warnAfterSeconds: null, lateAfterSeconds: null });
          },
        }),
      ),
      h('button', {
        class: 'btn ghost',
        text: 'Close',
        onClick: () => {
          app.toggleMenu(false);
        },
      }),
    ),
  );

  root.replaceChildren(header, banner, content, toasts, menu, login.el);
  root.classList.add('kds');

  let lastShown: 'register' | 'setup' | 'board' | null = null;

  const render = (s: AppState): void => {
    const active = s.auth === 'active';
    root.dataset.auth = s.auth;
    root.dataset.connection = s.connection;

    setText(title, s.station?.name ?? '007 Resort & Spa KDS');
    setText(
      staff,
      active
        ? `${s.staffName ?? 'Staff'} · Lock`
        : s.auth === 'locked'
          ? 'Locked · Sign in'
          : 'Sign in',
    );
    setText(sound, s.settings.muted ? '🔇' : '🔔');
    sound.setAttribute('aria-pressed', String(s.settings.muted));

    // connection chip + banner
    const { chipText, chipKind, bannerText, bannerKind } = describeConnection(s);
    setText(chip, chipText);
    chip.dataset.kind = chipKind;
    banner.hidden = bannerText === null;
    banner.dataset.kind = bannerKind;
    setText(banner, bannerText ?? '');

    // content: setup or board
    const needsDevice = s.device === null;
    const wantSetup = s.station === null;
    const which = needsDevice ? 'register' : wantSetup ? 'setup' : 'board';
    if (lastShown !== which) {
      content.replaceChildren(needsDevice ? register.el : wantSetup ? setup.el : board.el);
      lastShown = which;
    }
    if (needsDevice) {
      register.update(s.registrationBusy, s.registrationError);
    } else if (wantSetup) {
      setup.update(active || s.stations !== null ? s.stations : null, s.stationsError);
    } else {
      board.update({
        tickets: visibleTickets(s.board),
        pending: s.pending,
        thresholds: app.thresholds(),
        clockOffsetMs: s.clockOffsetMs,
        online: s.connection === 'online',
        locked: !active,
        nowMs: app.nowMs(),
      });
    }

    // toasts
    const shownIds = [...toasts.children].map((c) => (c as HTMLElement).dataset.id);
    const wantIds = s.toasts.map((t) => String(t.id));
    if (shownIds.join() !== wantIds.join()) {
      toasts.replaceChildren(
        ...s.toasts.map((t) =>
          h('div', {
            class: 'toast',
            text: t.text,
            role: 'alert',
            data: { id: String(t.id) },
            onClick: () => {
              app.dismissToast(t.id);
            },
          }),
        ),
      );
    }

    // menu + login
    menu.hidden = !(s.menuOpen && active);
    if (!menu.hidden) {
      const eff = app.thresholds();
      if (document.activeElement !== warnIn)
        warnIn.value = String(Math.round(eff.warnAfterSeconds / 60));
      if (document.activeElement !== lateIn)
        lateIn.value = String(Math.round(eff.lateAfterSeconds / 60));
    }
    login.update({
      open: !needsDevice && (s.auth === 'signed-out' || s.loginOpen),
      required: s.auth === 'signed-out',
      busy: s.loginBusy,
      error: s.loginError,
    });
  };

  const unsubscribe = app.subscribe(render);
  render(app.getState());

  const tick = (): void => {
    setText(clock, clockText(app.nowMs()));
    board.tick(app.nowMs());
  };
  tick();
  const timer = setInterval(tick, 1000);

  // Activity (idle-lock) + audio unlock.
  const onActivity = (): void => {
    app.activity();
    chime?.unlock();
  };
  const events = ['pointerdown', 'keydown', 'touchstart'] as const;
  for (const e of events) document.addEventListener(e, onActivity, { passive: true });

  return {
    tick,
    destroy: () => {
      clearInterval(timer);
      unsubscribe();
      for (const e of events) document.removeEventListener(e, onActivity);
    },
  };
}

function describeConnection(s: AppState): {
  chipText: string;
  chipKind: 'ok' | 'warn' | 'bad';
  bannerText: string | null;
  bannerKind: 'warn' | 'bad';
} {
  const asOf = s.lastSyncMs === null ? '' : ` (last update ${clockText(s.lastSyncMs)})`;
  if (s.auth === 'signed-out' || s.device === null) {
    return { chipText: 'Signed out', chipKind: 'warn', bannerText: null, bannerKind: 'warn' };
  }
  if (s.station === null) {
    return { chipText: 'Setup', chipKind: 'warn', bannerText: null, bannerKind: 'warn' };
  }
  switch (s.connection) {
    case 'online':
      if (s.reloadFailed) {
        return {
          chipText: 'Live',
          chipKind: 'warn',
          bannerText: 'Could not refresh the board - retrying. Showing last known tickets.' + asOf,
          bannerKind: 'warn',
        };
      }
      if (s.siteStatus === 'DEGRADED' || s.siteStatus === 'OFFLINE') {
        return {
          chipText: 'Server degraded',
          chipKind: 'warn',
          bannerText:
            'The server reports a problem (some services are degraded). Tickets may be delayed.',
          bannerKind: 'warn',
        };
      }
      return s.synced
        ? { chipText: 'Live', chipKind: 'ok', bannerText: null, bannerKind: 'warn' }
        : { chipText: 'Syncing…', chipKind: 'warn', bannerText: null, bannerKind: 'warn' };
    case 'reconnecting':
      return {
        chipText: 'Reconnecting…',
        chipKind: 'bad',
        bannerText: `RECONNECTING - showing last known board${asOf}. Refreshing every 10 s; changes are disabled until live updates are back.`,
        bannerKind: 'bad',
      };
    case 'auth-error':
      return {
        chipText: 'No access',
        chipKind: 'bad',
        bannerText: 'Live updates were refused. Sign out and sign in again.',
        bannerKind: 'bad',
      };
    default:
      return {
        chipText: 'Connecting…',
        chipKind: 'warn',
        bannerText: `Connecting to the server…${asOf}`,
        bannerKind: 'warn',
      };
  }
}
