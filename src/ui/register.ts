import { h, setText } from './dom';

/** One-time device enrolment: the IT admin issues a registration code in the admin UI. */
export class RegisterScreen {
  readonly el: HTMLElement;
  private readonly name: HTMLInputElement;
  private readonly code: HTMLInputElement;
  private readonly error: HTMLElement;
  private readonly submit: HTMLButtonElement;

  constructor(handlers: { readonly onSubmit: (name: string, code: string) => void }) {
    this.name = h('input', {
      type: 'text',
      value: 'KDS Screen',
      ariaLabel: 'Screen name',
      autocomplete: 'off',
    });
    this.code = h('input', {
      type: 'text',
      placeholder: 'Registration code',
      ariaLabel: 'Registration code',
      autocomplete: 'off',
    });
    this.error = h('p', { class: 'login-error', role: 'alert' });
    this.submit = h('button', { class: 'btn primary big', text: 'Register this screen' });
    this.submit.setAttribute('type', 'submit');
    const form = h(
      'form',
      { class: 'sheet register' },
      h('h1', { text: 'Register this screen' }),
      h('p', {
        class: 'setup-sub',
        text: 'Ask IT for a one-time registration code (Admin > Devices), then enter it below.',
      }),
      h('label', {}, h('span', { text: 'Screen name' }), this.name),
      h('label', {}, h('span', { text: 'Registration code' }), this.code),
      this.submit,
      this.error,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = this.code.value.trim();
      if (code === '' || this.name.value.trim() === '') return;
      handlers.onSubmit(this.name.value.trim(), code);
    });
    this.el = h('main', { class: 'setup' }, form);
  }

  update(busy: boolean, error: string | null): void {
    this.submit.disabled = busy;
    setText(this.error, error ?? '');
    if (!busy && error === null) this.code.value = '';
  }
}
