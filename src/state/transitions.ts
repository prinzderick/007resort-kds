import type { TicketStatus } from './tickets';

/**
 * Display-side hints for which button a ticket shows. This is NOT validation: the API decides
 * whether a transition is legal (it also allows NEW->IN_PROGRESS and ACCEPTED->READY skips, which
 * the KDS does not offer) and may reject with 409 `order_state_invalid`, which the UI surfaces and
 * reconciles by reloading server truth.
 */

export type BoardColumn = 'NEW' | 'IN_PROGRESS' | 'READY';

export const COLUMNS: readonly { readonly id: BoardColumn; readonly label: string }[] = [
  { id: 'NEW', label: 'New' },
  { id: 'IN_PROGRESS', label: 'In progress' },
  { id: 'READY', label: 'Ready' },
];

/** Statuses the API accepts as a transition target. */
export type TransitionTarget = 'ACCEPTED' | 'IN_PROGRESS' | 'READY' | 'DISPENSED';

export interface NextAction {
  readonly to: TransitionTarget;
  readonly label: string;
}

const NEXT: Partial<Record<TicketStatus, NextAction>> = {
  NEW: { to: 'ACCEPTED', label: 'Accept' },
  ACCEPTED: { to: 'IN_PROGRESS', label: 'Start' },
  IN_PROGRESS: { to: 'READY', label: 'Ready' },
  READY: { to: 'DISPENSED', label: 'Served' },
};

export function nextAction(status: TicketStatus): NextAction | null {
  return NEXT[status] ?? null;
}

export function columnOf(status: TicketStatus): BoardColumn | null {
  switch (status) {
    case 'NEW':
      return 'NEW';
    case 'ACCEPTED':
    case 'IN_PROGRESS':
      return 'IN_PROGRESS';
    case 'READY':
      return 'READY';
    default:
      return null; // terminal: not on the board
  }
}

export function statusLabel(status: TicketStatus): string {
  return status.replace('_', ' ');
}
