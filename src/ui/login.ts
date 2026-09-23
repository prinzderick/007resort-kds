import type { LoginRequest } from '../api/client';
import { WedgeScanner } from '../auth/wedge';
import { h, setText } from './dom';

/**
 * Staff sign-in sheet: on-screen PIN pad, keyboard-wedge NFC card taps, optional password form.
 * The API resolves the staff member from the credential; nothing is validated here.
 */

export interface LoginHandlers {
  readonly onSubmit: (req: LoginRequest) => void;
  readonly onCancel: () => void;
}

export interface LoginView {
  readonly open: boolean;
  /** Signed out entirely (cannot be dismissed). */
  readonly required: boolean;
  readonly busy: boolean;
  readonly error: string | null;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'] as const;
const MAX_PIN = 12;

export class LoginSheet {
  readonly el: HTMLElement;
  private readonly dots: HTMLElement;
  private readonly error: HTMLElement;
  private readonly cancel: HTMLButtonElement;
  private readonly pinPanel: HTMLElement;
  private readonly passPanel: HTMLFormElement;
  private readonly user: HTMLInputElement;
  private readonly pass: HTMLInputElement;
  private readonly buttons: HTMLButtonElement[] = [];
  private pin = '';
  private open = false;
  private busy = false;
  private readonly wedge = new WedgeScanner();

  private readonly handlers: LoginHandlers;
  private readonly clock: () => number;

  constructor(handlers: LoginHandlers, clock: () => number = () => performance.now()) {
    this.handlers = handlers;
    this.clock = clock;
    this.dots = h('div', { class: 'pin-dots', ariaLabel: 'PIN entered', role: 'status' });
    this.error = h('p', { class: 'login-error', role: 'alert' });
    this.cancel = h('button', {
      class: 'btn ghost',
      text: 'Back to board',
      onClick: () => {
        this.handlers.onCancel();
      },
    });

    const pad = h('div', { class: 'pin-pad' });
    for (const k of KEYS) {
      const b = h('button', {
        class: k === 'C' || k === '⌫' ? 'pad-key pad-alt' : 'pad-key',
        text: k,
        ariaLabel: k === '⌫' ? 'Backspace' : k === 'C' ? 'Clear' : k,
        onClick: () => {
          this.press(k);
        },
      });
      this.buttons.push(b);
      pad.append(b);
    }
    const enter = h('button', {
      class: 'btn primary big',
      text: 'Sign in',
      onClick: () => {
        this.submitPin();
      },
    });
    this.buttons.push(enter);
    const toPass = h('button', {
      class: 'btn link',
      text: 'Use password instead',
      onClick: () => {
        this.pinPanel.hidden = true;
        this.passPanel.hidden = false;
        this.user.focus();
      },
    });
    this.pinPanel = h(
      'div',
      { class: 'login-panel' },
      h('p', { class: 'login-hint', text: 'Tap your staff card or enter your PIN' }),
      this.dots,
      pad,
      enter,
      toPass,
    );

    this.user = h('input', {
      type: 'text',
      placeholder: 'Username',
      autocomplete: 'username',
      ariaLabel: 'Username',
    });
    this.pass = h('input', {
      type: 'password',
      placeholder: 'Password',
      autocomplete: 'current-password',
      ariaLabel: 'Password',
    });
    const toPin = h('button', {
      class: 'btn link',
      text: 'Use PIN / card instead',
      onClick: () => {
        this.passPanel.hidden = true;
        this.pinPanel.hidden = false;
      },
    });
    this.passPanel = h(
      'form',
      { class: 'login-panel', hidden: true },
      this.user,
      this.pass,
      h('button', { class: 'btn primary big', text: 'Sign in' }),
      toPin,
    );
    this.passPanel.querySelector('button')?.setAttribute('type', 'submit');
    this.passPanel.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.busy || this.user.value === '' || this.pass.value === '') return;
      this.handlers.onSubmit({
        credentialType: 'PASSWORD',
        identifier: this.user.value.trim(),
        secret: this.pass.value,
      });
      this.pass.value = '';
    });

    this.el = h(
      'div',
      { class: 'overlay', role: 'dialog', ariaLabel: 'Staff sign-in', hidden: true },
      h(
        'div',
        { class: 'sheet login' },
        h('h2', { text: 'Staff sign-in' }),
        this.pinPanel,
        this.passPanel,
        this.error,
        this.cancel,
      ),
    );

    document.addEventListener('keydown', (e) => {
      this.onKey(e);
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.open || this.busy) return;
    if (e.target instanceof HTMLInputElement) return; // typing in the password form
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const result = this.wedge.feed(e.key, this.clock());
    if (e.key === 'Enter') {
      e.preventDefault();
      if (result?.credentialType === 'NFC_CARD') {
        this.setPin('');
        this.handlers.onSubmit({ credentialType: 'NFC_CARD', secret: result.value });
      } else {
        this.submitPin();
      }
    } else if (e.key === 'Backspace') {
      this.setPin(this.pin.slice(0, -1));
    } else if (/^\d$/.test(e.key)) {
      this.setPin(this.pin + e.key);
    }
  }

  private press(k: (typeof KEYS)[number]): void {
    if (this.busy) return;
    if (k === 'C') this.setPin('');
    else if (k === '⌫') this.setPin(this.pin.slice(0, -1));
    else this.setPin(this.pin + k);
  }

  private setPin(next: string): void {
    this.pin = next.slice(0, MAX_PIN);
    setText(this.dots, '●'.repeat(this.pin.length));
  }

  private submitPin(): void {
    if (this.busy || this.pin === '') return;
    const secret = this.pin;
    this.setPin('');
    this.handlers.onSubmit({ credentialType: 'PIN', secret });
  }

  update(view: LoginView): void {
    const opening = view.open && !this.open;
    this.open = view.open;
    this.busy = view.busy;
    this.el.hidden = !view.open;
    this.cancel.hidden = view.required;
    setText(this.error, view.error ?? '');
    for (const b of this.buttons) b.disabled = view.busy;
    if (opening) {
      this.wedge.reset();
      this.setPin('');
      this.pinPanel.hidden = false;
      this.passPanel.hidden = true;
    }
    if (!view.open) {
      this.setPin('');
      this.pass.value = '';
    }
  }
}
