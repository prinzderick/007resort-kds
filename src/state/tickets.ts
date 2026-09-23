/**
 * Client-side DISPLAY state for the KDS board.
 *
 * This store only applies events pushed by the API to a local view model.
 * It does not decide whether a transition is valid, compute prices or touch
 * inventory - the API is authoritative for all of that.
 */

/** PrepTicketStatus from the API contract (openapi/v1.yaml). */
export const TICKET_STATUSES = [
  'NEW',
  'ACCEPTED',
  'IN_PROGRESS',
  'READY',
  'DISPENSED',
  'CANCELLED',
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses after which a ticket leaves the board (served, or voided). */
export const TERMINAL_STATUSES: ReadonlySet<TicketStatus> = new Set(['DISPENSED', 'CANCELLED']);

export interface TicketItem {
  readonly name: string;
  readonly quantity: number;
  /** Modifiers chosen at order time, e.g. "no onions", "extra spicy". */
  readonly modifiers?: readonly string[];
  /** Free-text note for this line. */
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
  /** API `rowVersion`: monotonic per ticket; used to discard stale/duplicate events. */
  readonly version: number;
  readonly items: readonly TicketItem[];
  /** Table / seat / tab label for service staff, e.g. "Table 12". */
  readonly tableLabel?: string;
  /** Human-facing order reference the ticket belongs to. */
  readonly orderNumber?: string;
  /** Waiter who placed the order (`waiterName`). */
  readonly serverName?: string;
  /** Free-text note for the whole ticket. */
  readonly notes?: string;
  /** Server timestamps, when known. */
  readonly acceptedAtUtc?: string;
  readonly readyAtUtc?: string;
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
