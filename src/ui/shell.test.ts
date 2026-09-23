// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { KdsApp } from '../app';
import { harness, STATION, ticket, type Harness } from '../test/fakes';
import { mountShell, type Shell } from './shell';

let shell: Shell | null = null;
afterEach(() => {
  shell?.destroy();
  shell = null;
  document.body.innerHTML = '';
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function mount(h: Harness) {
  const root = document.createElement('div');
  document.body.append(root);
  const app = new KdsApp(h.deps);
  app.boot();
  shell = mountShell(root, app);
  return { root, app };
}
const q = (root: HTMLElement, sel: string) => root.querySelector<HTMLElement>(sel);

describe('shell', () => {
  it('asks to register an unregistered screen (no sign-in yet)', () => {
    const h = harness();
    h.storage.setDevice(null);
    const { root } = mount(h);
    expect(root.textContent).toContain('Register this screen');
    expect(q(root, '[aria-label="Staff sign-in"]')?.hidden).toBe(true);
  });

  it('shows the blocking sign-in for a registered screen', () => {
    const { root } = mount(harness());
    expect(q(root, '[aria-label="Staff sign-in"]')?.hidden).toBe(false);
  });

  it('station setup: lists stations after sign-in and remembers the pick', async () => {
    const h = harness();
    const { root, app } = mount(h);
    await app.login({ credentialType: 'PIN', identifier: 'S-0004', secret: '1234' });
    await flush();
    expect(q(root, '.setup')?.textContent).toContain('Which station is this screen?');
    q(root, '.station-btn')?.click();
    expect(q(root, '.board')).not.toBeNull();
    expect(q(root, '.hdr-station')?.textContent).toBe('Main Kitchen');
    expect(h.storage.station()?.id).toBe(STATION.id);
  });

  it('live board, then a clear RECONNECTING banner with last-known data and disabled actions', async () => {
    const h = harness({}, (s) => {
      s.setStation({ ...STATION });
    });
    h.api.listTickets.mockResolvedValue([ticket({ id: 'a', tableLabel: 'Table 4' })]);
    const { root, app } = mount(h);
    await app.login({ credentialType: 'PIN', identifier: 'S-0004', secret: '1234' });
    h.rt.handlers.onState('online');
    h.rt.handlers.onSubscribed();
    await flush();
    expect(q(root, '.chip')?.textContent).toBe('Live');
    expect(q(root, '.banner')?.hidden).toBe(true);
    expect(q(root, '.card')?.textContent).toContain('Table 4');

    h.rt.handlers.onState('reconnecting');
    expect(q(root, '.chip')?.textContent).toBe('Reconnecting…');
    expect(q(root, '.banner')?.hidden).toBe(false);
    expect(q(root, '.banner')?.textContent).toMatch(/RECONNECTING - showing last known board/);
    expect(q(root, '.card')?.textContent).toContain('Table 4'); // still there, read-only
    expect(q(root, '.bump')?.hasAttribute('disabled')).toBe(true);

    h.rt.handlers.onState('online');
    h.rt.handlers.onSubscribed();
    await flush();
    expect(q(root, '.banner')?.hidden).toBe(true);
  });

  it('idle lock: board stays, header offers sign-in, tapping a bump opens the sheet', async () => {
    const h = harness({}, (s) => {
      s.setStation({ ...STATION });
    });
    h.api.listTickets.mockResolvedValue([ticket({ id: 'a' })]);
    const { root, app } = mount(h);
    await app.login({ credentialType: 'PIN', identifier: 'S-0004', secret: '1234' });
    h.rt.handlers.onState('online');
    h.rt.handlers.onSubscribed();
    await flush();
    app.lock();
    expect(q(root, '.hdr-staff')?.textContent).toBe('Locked · Sign in');
    expect(q(root, '.card')).not.toBeNull();
    expect(q(root, '[aria-label="Staff sign-in"]')?.hidden).toBe(true);
    q(root, '.bump')?.click();
    await flush();
    expect(q(root, '[aria-label="Staff sign-in"]')?.hidden).toBe(false);
  });

  it('degraded server health is shown', async () => {
    const h = harness({}, (s) => {
      s.setStation({ ...STATION });
    });
    const { root, app } = mount(h);
    await app.login({ credentialType: 'PIN', identifier: 'S-0004', secret: '1234' });
    h.rt.handlers.onState('online');
    h.rt.handlers.onSubscribed();
    h.rt.handlers.onSiteHealth?.('DEGRADED');
    await flush();
    expect(q(root, '.chip')?.textContent).toBe('Server degraded');
  });
});
