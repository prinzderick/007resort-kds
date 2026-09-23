# 007resort-kds

Kitchen / bar display (KDS) client for the **007 Resort & Spa Integrated Facility Operations
Platform**: a static, framework-free **Vite + TypeScript** browser app that runs full-screen (kiosk)
on each prep station and talks to the Laravel API (`/api/v1`) over REST plus **Laravel Reverb**
(Pusher protocol) through `laravel-echo` + `pusher-js`.

Architecture, API contract and decisions live in
[prinzderick/007resort-docs](https://github.com/prinzderick/007resort-docs)
(`architecture/08, 13, 15`, `adr/0006`, `adr/0012`, `api/openapi/v1.yaml`, `api/realtime.md`).

## What it does

- **Device enrolment** (once per screen): the IT admin issues a one-time registration code;
  `POST /devices/register` (`kind: KDS_SCREEN`) returns a `deviceToken`, kept in this browser's
  localStorage and sent as `X-Device-Token` on every request. PIN / NFC logins only work from a
  registered device.
- **Station setup**: pick the station once (`GET /kds/stations`); it is remembered per device.
  Change it later from the menu (needs a signed-in staff member).
- **Staff sign-in**: **staff number (or username) + PIN** on the on-screen pad or a physical
  keyboard, **card + PIN** with an NFC reader as keyboard wedge (a fast burst of characters ending in
  Enter is read as the card UID; the PIN is still required), or username + password. The real node
  never accepts a bare PIN or a bare card (`identifier` is required; for `NFC_CARD` the identifier is
  the card UID and the secret the staff PIN), see `docs/REAL_API_TEST_REPORT.md`.
  A signed-in account without `prep_ticket.transition` is **view-only** (no buttons, labelled).
  Access tokens (about 15 min) are refreshed automatically (single-flight, rotating refresh token).
  **Auto-lock after idle** (`VITE_KDS_IDLE_LOCK_SECONDS`): the board stays visible and live but is
  read-only; tapping a button asks for sign-in.
- **Board**: columns NEW / IN PROGRESS (accepted + in progress) / READY; large touch targets;
  table, order number, waiter, items, modifiers/notes; **elapsed-time colouring** (amber/red at
  configurable thresholds, per device via the menu or build/runtime config; timers use the server
  clock via `/system/info`); **chime on new tickets** (WebAudio, mutable).
- **Bump actions**: `NEW -> ACCEPTED -> IN_PROGRESS -> READY -> DISPENSED` via
  `POST /prep-tickets/{id}/transition {to}` with `Idempotency-Key` and `If-Match`. The card shows an
  optimistic "pending" state; the API is authoritative: on rejection (e.g. `order_state_invalid`,
  `concurrency_conflict`) the reason is shown, the card reverts and the board is reloaded.
- **Realtime + recovery** (per `api/realtime.md`): private channels `kds.station.{id}`,
  `site.status`, `device.{id}`; events deduped by `eventId`; **a full REST reload on every
  (re)subscription**; reconnect with exponential backoff + jitter (1 s to 30 s, forever); stale-socket
  watchdog (75 s without `site.health`); REST polling every 10 s while the socket is down.
- **Offline** (`architecture/13`): read-only last-known board (also cached across page reloads), a
  clear red **RECONNECTING** banner, actions disabled until live updates are back. The KDS never
  queues changes.
- No business logic: no pricing, inventory, or transition validation on the client.

## Run it without the backend (mock server)

```bash
npm ci
npm run build          # optional: lets the mock also serve the UI
npm run mock           # API + Pusher socket + UI on http://localhost:5080
```

Open <http://localhost:5080>. Demo data:

| What              | Value                                                                |
| ----------------- | -------------------------------------------------------------------- |
| Registration code | `KDS-1234` (reusable in the mock)                                    |
| Staff             | PIN `1234` (Chef Ada, can bump), PIN `5678` (view only)              |
| NFC card          | `04A1B2C3` (type it fast + Enter, or via a wedge reader)             |
| Password          | user `kds`, password `kds-pass`                                      |
| Stations          | Main Kitchen, Restaurant Counter, Pool Bar, Bush Bar (seeded boards) |

The mock follows the contract (`Idempotency-Key`, `If-Match`/ETag, single-use refresh tokens,
private-channel HMAC auth, `site.health` keep-alive) and creates a ticket every 25 s. Env:
`MOCK_PORT` (5080), `MOCK_HOST`, `MOCK_SIMULATE_SECONDS` (25, 0 = off), `MOCK_REVERB_PORT`
(optional second socket port), `MOCK_STATIC_DIR` (`dist`). Demo controls (POST):

```bash
curl -X POST localhost:5080/mock/tickets                 # new ticket at a random station
curl -X POST localhost:5080/mock/drop-sockets            # kill sockets -> KDS reconnects + reloads
curl -X POST 'localhost:5080/mock/outage?seconds=15'     # API + socket down: RECONNECTING banner
curl -X POST localhost:5080/mock/expire-tokens           # forces a transparent token refresh
curl -X POST localhost:5080/mock/device-command -d '{"command":"LOCK"}'   # FORCE_LOGOUT | REFRESH_STATE | REVOKE
curl -X POST localhost:5080/mock/reset                   # reseed
```

For frontend development against the mock: `npm run mock` in one terminal, `npm run dev` in
another with `.env.local` copied from `.env.example` (it already points at the mock).

## Configuration

Compile-time `VITE_*` variables (see `.env.example`) **or** a runtime `config.json` served next to
`index.html` with the same keys (e.g. `{"VITE_KDS_WARN_MINUTES": "4"}`), which lets one static build
serve both the Local and Cloud nodes. None of these values are secret.

| Variable                     | Default                 | Description                                                |
| ---------------------------- | ----------------------- | ---------------------------------------------------------- |
| `VITE_R007_API_BASE_URL`     | `http://localhost:5080` | API base (no `/api/v1`). `origin` = the page's own origin. |
| `VITE_R007_REVERB_HOST`      | API host                | Reverb host.                                               |
| `VITE_R007_REVERB_PORT`      | `8081`                  | Reverb port.                                               |
| `VITE_R007_REVERB_SCHEME`    | from API URL            | `http` or `https` (`https` uses `wss`).                    |
| `VITE_R007_REVERB_KEY`       | `r007-local-key`        | Public Reverb app key. **Never** the secret.               |
| `VITE_KDS_STATION_CODE`      | _(empty)_               | Optional preset; normally chosen on the setup screen.      |
| `VITE_KDS_WARN_MINUTES`      | `5`                     | Ticket turns amber.                                        |
| `VITE_KDS_LATE_MINUTES`      | `10`                    | Ticket turns red.                                          |
| `VITE_KDS_IDLE_LOCK_SECONDS` | `120`                   | Idle auto-lock (0 = never).                                |
| `VITE_KDS_RESYNC_SECONDS`    | `300`                   | Safety-net reload while connected (0 = off).               |

If none of the four `REVERB_*` values is set, the Reverb host/port/scheme/key the node advertises in
`GET /api/v1/system/info` (`realtime`) are used.

## Deployment (static bundle on the local node)

```bash
npm ci && npm run build          # -> dist/ (relative asset URLs; serve from / or any sub-path)
```

Copy `dist/` to the local node's web server (nginx/Caddy/IIS or the Laravel `public/` tree, e.g.
`public/kds/`). Recommended: serve it on the **same origin** as the API (proxy `/api` and the Reverb
socket) and set `VITE_R007_API_BASE_URL=origin` in `config.json`; this avoids CORS. If it is served
from a different origin, the API must allow CORS for `Authorization`, `Idempotency-Key`,
`If-Match`, `X-Device-Token`, `X-Correlation-Id` and expose `ETag`. Prefer HTTPS/WSS on the
property network; over plain HTTP `crypto.randomUUID` is unavailable (a fallback exists) and
browsers restrict some APIs.

Verified recipe (macOS Chrome against the real node, see `docs/REAL_API_TEST_REPORT.md`): the bundle
can be served by any static server on the LAN, e.g. `python3 -m http.server 5191 --bind 0.0.0.0` in
`dist/`, with a runtime `dist/config.json` such as
`{"VITE_R007_API_BASE_URL":"http://<node-lan-ip>:8080"}`. No Reverb setting is needed: the socket
host/port/key come from `GET /system/info` (`realtime`), which echoes the host the kiosk called.
The node answers CORS preflights for all headers the KDS sends.

### Kiosk mode

**Windows** (fixed display; create a shortcut or Task Scheduler "at log on" entry):

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --noerrdialogs ^
  --disable-session-crashed-bubble --disable-infobars --no-first-run ^
  --autoplay-policy=no-user-gesture-required --disable-pinch --overscroll-history-navigation=0 ^
  --user-data-dir=C:\kds-profile http://kds-server.local/kds/
```

Use Edge (`msedge.exe --kiosk <url> --edge-kiosk-type=fullscreen`) if Chrome is not installed.
Put the shortcut in `shell:startup`, disable sleep and screen saver, and set Windows to auto-login
the kiosk user. `--autoplay-policy=...` lets the new-ticket chime play without a first tap.

**Android tablets/TV boxes**: Chrome cannot run `--kiosk`; use a kiosk launcher (Fully Kiosk
Browser, or Android screen pinning / a managed-device kiosk profile) pointed at the URL, with
"keep screen on" and autoplay-with-sound enabled.

**Linux/Raspberry Pi**: `chromium --kiosk --noerrdialogs --disable-session-crashed-bubble
--autoplay-policy=no-user-gesture-required http://kds-server.local/kds/`.

Each screen is enrolled once (registration code) and picks its station once; both survive reloads
and restarts because they live in the kiosk profile's localStorage, so keep a **persistent
`--user-data-dir`** and do not clear site data.

## Testing against the real node

`npm test` uses the mock. To run the same flows against the REAL local node (Laravel + Reverb):

```bash
R007_API_BASE_URL=http://127.0.0.1:8080 npm test -- real-node     # skipped when the variable is unset
scripts/real-viewer-user.sh                                      # optional: creates view-only user kdsview1 (dev DB)
npm run build && npx vite preview --port 5190 &                  # then, in headless Chrome + screenshots:
node scripts/real-ui-e2e.mjs [register login live bump station isolation viewonly reconnect idle stale]
scripts/real-order.sh [food|drink|both|pool] [qty]               # send a real order as wait1/wait2
```

The staff login endpoint is rate limited (10/min): do not run every UI scenario twice in a row.
`reconnect` restarts the node and `stale` freezes Reverb for ~30 s, so run them only when nobody
else is using it.

## Development

Requirements: Node 24+.

```bash
npm ci
npm run dev            # http://localhost:5173
npm run typecheck && npm run lint && npm run format:check
npm test               # vitest (jsdom for UI, node for the mock integration tests)
npm run build          # static files in dist/
```

Layout:

```
src/
  main.ts                 entry: config, wiring
  app.ts                  controller: enrolment, sessions, reload, optimistic bump, offline
  config.ts               VITE_* + runtime config.json
  api/                    client (fetch, Idempotency-Key, If-Match, refresh), dto mapping
  realtime/               Echo/Reverb transport, backoff, watchdog, dedupe
  state/                  tickets (pure reducer), elapsed (ageing), transitions (button hints)
  auth/                   idle-lock timer, NFC keyboard-wedge classifier
  device/storage.ts       per-device settings, board cache
  ui/                     board (keyed DOM), login, setup, register, shell, sound, css
mock/                     mock API + Pusher-protocol server (`npm run mock`)
```

`src/integration.test.ts` runs the real client, real Laravel Echo and pusher-js against the mock
over a real WebSocket (live tickets, bump, illegal transition, dropped socket -> full reload,
outage, token refresh, device command).

CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, tests, build, a mock-server
smoke test of the built bundle, and a gitleaks secret scan on Node 24.

## Conventions

See [CONTRIBUTING.md](CONTRIBUTING.md).
