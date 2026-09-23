// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { LoginRequest } from '../api/client';
import { LoginSheet } from './login';

const view = { open: true, required: true, busy: false, error: null as string | null };
let clock = 0;

function key(k: string, at: number) {
  clock = at;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}
const pad = (s: LoginSheet, label: string) =>
  [...s.el.querySelectorAll<HTMLButtonElement>('.pad-key')].find((b) => b.textContent === label)!;

describe('LoginSheet', () => {
  let onSubmit: Mock<(req: LoginRequest) => void>;
  let sheet: LoginSheet;
  beforeEach(() => {
    document.body.innerHTML = '';
    onSubmit = vi.fn<(req: LoginRequest) => void>();
    sheet = new LoginSheet({ onSubmit, onCancel: vi.fn() }, () => clock);
    document.body.append(sheet.el);
    sheet.update(view);
  });

  it('is visible when open and cannot be dismissed while required', () => {
    expect(sheet.el.hidden).toBe(false);
    expect(sheet.el.querySelector<HTMLElement>('.btn.ghost')!.hidden).toBe(true);
    sheet.update({ ...view, required: false });
    expect(sheet.el.querySelector<HTMLElement>('.btn.ghost')!.hidden).toBe(false);
    sheet.update({ ...view, open: false });
    expect(sheet.el.hidden).toBe(true);
  });

  const who = (sh: LoginSheet) => sh.el.querySelector<HTMLInputElement>('.login-who')!;

  it('submits staff number + PIN typed on the on-screen pad (masked)', () => {
    who(sheet).value = 'S-0004';
    for (const k of ['4', '8', '2', '1']) pad(sheet, k).click();
    expect(sheet.el.querySelector('.pin-dots')?.textContent).toBe('\u25cf\u25cf\u25cf\u25cf');
    sheet.el.querySelector<HTMLButtonElement>('.btn.primary')!.click();
    expect(onSubmit).toHaveBeenCalledWith({
      credentialType: 'PIN',
      identifier: 'S-0004',
      secret: '4821',
    });
    expect(sheet.el.querySelector('.pin-dots')?.textContent).toBe(''); // cleared after submit
    expect(who(sheet).value).toBe('S-0004'); // kept so a mistyped PIN can be retried
  });

  it('a PIN without a staff number or card is not sent (the API would refuse it)', () => {
    for (const k of ['1', '2', '3', '4']) pad(sheet, k).click();
    sheet.el.querySelector<HTMLButtonElement>('.btn.primary')!.click();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(sheet.el.querySelector('.login-card-note')?.textContent).toMatch(/staff number/);
  });

  it('backspace and clear edit the entry', () => {
    pad(sheet, '1').click();
    pad(sheet, '2').click();
    pad(sheet, '⌫').click();
    expect(sheet.el.querySelector('.pin-dots')?.textContent).toBe('●');
    pad(sheet, 'C').click();
    expect(sheet.el.querySelector('.pin-dots')?.textContent).toBe('');
  });

  it('an NFC reader (keyboard wedge) identifies the person; the PIN is still required', () => {
    let t = 100;
    for (const ch of '04A1B2C3') {
      key(ch, t);
      t += 6; // reader types ~6 ms per character
    }
    key('Enter', t);
    expect(onSubmit).not.toHaveBeenCalled(); // the card alone never signs in
    expect(sheet.el.querySelector('.login-card-note')?.textContent).toMatch(/Card read/);
    for (const k of ['1', '2', '3', '4']) pad(sheet, k).click();
    sheet.el.querySelector<HTMLButtonElement>('.btn.primary')!.click();
    expect(onSubmit).toHaveBeenCalledWith({
      credentialType: 'NFC_CARD',
      identifier: '04A1B2C3',
      secret: '1234',
    });
  });

  it('a card tapped while the staff-number field has focus is read as a card, not typed text', () => {
    const input = who(sheet);
    let t = 100;
    for (const ch of '04A1B2C3') {
      clock = t;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      input.value += ch;
      t += 6;
    }
    clock = t;
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(input.value).toBe('');
    expect(sheet.el.querySelector('.login-card-note')?.textContent).toMatch(/Card read/);
  });

  it('a physical keyboard PIN (slow digits + Enter) signs in with the typed staff number', () => {
    who(sheet).value = 'kitchen1';
    let t = 100;
    for (const ch of '1234') {
      key(ch, t);
      t += 300;
    }
    key('Enter', t);
    expect(onSubmit).toHaveBeenCalledWith({
      credentialType: 'PIN',
      identifier: 'kitchen1',
      secret: '1234',
    });
  });

  it('ignores key input while closed or busy', () => {
    sheet.update({ ...view, open: false });
    key('1', 1);
    key('Enter', 2);
    sheet.update({ ...view, busy: true });
    key('1', 3);
    key('Enter', 4);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('password form submits PASSWORD with identifier', () => {
    const [toPass] = [...sheet.el.querySelectorAll<HTMLButtonElement>('.btn.link')];
    toPass?.click();
    const form = sheet.el.querySelector('form')!;
    expect(form.hidden).toBe(false);
    const [user, pass] = form.querySelectorAll('input');
    user!.value = 'kds';
    pass!.value = 'kds-pass';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onSubmit).toHaveBeenCalledWith({
      credentialType: 'PASSWORD',
      identifier: 'kds',
      secret: 'kds-pass',
    });
    expect(pass!.value).toBe(''); // never left on screen
  });

  it('shows errors and disables the pad while busy', () => {
    sheet.update({ ...view, error: 'Not recognised. Try again.', busy: true });
    expect(sheet.el.querySelector('.login-error')?.textContent).toBe('Not recognised. Try again.');
    expect(pad(sheet, '5').disabled).toBe(true);
  });
});
