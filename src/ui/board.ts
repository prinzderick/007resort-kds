import type { Ticket } from '../state/tickets';
import { elapsedSeconds, formatElapsed, urgencyOf, type Thresholds } from '../state/elapsed';
import { COLUMNS, columnOf, nextAction, statusLabel, type BoardColumn } from '../state/transitions';
import type { PendingTransition } from '../app';
import { h, setText } from './dom';

/**
 * Keyed ticket board. Cards are updated in place (never rebuilt on the 1 s tick) so a touch that
 * starts on a button is not lost to a re-render.
 */

export interface BoardView {
  readonly tickets: readonly Ticket[]; // display order (oldest first)
  readonly pending: ReadonlyMap<string, PendingTransition>;
  readonly thresholds: Thresholds;
  readonly clockOffsetMs: number;
  /** Connected to the server: changes can be sent. Offline = read-only. */
  readonly online: boolean;
  /** Not signed in for actions (idle-locked): buttons prompt for sign-in. */
  readonly locked: boolean;
  /** Signed in without `prep_ticket.transition`: the board is watch-only, no action buttons. */
  readonly viewOnly?: boolean;
  readonly nowMs: number;
}

export interface BoardHandlers {
  readonly onBump: (ticketId: string) => void;
}

interface Card {
  readonly el: HTMLElement;
  readonly number: HTMLElement;
  readonly status: HTMLElement;
  readonly meta: HTMLElement;
  readonly timer: HTMLElement;
  readonly items: HTMLElement;
  readonly button: HTMLButtonElement;
  version: number;
  createdAtUtc: string;
}

export class Board {
  readonly el: HTMLElement;
  private readonly columns = new Map<BoardColumn, { body: HTMLElement; count: HTMLElement }>();
  private readonly cards = new Map<string, Card>();
  private view: BoardView | null = null;

  private readonly handlers: BoardHandlers;

  constructor(handlers: BoardHandlers) {
    this.handlers = handlers;
    this.el = h('main', { class: 'board' });
    for (const col of COLUMNS) {
      const count = h('span', { class: 'col-count', text: '0' });
      const body = h('div', { class: 'col-body' });
      this.columns.set(col.id, { body, count });
      this.el.append(
        h(
          'section',
          { class: 'col', data: { column: col.id }, ariaLabel: col.label },
          h('h2', { class: 'col-title' }, h('span', { text: col.label }), count),
          body,
        ),
      );
    }
  }

  update(view: BoardView): void {
    this.view = view;
    const wanted = new Map<BoardColumn, Ticket[]>(COLUMNS.map((c) => [c.id, []]));
    const seen = new Set<string>();

    for (const ticket of view.tickets) {
      const pending = view.pending.get(ticket.id);
      const shownStatus = pending?.to ?? ticket.status;
      const col = columnOf(shownStatus);
      if (col === null) continue; // optimistic DISPENSED: leaves the board immediately
      wanted.get(col)?.push(ticket);
      seen.add(ticket.id);

      let card = this.cards.get(ticket.id);
      if (card === undefined) {
        card = this.createCard(ticket);
        this.cards.set(ticket.id, card);
      }
      this.updateCard(card, ticket, pending, view);
    }

    for (const [id, card] of this.cards) {
      if (!seen.has(id)) {
        card.el.remove();
        this.cards.delete(id);
      }
    }

    for (const [colId, list] of wanted) {
      const target = this.columns.get(colId);
      if (target === undefined) continue;
      setText(target.count, String(list.length));
      list.forEach((ticket, index) => {
        const el = this.cards.get(ticket.id)?.el;
        if (el !== undefined && target.body.children[index] !== el) {
          target.body.insertBefore(el, target.body.children[index] ?? null);
        }
      });
    }
    this.tick(view.nowMs);
  }

  /** Refreshes elapsed timers and urgency colours (called every second). */
  tick(nowMs: number): void {
    const view = this.view;
    if (view === null) return;
    for (const card of this.cards.values()) {
      const secs = elapsedSeconds(card.createdAtUtc, nowMs, view.clockOffsetMs);
      setText(card.timer, formatElapsed(secs));
      const urgency = urgencyOf(secs, view.thresholds);
      if (card.el.dataset.urgency !== urgency) card.el.dataset.urgency = urgency;
    }
  }

  private createCard(ticket: Ticket): Card {
    const number = h('span', { class: 'card-number' });
    const status = h('span', { class: 'card-status' });
    const timer = h('span', { class: 'card-timer', ariaLabel: 'Elapsed time' });
    const meta = h('div', { class: 'card-meta' });
    const items = h('ul', { class: 'card-items' });
    const button = h('button', {
      class: 'bump',
      onClick: () => {
        this.handlers.onBump(ticket.id);
      },
    });
    const el = h(
      'article',
      { class: 'card', data: { ticket: ticket.id } },
      h('header', { class: 'card-head' }, number, status, timer),
      meta,
      items,
      button,
    );
    return {
      el,
      number,
      status,
      meta,
      timer,
      items,
      button,
      version: -1,
      createdAtUtc: ticket.createdAtUtc,
    };
  }

  private updateCard(
    card: Card,
    ticket: Ticket,
    pending: PendingTransition | undefined,
    view: BoardView,
  ): void {
    card.createdAtUtc = ticket.createdAtUtc;
    const shown = pending?.to ?? ticket.status;
    card.el.dataset.status = shown;
    card.el.dataset.pending = pending === undefined ? 'false' : 'true';
    setText(card.number, `#${ticket.number}`);
    setText(
      card.status,
      pending === undefined ? statusLabel(ticket.status) : `${statusLabel(shown)}…`,
    );

    if (card.version !== ticket.version) {
      card.version = ticket.version;
      const meta: string[] = [];
      if (ticket.tableLabel !== undefined) meta.push(ticket.tableLabel);
      if (ticket.orderNumber !== undefined) meta.push(`Order ${ticket.orderNumber}`);
      if (ticket.serverName !== undefined) meta.push(ticket.serverName);
      card.meta.replaceChildren(
        h('strong', { class: 'meta-table', text: meta[0] ?? '' }),
        h('span', { class: 'meta-rest', text: meta.slice(1).join(' · ') }),
      );
      card.items.replaceChildren(
        ...ticket.items.map((item) =>
          h(
            'li',
            { class: 'item' },
            h('span', { class: 'item-qty', text: `${String(item.quantity)}×` }),
            h(
              'span',
              { class: 'item-body' },
              h('span', { class: 'item-name', text: item.name }),
              ...(item.modifiers ?? []).map((m) => h('span', { class: 'item-mod', text: m })),
              item.notes === undefined ? null : h('span', { class: 'item-note', text: item.notes }),
            ),
          ),
        ),
        ...(ticket.notes === undefined
          ? []
          : [h('li', { class: 'ticket-note', text: ticket.notes })]),
      );
    }

    const action = nextAction(ticket.status);
    const label = action?.label ?? '';
    setText(card.button, pending === undefined ? label : 'Sending…');
    card.button.hidden = action === null || view.viewOnly === true;
    card.button.disabled = pending !== undefined || !view.online;
    card.button.dataset.locked = view.locked ? 'true' : 'false';
  }
}
