import { describe, expect, it } from 'vitest';
import { applyEvent, emptyBoard, visibleTickets, type Ticket } from './tickets';

function ticket(overrides: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket {
  return {
    number: overrides.id,
    stationCode: 'MAIN_KITCHEN',
    status: 'CREATED',
    createdAtUtc: '2026-09-22T10:00:00Z',
    version: 1,
    items: [{ name: 'Jollof rice', quantity: 1 }],
    ...overrides,
  };
}

describe('ticket store', () => {
  it('orders tickets by created time (oldest first), ties by id', () => {
    let state = emptyBoard;
    state = applyEvent(state, {
      type: 'ticketUpserted',
      ticket: ticket({ id: 'c', createdAtUtc: '2026-09-22T10:05:00Z' }),
    });
    state = applyEvent(state, {
      type: 'ticketUpserted',
      ticket: ticket({ id: 'b', createdAtUtc: '2026-09-22T10:00:00Z' }),
    });
    state = applyEvent(state, {
      type: 'ticketUpserted',
      ticket: ticket({ id: 'a', createdAtUtc: '2026-09-22T10:00:00Z' }),
    });
    expect(visibleTickets(state).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('upsert is idempotent: duplicate or stale versions are ignored', () => {
    const v2 = ticket({ id: 't1', status: 'ACCEPTED', version: 2 });
    let state = applyEvent(emptyBoard, { type: 'ticketUpserted', ticket: v2 });
    const again = applyEvent(state, { type: 'ticketUpserted', ticket: v2 });
    expect(again).toBe(state);

    state = applyEvent(state, {
      type: 'ticketUpserted',
      ticket: ticket({ id: 't1', status: 'CREATED', version: 1 }),
    });
    expect(state.tickets.get('t1')?.status).toBe('ACCEPTED');

    state = applyEvent(state, {
      type: 'ticketUpserted',
      ticket: ticket({ id: 't1', status: 'IN_PROGRESS', version: 3 }),
    });
    expect(state.tickets.size).toBe(1);
    expect(state.tickets.get('t1')?.status).toBe('IN_PROGRESS');
  });

  it.each(['DISPENSED', 'SERVED'] as const)('%s tickets leave the board', (status) => {
    let state = applyEvent(emptyBoard, { type: 'ticketUpserted', ticket: ticket({ id: 't1' }) });
    state = applyEvent(state, {
      type: 'ticketUpserted',
      ticket: ticket({ id: 't1', status, version: 2 }),
    });
    expect(visibleTickets(state)).toEqual([]);
  });

  it('does not re-add a served ticket from a late, older event', () => {
    let state = applyEvent(emptyBoard, {
      type: 'ticketUpserted',
      ticket: ticket({ id: 't1', status: 'READY', version: 4 }),
    });
    state = applyEvent(state, {
      type: 'ticketUpserted',
      ticket: ticket({ id: 't1', status: 'SERVED', version: 5 }),
    });
    expect(state.tickets.has('t1')).toBe(false);
    // NOTE: once removed, the store has no memory of the version; after a
    // reconnect the board re-fetches a snapshot from the API instead.
  });

  it('removes tickets on ticketRemoved and ignores unknown ids', () => {
    const state = applyEvent(emptyBoard, { type: 'ticketUpserted', ticket: ticket({ id: 't1' }) });
    const removed = applyEvent(state, { type: 'ticketRemoved', ticketId: 't1' });
    expect(removed.tickets.size).toBe(0);
    expect(applyEvent(removed, { type: 'ticketRemoved', ticketId: 'nope' })).toBe(removed);
  });

  it('snapshot replaces the board and drops terminal tickets', () => {
    const state = applyEvent(
      applyEvent(emptyBoard, { type: 'ticketUpserted', ticket: ticket({ id: 'old' }) }),
      {
        type: 'snapshot',
        tickets: [ticket({ id: 'x' }), ticket({ id: 'y', status: 'DISPENSED' })],
      },
    );
    expect([...state.tickets.keys()]).toEqual(['x']);
  });

  it('does not mutate the previous state', () => {
    const before = emptyBoard;
    applyEvent(before, { type: 'ticketUpserted', ticket: ticket({ id: 't1' }) });
    expect(before.tickets.size).toBe(0);
  });
});
