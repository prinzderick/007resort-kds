# otueke-kds

Kitchen Display System (KDS) / dispensing client for the **Otueke Integrated
Facility Operations Platform**.

> Status: **Phase 0 - scaffolding only.** The board renders a placeholder;
> real-time wiring and actions arrive in Phase 1.

Architecture, API contracts and decisions live in
[prinzderick/otueke-docs](https://github.com/prinzderick/otueke-docs).

## Decision (pending architecture review)

A **browser-based kiosk client** built with **Vite + TypeScript (strict)** and
**no UI framework**, running full-screen on each KDS station. Real-time updates
come from a **SignalR** hub on the Otueke API (`@microsoft/signalr`). This
choice is provisional until the architecture review is recorded in otueke-docs.

## Stations

| Code                 | Station            |
| -------------------- | ------------------ |
| `MAIN_KITCHEN`       | Main Kitchen       |
| `RESTAURANT_COUNTER` | Restaurant Counter |
| `POOL_BAR`           | Pool Bar           |
| `BUSH_BAR`           | Bush Bar           |

Each screen is configured with one station code. The API routes tickets to
stations; the KDS only displays what it is sent.

## What the KDS does (and does not do)

- Displays tickets routed to its station.
- **Requests** status transitions via the API:
  `CREATED -> ACCEPTED -> IN_PROGRESS -> READY -> DISPENSED / SERVED`.
- The API is **authoritative**: it validates each transition and records the
  staff member and timestamps. The board updates only from server events.
- **No** payment, inventory or pricing logic, and no local validation of
  transitions.
- Every mutating request carries an `Idempotency-Key` header (UUID).

## Real-time

`src/realtime/hub.ts` builds a SignalR connection to `/hubs/kds` (placeholder
path) with automatic reconnect that **never gives up** (backs off to 30 s).
After each reconnect the board must re-fetch a snapshot from the API, since
events may have been missed. `src/state/tickets.ts` is a pure reducer that
applies server events to the local display model (upserts are idempotent by
ticket `version`; `DISPENSED`/`SERVED` tickets leave the board; ordered by
created time).

## Layout

```
src/
  main.ts             entry: load config, render board
  config.ts           VITE_* env parsing
  api/client.ts       fetch wrapper (+ Idempotency-Key on mutations)
  api/idempotency.ts  UUID v4 (falls back when randomUUID is unavailable)
  realtime/hub.ts     SignalR connection factory
  state/tickets.ts    display-state reducer
  ui/board.ts         board rendering (placeholder)
  **/*.test.ts        vitest tests
```

## Setup / run / test

Requirements: Node 24+.

```bash
npm ci
cp .env.example .env.local   # then set the station code
npm run dev                  # http://localhost:5173

npm run typecheck
npm run lint
npm test
npm run build                # static files in dist/
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, format check, tests and
build on Node 24, plus a gitleaks secret scan.

## Configuration

| Variable                   | Default                 | Description                           |
| -------------------------- | ----------------------- | ------------------------------------- |
| `VITE_OTUEKE_API_BASE_URL` | `http://localhost:5080` | Otueke API base URL (no `/api/v1`).   |
| `VITE_KDS_STATION_CODE`    | _(empty)_               | Station code; empty = not configured. |

`VITE_*` values are compiled into the bundle - **never put secrets in them**.
Kiosk authentication (device credentials / tokens) is issued by the API and is
pending design.

## Kiosk deployment notes (draft)

- Serve `dist/` from the property server (or the API host) and open it in a
  browser in kiosk mode, e.g. `chromium --kiosk --noerrdialogs
--disable-session-crashed-bubble <url>`, auto-starting on boot.
- Prefer **HTTPS** on the property network. `crypto.randomUUID` needs a secure
  context; a fallback exists, but SignalR, service workers and other APIs
  behave best over HTTPS.
- Disable screen sleep / screensaver; auto-reload on crash.
- One build per environment; station code per screen (build-time today; may
  move to API device registration after review).

## Staff identification (placeholder)

NFC readers will be attached as **keyboard-wedge** devices: a tap "types" the
card UID followed by Enter. The KDS will capture that input and send it to the
API with the transition request; the **API** resolves the staff member and
records it. Not implemented in Phase 0.

## Conventions

See [CONTRIBUTING.md](CONTRIBUTING.md).
