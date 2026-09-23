/** Tiny DOM helper (no framework). Text is always set via textContent - never innerHTML. */

type Child = Node | string | null | undefined | false;

export interface Attrs {
  readonly class?: string;
  readonly text?: string;
  readonly type?: string;
  readonly id?: string;
  readonly role?: string;
  readonly ariaLabel?: string;
  readonly ariaLive?: string;
  readonly hidden?: boolean;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly autocomplete?: string;
  readonly inputMode?: string;
  readonly value?: string;
  readonly min?: string;
  readonly max?: string;
  readonly data?: Readonly<Record<string, string>>;
  readonly onClick?: () => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs.class !== undefined) el.className = attrs.class;
  if (attrs.text !== undefined) el.textContent = attrs.text;
  if (attrs.id !== undefined) el.id = attrs.id;
  if (attrs.role !== undefined) el.setAttribute('role', attrs.role);
  if (attrs.ariaLabel !== undefined) el.setAttribute('aria-label', attrs.ariaLabel);
  if (attrs.ariaLive !== undefined) el.setAttribute('aria-live', attrs.ariaLive);
  if (attrs.hidden === true) el.hidden = true;
  if (el instanceof HTMLButtonElement) {
    el.type = 'button';
    if (attrs.disabled === true) el.disabled = true;
  }
  if (el instanceof HTMLInputElement) {
    if (attrs.type !== undefined) el.type = attrs.type;
    if (attrs.placeholder !== undefined) el.placeholder = attrs.placeholder;
    if (attrs.autocomplete !== undefined) el.setAttribute('autocomplete', attrs.autocomplete);
    if (attrs.inputMode !== undefined) el.inputMode = attrs.inputMode;
    if (attrs.value !== undefined) el.value = attrs.value;
    if (attrs.min !== undefined) el.min = attrs.min;
    if (attrs.max !== undefined) el.max = attrs.max;
  }
  for (const [k, v] of Object.entries(attrs.data ?? {})) el.dataset[k] = v;
  const onClick = attrs.onClick;
  if (onClick !== undefined)
    el.addEventListener('click', () => {
      onClick();
    });
  for (const c of children) {
    if (c !== null && c !== undefined && c !== false) el.append(c);
  }
  return el;
}

/** Sets text only when it changed (avoids needless layout / flicker on the 1 s tick). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function clockText(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
