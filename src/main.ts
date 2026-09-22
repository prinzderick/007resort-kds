import './ui/style.css';
import { loadConfig } from './config';
import { emptyBoard } from './state/tickets';
import { renderBoard } from './ui/board';

const root = document.querySelector<HTMLDivElement>('#app');
if (root === null) throw new Error('#app element missing');

const config = loadConfig();
renderBoard(root, config, emptyBoard);

// Phase 0: real-time wiring (createKdsHubConnection + applyEvent) is added in
// Phase 1 once the hub contract is published in 007resort-docs.
