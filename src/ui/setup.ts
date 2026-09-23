import type { Station } from '../api/dto';
import { h } from './dom';

/** Station picker: big touch buttons; the choice is remembered per device by the app. */
export class SetupScreen {
  readonly el: HTMLElement;
  private readonly list = h('div', { class: 'station-grid' });
  private readonly msg = h('p', { class: 'setup-msg', role: 'status' });

  private readonly handlers: {
    readonly onPick: (station: Station) => void;
    readonly onRetry: () => void;
  };

  constructor(handlers: {
    readonly onPick: (station: Station) => void;
    readonly onRetry: () => void;
  }) {
    this.handlers = handlers;
    this.el = h(
      'main',
      { class: 'setup' },
      h('h1', { text: 'Which station is this screen?' }),
      h('p', {
        class: 'setup-sub',
        text: 'The choice is remembered on this device. You can change it later from the menu.',
      }),
      this.msg,
      this.list,
    );
  }

  update(stations: readonly Station[] | null, error: string | null): void {
    this.list.replaceChildren();
    if (error !== null) {
      this.msg.textContent = error;
      this.list.append(
        h('button', {
          class: 'btn primary big',
          text: 'Try again',
          onClick: () => {
            this.handlers.onRetry();
          },
        }),
      );
      return;
    }
    if (stations === null) {
      this.msg.textContent = 'Loading stations…';
      return;
    }
    this.msg.textContent = stations.length === 0 ? 'No stations are configured on the server.' : '';
    for (const s of stations) {
      this.list.append(
        h('button', {
          class: 'station-btn',
          text: s.name,
          data: { stationId: s.id },
          onClick: () => {
            this.handlers.onPick(s);
          },
        }),
      );
    }
  }
}
