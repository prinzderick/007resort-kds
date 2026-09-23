# KDS vs the REAL local node - test report

Node: `007resort-api` `integration/mvp` (Laravel, `php artisan serve` :8080, Reverb :8081, key `r007-local-key`),
seeded demo data (`work/LOCAL_NODE.md`). KDS: this branch, built bundle served by `vite preview`, driven in headless
Chrome (`scripts/real-ui-e2e.mjs`, DevTools protocol, screenshots in `docs/screenshots/`) plus a vitest suite
(`src/real-node.test.ts`, runs when `R007_API_BASE_URL` is set, skipped otherwise). Real orders were created as `wait1`
(tablet `TABLET_WAITER_01` checked out to RESTAURANT) and `wait2` (Pool Bar) with `scripts/real-order.sh`.

## Results

| Area                                                                                                                                                                                                  | Result                                                                                             | Evidence                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------- |
| Enrolment with a real one-time code (`local-node.sh device-code`)                                                                                                                                     | pass: `r7d_` token stored, device is `KDS_SCREEN` / mode `KDS`                                     | 01-register.png         |
| Enrolment with the seeded token (`r7d_dev_kds_main_kitchen`)                                                                                                                                          | pass                                                                                               | 05-board-live.png       |
| Login staff no. + PIN (`S-0004`/1234), wrong PIN message, retry keeps the staff no.                                                                                                                   | pass (after fix 1)                                                                                 | 02, 03                  |
| Station picker (kitchen1 sees Main Kitchen Pass + Restaurant Bar), choice remembered                                                                                                                  | pass                                                                                               | 04                      |
| Live ticket via Reverb, no reload, about 0.8 s including order creation                                                                                                                               | pass                                                                                               | 06                      |
| Routing: kitchen ticket holds only the food line; Restaurant Bar screen only drinks                                                                                                                   | pass                                                                                               | 06, 08                  |
| Bump ACCEPTED, IN_PROGRESS, READY, DISPENSED with `If-Match`/ETag (`"2"`,`"3"`,`"4"`), server rowVersion checked each step                                                                            | pass                                                                                               | 07-bump-1..4            |
| Stale `If-Match` -> 412 `concurrency_conflict`; missing -> 428; illegal jump -> 409 `order_state_invalid`; replay of the same `Idempotency-Key` -> `Idempotent-Replayed: true`                        | pass                                                                                               | real-node.test.ts, curl |
| Ticket moved by another screen shows up live, no double transition                                                                                                                                    | pass                                                                                               | real-node.test.ts       |
| Reconnect: node restarted with `local-node.sh restart`: "Reconnecting" chip + red read-only banner, buttons disabled, then Live and full reload; an order created during the outage appears           | pass                                                                                               | 13, 14                  |
| Silent socket (Reverb `SIGSTOP`): detected and shown as reconnecting after 28 s, recovers by itself after `SIGCONT`                                                                                   | pass (pusher ping/pong fires before the 75 s watchdog; the watchdog is a second line, unit tested) | 17                      |
| Station isolation: Pool Bar screen offered bars only, never receives restaurant orders, does receive pool orders                                                                                      | pass                                                                                               | 09, 10                  |
| Isolation at the API: bartender1 on kitchen station REST 403, channel auth `private-kds.station.<kitchen>` 403, `private-facility.<restaurant>.orders` 403, own station 200; other device channel 403 | pass                                                                                               | real-node.test.ts       |
| Kiosk forced onto a station the account may not read                                                                                                                                                  | pass after fix 3: back to the picker with "no access"                                              | 11                      |
| View-only user (`kdsview1`, only `prep_ticket.view`): no buttons, header "View only"; API also refuses the transition with 403                                                                        | pass after fix 2                                                                                   | 12                      |
| Idle lock (12 s in the test): identity hidden, board stays live, tap asks to sign in, no API write                                                                                                    | pass                                                                                               | 15, 16                  |
| `site.health`: keep-alive every 30 s received; `cloudLink` ignored                                                                                                                                    | pass after fix 4                                                                                   | real-node.test.ts       |
| Static bundle on a LAN address (python `http.server`) with only `config.json` `VITE_R007_API_BASE_URL`, Reverb host from `/system/info`                                                               | pass (login + station + Live)                                                                      | scripted                |

Counts: UI scenarios 30 checks, vitest real-node 7 tests, mock suite 151 tests; all pass. (The only flake seen was the
staff-login rate limit of 10/min when two full UI runs were done back to back.)

## KDS bugs found and fixed

1. **PIN / card login did not work at all.** The KDS sent `{PIN, secret}` and `{NFC_CARD, secret: uid}` as in the
   contract examples; the real node requires `identifier` (422) and, for `NFC_CARD`, wants `identifier = card UID`,
   `secret = the staff PIN` (card alone never signs in). The login sheet now asks for staff number (or a card tap) and
   the PIN; a card tap identifies the person and the PIN is still entered. The mock now enforces the same rules.
2. **View-only accounts saw active buttons** that only produced a toast. With permissions known and no
   `prep_ticket.transition`, buttons are hidden and the header shows "View only".
3. **403 on a station was treated as an expired session** ("Session expired", signed out, refresh attempted). A 403 on the
   station channel or board load (facility scope) now returns to the station picker with "Your account has no access to
   <station>", still signed in (new `forbidden` connection state).
4. **"Server degraded" banner permanently on a healthy Local node**: `site.health` reports `DEGRADED` whenever the
   `cloudLink` check is not ok, which is normal without a cloud peer. The KDS now derives its status from the local
   checks only (`database`, `redis`, `queue`, ...) and ignores `cloudLink`.

## API-side deviations / notes (document; not needed to run the KDS)

- Fixed in PR https://github.com/prinzderick/007resort-api/pull/12 (branch `fix/kds-problem-status`, base `integration/mvp`):
  the `order_state_invalid` problem for an illegal prep-ticket transition put the ticket status string in the RFC 7807
  `status` member (`"status":"ACCEPTED"`); now `currentStatus`. **The running node needs this only if a client reads
  `status` from problem bodies; the KDS uses the HTTP status, so nothing is blocked. The orchestrator can pick it up with
  the next integration merge.** (Orders/payments use the same key pattern with tests that assert it; left alone.)
- Contract vs node: `POST /auth/staff/login` requires `identifier` for PIN and NFC_CARD, and NFC_CARD = card UID + PIN
  (contract examples show a bare card). `v1.yaml` should be updated.
- `GET /kds/stations` returns `code: null` for all stations (the KDS falls back to the id; names are used on screen).
- Station access is decided by the staff member's facility scope only, not by the device: any KDS device token plus
  a staff member with the scope can open any station in that scope (e.g. the Main Kitchen screen offers Restaurant Bar to
  kitchen1). Channel refusal message says `Missing permission: channel.subscribe` (really a scope failure) - cosmetic.
  Suggested hardening: bind `private-kds.station.*` to the device's home facility.
- No seeded role has `prep_ticket.view` without `prep_ticket.transition`, so the view-only case needs a custom role;
  `scripts/real-viewer-user.sh` adds dev role `KDS_VIEWER` (SQL) and staff `kdsview1` (S-9001, PIN 1234, card `04AABB01`).
- `site.health` arrives in two shapes (keep-alive without `siteId`, availability tracker with `siteId`); both carry
  `data.status` + `data.checks`. With no cloud both report `DEGRADED` (`cloudLink` degraded/down).
- Login throttle is 10 requests/min per client (`X-RateLimit-Limit: 10`); fine for a kiosk, relevant for scripted runs.
- The node was restarted by someone else once during testing (seen as a reconnect in the log); `local-node.sh restart`
  was used by the `reconnect` scenario. No file in `work/api-integration` was edited (git status clean).

## Kiosk deployment recipe: what was verified

Verified here (macOS Chrome, headless, real node): static hosting of `dist/` on a LAN IP by a plain static server, runtime
`config.json` with only the API base URL, Reverb settings from `/system/info`, persistent profile (localStorage keeps
device token + station across reloads), enrolment by one-time code, idle lock, reconnect. NOT verified on real hardware
(no Windows or Android device here): the Windows `chrome.exe --kiosk ...` shortcut, Edge `--edge-kiosk-type`, Fully Kiosk /
screen pinning on Android and HTTPS/WSS. Those command lines in the README are the standard flags and unchanged from the
earlier draft. Points to check on first device install: Android cleartext HTTP to the LAN node (Chrome allows http pages;
Fully Kiosk too), autoplay of the chime (`--autoplay-policy=no-user-gesture-required` / Fully Kiosk "autoplay with sound"),
and the kiosk profile must be persistent.
