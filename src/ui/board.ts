import type { KdsConfig } from '../config';
import { visibleTickets, type BoardState } from '../state/tickets';

/**
 * Renders the KDS board. Phase 0 placeholder: shows the configuration state
 * and the tickets currently in the local display store.
 */
export function renderBoard(root: HTMLElement, config: KdsConfig, state: BoardState): void {
  root.replaceChildren();

  const header = document.createElement('header');
  header.className = 'kds-header';
  const title = document.createElement('h1');
  title.textContent =
    config.stationCode === null ? 'KDS — station not configured' : `KDS — ${config.stationCode}`;
  header.append(title);
  root.append(header);

  const board = document.createElement('main');
  board.className = 'kds-board';
  const tickets = visibleTickets(state);
  if (tickets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'kds-empty';
    empty.textContent = config.stationCode === null ? 'Set VITE_KDS_STATION_CODE.' : 'No tickets';
    board.append(empty);
  }
  for (const ticket of tickets) {
    const card = document.createElement('article');
    card.className = 'kds-ticket';
    card.dataset.status = ticket.status;
    const heading = document.createElement('h2');
    heading.textContent = `#${ticket.number} · ${ticket.status}`;
    const list = document.createElement('ul');
    for (const item of ticket.items) {
      const li = document.createElement('li');
      li.textContent = `${String(item.quantity)} × ${item.name}${item.notes ? ` (${item.notes})` : ''}`;
      list.append(li);
    }
    card.append(heading, list);
    board.append(card);
  }
  root.append(board);
}
