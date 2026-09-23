#!/usr/bin/env node
// Drives the BUILT KDS (default http://localhost:5190, `npx vite preview --port 5190`) in headless Chrome against
// the REAL local node and saves screenshots to docs/screenshots/. Manual/dev tool (not part of CI).
//   R007_API_BASE_URL=http://127.0.0.1:8080 KDS_URL=http://localhost:5190 node scripts/real-ui-e2e.mjs [scenario ...]
// Scenarios: register login live bump station isolation viewonly reconnect idle stale
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launch } from './cdp.mjs';

const KDS = process.env.KDS_URL ?? 'http://localhost:5190';
const API = (process.env.R007_API_BASE_URL ?? 'http://127.0.0.1:8080') + '/api/v1';
const REPOS = fileURLToPath(new URL('../../', import.meta.url)); // .../repos/work/
const NODE_SH = `${REPOS}api-integration/scripts/local-node.sh`;
const SHOTS = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const KITCHEN = '9ac72d5b-5285-55ed-92a1-f4528a7debbc',
  RBAR = 'a04b0443-92a2-5109-912a-09f2d108b558',
  POOL = '7c1ec1bc-7abb-5a45-a6c2-06ca888f3fe0';
const want = process.argv.slice(2);
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const order = (kind, qty = 1) =>
  execFileSync(`${REPOS}kds/scripts/real-order.sh`, [kind, String(qty)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

async function api(path, { token, device, method = 'GET', body, headers = {} } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Idempotency-Key': `e2e-${Math.random()}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(device ? { 'X-Device-Token': device } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json, etag: r.headers.get('etag') };
}
const login = async (who, device) =>
  (
    await api('/auth/staff/login', {
      device,
      method: 'POST',
      body: { credentialType: 'PIN', identifier: who, secret: '1234' },
    })
  ).json.accessToken;

const board = (p) =>
  p.eval(
    `[...document.querySelectorAll('.card')].map(c=>({t:c.dataset.ticket,n:c.querySelector('.card-number')?.textContent,s:c.querySelector('.card-status')?.textContent,col:c.closest('.col')?.dataset.column,btn:(()=>{const b=c.querySelector('.bump');return b&&!b.hidden?b.textContent:null})(),items:[...c.querySelectorAll('.item-name')].map(e=>e.textContent)}))`,
  );
const chip = (p) => p.eval(`document.querySelector('.chip')?.textContent`);
const banner = (p) =>
  p.eval(
    `(()=>{const b=document.querySelector('.banner');return b&&!b.hidden?b.textContent:null})()`,
  );
async function pinLogin(p, staffNo, pin = '1234') {
  await p.waitFor(`!document.querySelector('[aria-label="Staff sign-in"]').hidden`, 'login sheet');
  await p.eval(
    `(()=>{const w=document.querySelector('.login-who');w.value=${JSON.stringify(staffNo)};})()`,
  );
  for (const d of pin) await p.click('.pad-key', d);
  await p.click('.login-panel .btn.primary.big', 'Sign in');
}
async function openKds(p, deviceToken, deviceId, extra = {}) {
  await p.goto(KDS);
  await p.eval(
    `(()=>{localStorage.clear();localStorage.setItem('r007.kds.device',JSON.stringify({id:${JSON.stringify(deviceId)},token:${JSON.stringify(deviceToken)}}));${Object.entries(
      extra,
    )
      .map(
        ([k, v]) =>
          `localStorage.setItem(${JSON.stringify('r007.kds.' + k)},${JSON.stringify(JSON.stringify(v))});`,
      )
      .join('')}})()`,
  );
  await p.goto(KDS);
}
const DEV = {
  kitchen: ['r7d_dev_kds_main_kitchen', '12c5c733-2b18-555d-a1a3-ede6f991e925'],
  pool: ['r7d_dev_kds_pool_bar', null],
  rbar: ['r7d_dev_kds_restaurant_counter', null],
};
async function deviceId(token) {
  return null;
}
async function kitchenScreen(
  p,
  staffNo = 'S-0004',
  station = { id: KITCHEN, code: KITCHEN, name: 'Main Kitchen Pass' },
) {
  await openKds(p, DEV.kitchen[0], DEV.kitchen[1], { station });
  await pinLogin(p, staffNo);
  await p.waitFor(`document.querySelector('.chip')?.textContent==='Live'`, 'Live chip');
}
async function run(name, fn) {
  if (want.length && !want.includes(name)) return;
  console.log(`\n== ${name}`);
  const p = await launch();
  try {
    await fn(p);
  } catch (e) {
    check(`${name}: ${e.message}`, false);
    await p.shot(`${SHOTS}error-${name}.png`).catch(() => {});
  } finally {
    p.close();
  }
}

await run('register', async (p) => {
  const code = execFileSync(NODE_SH, ['device-code', 'MAIN_KITCHEN'], { encoding: 'utf8' }).match(
    /R7-[A-Z0-9]+-[A-Z0-9]+/,
  )[0];
  await p.goto(KDS);
  await p.eval(`localStorage.clear()`);
  await p.goto(KDS);
  await p.waitFor(`document.body.innerText.includes('Register this screen')`, 'register screen');
  await p.shot(`${SHOTS}01-register.png`);
  await p.eval(
    `(()=>{const [n,c]=document.querySelectorAll('.register input');n.value='KDS e2e '+Date.now();c.value=${JSON.stringify(code)};document.querySelector('.register').requestSubmit()})()`,
  );
  await p.waitFor(`localStorage.getItem('r007.kds.device')`, 'device stored');
  const dev = JSON.parse(await p.eval(`localStorage.getItem('r007.kds.device')`));
  check('real registration code -> device token (r7d_...)', dev.token.startsWith('r7d_'));
  const me = await api(`/devices/${dev.id}`, { device: dev.token });
  check(
    'registered as KDS_SCREEN / mode KDS',
    me.json.kind === 'KDS_SCREEN' && me.json.mode === 'KDS',
    JSON.stringify({ kind: me.json.kind, mode: me.json.mode }),
  );
  await p.waitFor(`!document.querySelector('[aria-label="Staff sign-in"]').hidden`, 'login sheet');
  await p.shot(`${SHOTS}02-login-staffno-pin.png`);
});

await run('login', async (p) => {
  await openKds(p, ...DEV.kitchen);
  await pinLogin(p, 'S-0004', '9999'); // wrong PIN
  await p.waitFor(`document.querySelector('.login-error')?.textContent`, 'error text');
  check(
    'wrong PIN shows "Not recognised"',
    (await p.eval(`document.querySelector('.login-error').textContent`)).includes('Not recognised'),
  );
  await p.shot(`${SHOTS}03-login-wrong-pin.png`);
  for (const d of '1234') await p.click('.pad-key', d); // staff no. is kept
  await p.click('.login-panel .btn.primary.big', 'Sign in');
  await p.waitFor(`document.querySelectorAll('.station-btn').length>0`, 'station picker');
  const names = await p.eval(
    `[...document.querySelectorAll('.station-btn')].map(b=>b.textContent)`,
  );
  check(
    'station picker lists only kitchen1 stations',
    names.length === 2 && names.some((n) => n.includes('Main Kitchen')),
    names.join(', '),
  );
  await p.shot(`${SHOTS}04-station-picker.png`);
  await p.click('.station-btn', 'Main Kitchen Pass');
  await p.waitFor(`document.querySelector('.chip')?.textContent==='Live'`, 'Live');
  await p.shot(`${SHOTS}05-board-live.png`);
  check(
    'device remembered the station',
    (await p.eval(`localStorage.getItem('r007.kds.station')`)).includes(KITCHEN),
  );
});

await run('live', async (p) => {
  await kitchenScreen(p);
  const before = (await board(p)).length;
  const t0 = Date.now();
  const orderId = order('both', 2);
  await p.waitFor(`document.querySelectorAll('.card').length>${before}`, 'new ticket', 8000);
  check(
    'ticket appears in real time (no reload)',
    true,
    `${Date.now() - t0} ms incl. order creation`,
  );
  const cards = await board(p);
  const fresh =
    cards.find((c) => /Jollof/.test(c.items[0] ?? '') && c.col === 'NEW') ?? cards.at(-1);
  check(
    'kitchen ticket holds only the food line (drink routed to the bar)',
    fresh.items.length === 1 && /Jollof/.test(fresh.items[0]),
    fresh.items.join('|'),
  );
  check(
    'new ticket sits in NEW with an Accept button',
    fresh.col === 'NEW' && fresh.btn === 'Accept',
  );
  await p.shot(`${SHOTS}06-live-ticket-arrived.png`);
  globalThis.__order = orderId;
});

await run('bump', async (p) => {
  await kitchenScreen(p);
  const before = new Set((await board(p)).map((c) => c.t));
  order('both', 1);
  await p.waitFor(
    `[...document.querySelectorAll('.card')].some(c=>!${JSON.stringify([...before])}.includes(c.dataset.ticket))`,
    'new ticket',
  );
  const id = (await board(p)).find((c) => !before.has(c.t)).t;
  const kt = await login('kitchen1', DEV.kitchen[0]);
  const version = async () =>
    await api(`/prep-tickets/${id}`, { token: kt, device: DEV.kitchen[0] });
  let n = 0;
  for (const [label, status, col] of [
    ['Accept', 'ACCEPTED', 'IN_PROGRESS'],
    ['Start', 'IN_PROGRESS', 'IN_PROGRESS'],
    ['Ready', 'READY', 'READY'],
  ]) {
    await p.eval(`document.querySelector('.card[data-ticket="${id}"] .bump').click()`);
    await p.waitFor(
      `document.querySelector('.card[data-ticket="${id}"] .card-status')?.textContent==='${status.replace('_', ' ')}'`,
      status,
      8000,
    );
    const srv = await version();
    check(
      `${label}: server status ${status}, rowVersion ${srv.json.rowVersion}, ETag ${srv.etag}`,
      srv.json.status === status && srv.etag === `"${srv.json.rowVersion}"`,
    );
    check(`${label}: card in column ${col}`, (await board(p)).find((c) => c.t === id).col === col);
    await p.shot(`${SHOTS}07-bump-${++n}-${status.toLowerCase()}.png`);
  }
  await p.eval(`document.querySelector('.card[data-ticket="${id}"] .bump').click()`);
  await p.waitFor(
    `!document.querySelector('.card[data-ticket="${id}"]')`,
    'served leaves board',
    8000,
  );
  let done = await version();
  for (let i = 0; i < 20 && done.json.status !== 'DISPENSED'; i++) {
    await sleep(250);
    done = await version();
  }
  check(
    'Served: DISPENSED on the server and gone from the board',
    done.json.status === 'DISPENSED',
    `${done.status} ${done.json.status ?? JSON.stringify(done.json).slice(0, 120)}`,
  );
  const ord = await api(`/orders/${done.json.orderId}`, {
    token: kt,
    device: DEV.kitchen[0],
  }).catch(() => null);
  await p.shot(`${SHOTS}07-bump-4-served.png`);
});

await run('station', async (p) => {
  // Restaurant Bar screen: staff kitchen1 has RESTAURANT scope; sees only the drink ticket.
  const pb = await launch();
  try {
    await openKds(p, DEV.kitchen[0], DEV.kitchen[1], {
      station: { id: RBAR, code: RBAR, name: 'Restaurant Bar' },
    });
    await pinLogin(p, 'S-0004');
    await p.waitFor(`document.querySelector('.chip')?.textContent==='Live'`, 'bar live');
    const oid = order('both', 1);
    await p.waitFor(
      `[...document.querySelectorAll('.item-name')].some(e=>/Star/.test(e.textContent))`,
      'bar ticket',
      8000,
    );
    const items = (await board(p)).flatMap((c) => c.items);
    check(
      'Restaurant Bar screen shows drinks only (no Jollof)',
      items.some((i) => /Star/.test(i)) && !items.some((i) => /Jollof/.test(i)),
      items.join('|'),
    );
    await p.shot(`${SHOTS}08-station-restaurant-bar.png`);
  } finally {
    pb.close();
  }
});

await run('isolation', async (p) => {
  // Pool Bar screen with bartender1 (POOL_BAR scope)
  const rd = await api('/devices?limit=100', {
    token: await login('itadmin1', 'r7d_dev_pos_reception_1'),
    device: 'r7d_dev_pos_reception_1',
  });
  const poolDev = rd.json.items.find(
    (d) => d.name?.includes('Pool') && d.kind === 'KDS_SCREEN',
  )?.id;
  await openKds(p, 'r7d_dev_kds_pool_bar', poolDev);
  await pinLogin(p, 'S-0003');
  await p.waitFor(`document.querySelectorAll('.station-btn').length>0`, 'picker');
  const names = await p.eval(
    `[...document.querySelectorAll('.station-btn')].map(b=>b.textContent)`,
  );
  check(
    'Pool Bar bartender is offered bars only',
    !names.some((n) => /Kitchen/.test(n)) && names.some((n) => /Pool/.test(n)),
    names.join(', '),
  );
  await p.shot(`${SHOTS}09-isolation-picker-poolbar.png`);
  await p.click('.station-btn', 'Pool Bar');
  await p.waitFor(`document.querySelector('.chip')?.textContent==='Live'`, 'pool live');
  const before = (await board(p)).length;
  order('both', 1);
  await sleep(2500); // kitchen + restaurant bar tickets, none for the pool bar
  check(
    'Pool Bar screen does not receive the restaurant order',
    (await board(p)).length === before,
  );
  order('pool', 1);
  await p.waitFor(`document.querySelectorAll('.card').length>${before}`, 'pool ticket', 8000);
  check('Pool Bar screen does receive a pool order', true);
  await p.shot(`${SHOTS}10-isolation-poolbar-board.png`);
  // wrong station forced into localStorage: API refuses -> board stays empty / error
  const bt = await login('bartender1', 'r7d_dev_kds_pool_bar');
  const t = await api(`/kds/stations/${KITCHEN}/tickets`, {
    token: bt,
    device: 'r7d_dev_kds_pool_bar',
  });
  check(
    'REST: kitchen tickets for bartender1 -> 403 permission_denied',
    t.status === 403 && t.json.code === 'permission_denied',
    `${t.status} ${t.json.detail}`,
  );
  const sock = await fetch(`${API}/broadcasting/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bt}`,
      'X-Device-Token': 'r7d_dev_kds_pool_bar',
    },
    body: JSON.stringify({ socket_id: '1.2', channel_name: `private-kds.station.${KITCHEN}` }),
  });
  check(
    'channel auth: bartender1 on private-kds.station.<kitchen> -> 403',
    sock.status === 403,
    String(sock.status),
  );
  const ok = await fetch(`${API}/broadcasting/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bt}`,
      'X-Device-Token': 'r7d_dev_kds_pool_bar',
    },
    body: JSON.stringify({ socket_id: '1.2', channel_name: `private-kds.station.${POOL}` }),
  });
  check(
    'channel auth: bartender1 on private-kds.station.<pool> -> 200',
    ok.status === 200,
    String(ok.status),
  );
  // forced wrong station in the kiosk
  await openKds(p, 'r7d_dev_kds_pool_bar', poolDev, {
    station: { id: KITCHEN, code: KITCHEN, name: 'Main Kitchen Pass' },
  });
  await pinLogin(p, 'S-0003');
  await sleep(3500);
  await p.waitFor(`document.querySelectorAll('.station-btn').length>0`, 'back at the picker', 8000);
  const forced = await p.eval(
    `({toast:document.querySelector('.toast')?.textContent??'',btns:[...document.querySelectorAll('.station-btn')].map(b=>b.textContent),cards:document.querySelectorAll('.card').length,auth:document.documentElement.dataset.auth||document.querySelector('[data-auth]')?.dataset.auth})`,
  );
  check(
    'kiosk forced onto the kitchen station: no kitchen tickets, told "no access", back at picker, still signed in',
    forced.cards === 0 &&
      /no access/.test(forced.toast) &&
      !forced.btns.some((b) => /Kitchen/.test(b)) &&
      forced.auth === 'active',
    JSON.stringify(forced),
  );
  await p.shot(`${SHOTS}11-isolation-forced-wrong-station.png`);
});

await run('viewonly', async (p) => {
  const r = spawnSync(`${REPOS}kds/scripts/real-viewer-user.sh`, { encoding: 'utf8' });
  check('view-only dev user exists', r.status === 0, r.stdout.trim().split('\n').at(-1));
  order('food', 1);
  await kitchenScreen(p, 'S-9001');
  await sleep(500);
  const cards = await board(p);
  check(
    'view-only user sees tickets but no action buttons',
    cards.length > 0 && cards.every((c) => c.btn === null),
  );
  check(
    'header says View only',
    (await p.eval(`document.querySelector('.hdr-staff').textContent`)).includes('View only'),
  );
  await p.shot(`${SHOTS}12-view-only.png`);
  const vt = await login('kdsview1', DEV.kitchen[0]);
  const id = cards[0].t;
  const cur = await api(`/prep-tickets/${id}`, { token: vt, device: DEV.kitchen[0] });
  const tr = await api(`/prep-tickets/${id}/transition`, {
    token: vt,
    device: DEV.kitchen[0],
    method: 'POST',
    body: { to: 'ACCEPTED' },
    headers: { 'If-Match': cur.etag },
  });
  check(
    'API also refuses the transition (403 permission_denied)',
    tr.status === 403 && tr.json.code === 'permission_denied',
    tr.json.detail,
  );
});

await run('reconnect', async (p) => {
  await kitchenScreen(p);
  const n0 = (await board(p)).length;
  console.log('  restarting the node ...');
  const rs = spawnSync(NODE_SH, ['restart'], { encoding: 'utf8' });
  await p.waitFor(`document.querySelector('.chip')?.textContent!=='Live'`, 'leaves Live', 20000);
  const seen = await chip(p);
  check(
    'socket loss is shown ("Reconnecting"), banner explains read-only',
    /Reconnect/.test(seen) && /RECONNECTING/.test((await banner(p)) ?? ''),
    `${seen} / ${(await banner(p))?.slice(0, 40)}`,
  );
  await p.shot(`${SHOTS}13-reconnecting.png`);
  const bump = await p.eval(
    `(()=>{const b=document.querySelector('.bump');return b?b.disabled:null})()`,
  );
  check('actions are disabled while reconnecting', bump === true || bump === null);
  for (let i = 0; i < 60; i++) {
    if ((await api('/system/info')).status === 200) break;
    await sleep(1000);
  }
  order('food', 1); // created while the kiosk may still be backing off: must be picked up by the resync
  await p.waitFor(`document.querySelector('.chip')?.textContent==='Live'`, 'back to Live', 60000);
  await p.waitFor(
    `document.querySelectorAll('.card').length>${n0}`,
    'ticket created during outage',
    20000,
  );
  check('after reconnect the board is fully reloaded (missed order shown)', true);
  await p.shot(`${SHOTS}14-reconnected.png`);
});

await run('idle', async (p) => {
  const cfgPath = fileURLToPath(new URL('../dist/config.json', import.meta.url));
  const old = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '{}';
  writeFileSync(cfgPath, JSON.stringify({ VITE_KDS_IDLE_LOCK_SECONDS: 12 }));
  try {
    await kitchenScreen(p);
    await p.waitFor(
      `document.querySelector('.hdr-staff').textContent.startsWith('Locked')`,
      'idle lock',
      25000,
    );
    check(
      'idle lock after 12 s: identity hidden, board still visible',
      (await board(p)).length > 0,
    );
    await p.shot(`${SHOTS}15-idle-locked.png`);
    const n = (await board(p)).length;
    order('food', 1);
    await p.waitFor(`document.querySelectorAll('.card').length>${n}`, 'ticket while locked', 8000);
    check('locked board keeps receiving live tickets', true);
    await p.eval(`document.querySelector('.bump').click()`);
    await p.waitFor(
      `!document.querySelector('[aria-label="Staff sign-in"]').hidden`,
      'sign-in prompt',
    );
    check('tapping a button while locked asks for sign-in (no API write)', true);
    await p.shot(`${SHOTS}16-locked-tap-prompts-login.png`);
  } finally {
    writeFileSync(cfgPath, old);
  }
});

await run('stale', async (p) => {
  await kitchenScreen(p);
  const pid = execFileSync('pgrep', ['-f', 'reverb:start'], { encoding: 'utf8' })
    .trim()
    .split('\n')[0];
  console.log(`  freezing Reverb (pid ${pid}) with SIGSTOP: TCP stays open but silent`);
  execFileSync('kill', ['-STOP', pid]);
  const t0 = Date.now();
  try {
    await p.waitFor(
      `document.querySelector('.chip')?.textContent!=='Live'`,
      'stale detection',
      100000,
    );
    const secs = Math.round((Date.now() - t0) / 1000);
    check(
      `silent socket detected and shown as reconnecting within ${secs} s`,
      secs <= 80,
      `${secs}s`,
    );
    await p.shot(`${SHOTS}17-stale-socket.png`);
  } finally {
    execFileSync('kill', ['-CONT', pid]);
  }
  await p.waitFor(
    `document.querySelector('.chip')?.textContent==='Live'`,
    'recovers after SIGCONT',
    60000,
  );
  check('recovers by itself when Reverb is back', true);
});

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
