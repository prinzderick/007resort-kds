// Tiny Chrome DevTools Protocol driver (no dependencies; Node >= 22 for the global WebSocket/fetch).
// Used by scripts/real-ui-e2e.mjs to drive the built KDS in a real (headless) Chrome and take screenshots.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const CHROME =
  process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let nextPort = 9400 + Math.floor(Math.random() * 300);

export async function launch({ width = 1280, height = 800 } = {}) {
  const port = nextPort++;
  const dir = mkdtempSync(join(tmpdir(), 'kds-chrome-'));
  const proc = spawn(
    CHROME,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let info;
  for (let i = 0; i < 100 && !info; i++) {
    try {
      info = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (!info.find((t) => t.type === 'page')) info = undefined;
    } catch {
      /* not up yet */
    }
    if (!info) await new Promise((r) => setTimeout(r, 100));
  }
  if (!info) throw new Error('Chrome did not start');
  const ws = new WebSocket(info.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const consoleLog = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled')
      consoleLog.push(
        `${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`,
      );
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const page = {
    consoleLog,
    async goto(url) {
      await send('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, 800));
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', {
        expression: `(async()=>{return (${expr})})()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expr, what, ms = 15000) {
      const t0 = Date.now();
      for (;;) {
        try {
          if (await page.eval(expr)) return;
        } catch {
          /* page navigating */
        }
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 150));
      }
    },
    async shot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(data, 'base64'));
    },
    async click(selector, text) {
      const ok = await page.eval(
        `(()=>{const els=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>${text === undefined ? 'true' : `e.textContent.trim()===${JSON.stringify(text)}`});const e=els[0];if(!e)return false;e.click();return true})()`,
      );
      if (!ok) throw new Error(`no element ${selector} ${text ?? ''}`);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* */
      }
      proc.kill();
    },
  };
  return page;
}
