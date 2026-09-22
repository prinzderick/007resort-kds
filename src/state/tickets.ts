/**
 * Client-side DISPLAY state for the KDS board.
 *
 * This store only applies events pushed by the API to a local view model.
 * It does not decide whether a transition is valid, compute prices or touch
 * inventory - the API is authoritative for all of that.
 */

export const TICKET_STATUSES = [
  'CREATED',
  'ACCEPTED',
  'IN_PROGRESS',
  'READY',
  'DISPENSED',
  'SERVED',
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses after which a ticket leaves the board. */
export const TERMINAL_STATUSES: ReadonlySet<TicketStatus> = new Set(['DISPENSED', 'SERVED']);

export interface TicketItem {
  readonly name: string;
  readonly quantity: number;
  readonly notes?: string;
}

export interface Ticket {
  readonly id: string;
  /** Human-facing ticket number shown on the board. */
  readonly number: string;
  readonly stationCode: string;
  readonly status: TicketStatus;
  /** ISO-8601 UTC timestamp from the API. */
  readonly createdAtUtc: string;
  /** Monotonic version from the API; used to discard stale/duplicate events. */
  readonly version: number;
  readonly items: readonly TicketItem[];
}

export type TicketEvent =
  | { readonly type: 'snapshot'; readonly tickets: readonly Ticket[] }
  | { readonly type: 'ticketUpserted'; readonly ticket: Ticket }
  | { readonly type: 'ticketRemoved'; readonly ticketId: string };

export interface BoardState {
  readonly tickets: ReadonlyMap<string, Ticket>;
}

export const emptyBoard: BoardState = { tickets: new Map() };

function upsert(map: Map<string, Ticket>, ticket: Ticket): void {
  const existing = map.get(ticket.id);
  if (existing !== undefined && existing.version >= ticket.version) return; // stale or duplicate
  if (TERMINAL_STATUSES.has(ticket.status)) {
    map.delete(ticket.id);
    return;
  }
  map.set(ticket.id, ticket);
}

/** Pure reducer: returns a new state with the event applied. */
export function applyEvent(state: BoardState, event: TicketEvent): BoardState {
  switch (event.type) {
    case 'snapshot': {
      const map = new Map<string, Ticket>();
      for (const ticket of event.tickets) upsert(map, ticket);
      return { tickets: map };
    }
    case 'ticketUpserted': {
      const existing = state.tickets.get(event.ticket.id);
      if (existing !== undefined && existing.version >= event.ticket.version) return state;
      const map = new Map(state.tickets);
      upsert(map, event.ticket);
      return { tickets: map };
    }
    case 'ticketRemoved': {
      if (!state.tickets.has(event.ticketId)) return state;
      const map = new Map(state.tickets);
      map.delete(event.ticketId);
      return { tickets: map };
    }
  }
}

/** Tickets in display order: oldest first, ties broken by id. */
export function visibleTickets(state: BoardState): Ticket[] {
  return [...state.tickets.values()].sort((a, b) => {
    const byTime = Date.parse(a.createdAtUtc) - Date.parse(b.createdAtUtc);
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
}
