// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyEvent, emptyBoard } from '../state/tickets';
import { renderBoard } from './board';

describe('renderBoard', () => {
  it('shows the not-configured placeholder when no station is set', () => {
    const root = document.createElement('div');
    renderBoard(root, { apiBaseUrl: 'http://localhost:5080', stationCode: null }, emptyBoard);
    expect(root.querySelector('h1')?.textContent).toBe('KDS — station not configured');
  });

  it('renders tickets for a configured station', () => {
    const root = document.createElement('div');
    const state = applyEvent(emptyBoard, {
      type: 'ticketUpserted',
      ticket: {
        id: 't1',
        number: '101',
        stationCode: 'POOL_BAR',
        status: 'READY',
        createdAtUtc: '2026-09-22T10:00:00Z',
        version: 1,
        items: [{ name: 'Chapman', quantity: 2 }],
      },
    });
    renderBoard(root, { apiBaseUrl: 'http://localhost:5080', stationCode: 'POOL_BAR' }, state);
    expect(root.querySelector('h1')?.textContent).toBe('KDS — POOL_BAR');
    expect(root.querySelectorAll('.kds-ticket')).toHaveLength(1);
    expect(root.textContent).toContain('2 × Chapman');
  });
});
