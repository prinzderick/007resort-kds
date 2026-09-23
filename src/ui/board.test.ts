// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { Board, type BoardView } from './board';
import { ticket } from '../test/fakes';

const NOW = Date.parse('2026-09-22T10:10:00Z');
const T = { warnAfterSeconds: 300, lateAfterSeconds: 600 };

function view(over: Partial<BoardView> = {}): BoardView {
  return {
    tickets: [],
    pending: new Map(),
    thresholds: T,
    clockOffsetMs: 0,
    online: true,
    locked: false,
    nowMs: NOW,
    ...over,
  };
}
const created = (secsAgo: number) => new Date(NOW - secsAgo * 1000).toISOString();
const col = (b: Board, id: string) => b.el.querySelector<HTMLElement>(`[data-column="${id}"]`)!;
const card = (b: Board, id: string) => b.el.querySelector<HTMLElement>(`[data-ticket="${id}"]`)!;

describe('Board', () => {
  it('sorts tickets into NEW / IN PROGRESS / READY columns with counts', () => {
    const b = new Board({ onBump: vi.fn() });
    b.update(
      view({
        tickets: [
          ticket({ id: 'n', status: 'NEW' }),
          ticket({ id: 'acc', status: 'ACCEPTED' }),
          ticket({ id: 'ip', status: 'IN_PROGRESS' }),
          ticket({ id: 'r', status: 'READY' }),
        ],
      }),
    );
    expect(
      [...col(b, 'NEW').querySelectorAll('.card')].map((c) => (c as HTMLElement).dataset.ticket),
    ).toEqual(['n']);
    expect(
      [...col(b, 'IN_PROGRESS').querySelectorAll('.card')].map(
        (c) => (c as HTMLElement).dataset.ticket,
      ),
    ).toEqual(['acc', 'ip']);
    expect(col(b, 'READY').querySelector('.col-count')?.textContent).toBe('1');
  });

  it('shows table, order reference, waiter, items, modifiers and notes', () => {
    const b = new Board({ onBump: vi.fn() });
    b.update(
      view({
        tickets: [
          ticket({
            id: 't',
            number: 'K-042',
            tableLabel: 'Table 12',
            orderNumber: 'RST1-000123',
            serverName: 'Amaka O.',
            notes: 'Birthday - bring candle',
            items: [
              { name: 'Suya platter', quantity: 2, modifiers: ['extra yaji'], notes: 'no onions' },
            ],
          }),
        ],
      }),
    );
    const text = card(b, 't').textContent;
    for (const s of [
      'K-042',
      'Table 12',
      'RST1-000123',
      'Amaka O.',
      '2×',
      'Suya platter',
      'extra yaji',
      'no onions',
      'Birthday - bring candle',
    ]) {
      expect(text).toContain(s);
    }
  });

  it('escapes ticket text (no HTML injection from order notes)', () => {
    const b = new Board({ onBump: vi.fn() });
    b.update(
      view({
        tickets: [
          ticket({ id: 't', items: [{ name: '<img src=x onerror=alert(1)>', quantity: 1 }] }),
        ],
      }),
    );
    expect(card(b, 't').querySelector('img')).toBeNull();
    expect(card(b, 't').textContent).toContain('<img src=x');
  });

  it.each([
    [30, 'ok', '0:30'],
    [299, 'ok', '4:59'],
    [300, 'warn', '5:00'],
    [599, 'warn', '9:59'],
    [600, 'late', '10:00'],
    [3725, 'late', '1:02:05'],
  ] as const)('ticket aged %is is %s (%s)', (age, urgency, label) => {
    const b = new Board({ onBump: vi.fn() });
    b.update(view({ tickets: [ticket({ id: 't', createdAtUtc: created(age) })] }));
    expect(card(b, 't').dataset.urgency).toBe(urgency);
    expect(card(b, 't').querySelector('.card-timer')?.textContent).toBe(label);
  });

  it('honours configured thresholds and re-colours on the 1 s tick without rebuilding cards', () => {
    const b = new Board({ onBump: vi.fn() });
    b.update(
      view({
        thresholds: { warnAfterSeconds: 60, lateAfterSeconds: 120 },
        tickets: [ticket({ id: 't', createdAtUtc: created(59) })],
      }),
    );
    const el = card(b, 't');
    expect(el.dataset.urgency).toBe('ok');
    b.tick(NOW + 1_000);
    expect(el.dataset.urgency).toBe('warn');
    b.tick(NOW + 61_000);
    expect(el.dataset.urgency).toBe('late');
    expect(card(b, 't')).toBe(el); // same DOM node: a touch in progress is never lost
  });

  it('applies the server clock offset to the timers', () => {
    const b = new Board({ onBump: vi.fn() });
    b.update(
      view({ clockOffsetMs: 300_000, tickets: [ticket({ id: 't', createdAtUtc: created(10) })] }),
    );
    expect(card(b, 't').dataset.urgency).toBe('warn');
  });

  it('bump buttons: label per status, click reports the ticket id', () => {
    const onBump = vi.fn();
    const b = new Board({ onBump });
    b.update(
      view({
        tickets: [
          ticket({ id: 'n', status: 'NEW' }),
          ticket({ id: 'acc', status: 'ACCEPTED' }),
          ticket({ id: 'ip', status: 'IN_PROGRESS' }),
          ticket({ id: 'r', status: 'READY' }),
        ],
      }),
    );
    const label = (id: string) => card(b, id).querySelector('button')?.textContent;
    expect([label('n'), label('acc'), label('ip'), label('r')]).toEqual([
      'Accept',
      'Start',
      'Ready',
      'Served',
    ]);
    card(b, 'ip').querySelector('button')?.click();
    expect(onBump).toHaveBeenCalledWith('ip');
  });

  it('optimistic pending: card moves to the target column, button shows Sending and is disabled', () => {
    const b = new Board({ onBump: vi.fn() });
    b.update(
      view({
        tickets: [ticket({ id: 't', status: 'IN_PROGRESS' })],
        pending: new Map([['t', { to: 'READY' }]]),
      }),
    );
    expect(col(b, 'READY').contains(card(b, 't'))).toBe(true);
    const btn = card(b, 't').querySelector('button');
    expect(btn?.textContent).toBe('Sending…');
    expect(btn?.disabled).toBe(true);
    expect(card(b, 't').dataset.pending).toBe('true');

    // server rejected: pending cleared, card returns to the server's column
    b.update(view({ tickets: [ticket({ id: 't', status: 'IN_PROGRESS' })] }));
    expect(col(b, 'IN_PROGRESS').contains(card(b, 't'))).toBe(true);
    expect(card(b, 't').dataset.pending).toBe('false');
  });

  it('offline disables the buttons; locked keeps them tappable (they prompt sign-in)', () => {
    const b = new Board({ onBump: vi.fn() });
    const t = [ticket({ id: 't' })];
    b.update(view({ tickets: t, online: false }));
    expect(card(b, 't').querySelector('button')?.disabled).toBe(true);
    b.update(view({ tickets: t, online: true, locked: true }));
    const btn = card(b, 't').querySelector('button');
    expect(btn?.disabled).toBe(false);
    expect(btn?.dataset.locked).toBe('true');
  });

  it('view-only sessions get no action buttons', () => {
    const b = new Board({ onBump: vi.fn() });
    const t = [ticket({ id: 't' })];
    b.update(view({ tickets: t, viewOnly: true }));
    expect(card(b, 't').querySelector('button')?.hidden).toBe(true);
    b.update(view({ tickets: t, viewOnly: false }));
    expect(card(b, 't').querySelector('button')?.hidden).toBe(false);
  });

  it('removes cards for tickets that left the board', () => {
    const b = new Board({ onBump: vi.fn() });
    b.update(view({ tickets: [ticket({ id: 'a' }), ticket({ id: 'b' })] }));
    b.update(view({ tickets: [ticket({ id: 'b' })] }));
    expect(b.el.querySelectorAll('.card')).toHaveLength(1);
  });
});
