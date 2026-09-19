# Telegram Button Confirmation for UI Stack Switches

## Overview

A stack switch requested from the web UI is confirmed today by tapping a one-time link in a
Telegram message. The link points at `https://100.69.110.112:3443/api/stack/confirm?token=…`,
so the phone that taps it must reach the Mac over Tailscale and accept a self-signed certificate
that carries no Subject Alternative Name. The live test on 2026-09-18 failed on that path, first on
MagicDNS, and the IP-based retest would still meet a certificate warning.

This design replaces the link with **inline keyboard buttons** in the same Telegram message. The
tap travels phone → Telegram → Hermes gateway → PharmaLLM on localhost. Tailscale, DNS and TLS
leave the confirmation path entirely.

## Constraint this design rests on

The app and Hermes share one bot (same `TELEGRAM_BOT_TOKEN`). Telegram allows one `getUpdates`
consumer per bot, and Hermes' gateway is that consumer; a second poller gets `409 Conflict` and
would break Hermes chat. So the app cannot receive the button tap itself. Hermes must.

Hermes 0.21.3 offers a supported way in: a user plugin (`~/.hermes/plugins/<name>/`, enabled via
`plugins.enabled`) can call `ctx.register_telegram_handler(factory)`, and `factory(app, adapter)`
adds a PTB `CallbackQueryHandler`. PTB runs only the first matching handler per group and Hermes
registers a catch-all `CallbackQueryHandler`, so the plugin's handler **must** be scoped with
`pattern=`. Hermes hooks (`~/.hermes/hooks/`) do not fire on button taps and cannot be used.

## Decisions

| Topic | Decision |
|---|---|
| Who receives the tap | A Hermes plugin, `pharmallm-switch`, on the existing bot |
| Buttons | `✅ Switch to <target>` → `pls:ok:<token>`; `✖ Cancel` → `pls:no:<token>` (39 bytes, under Telegram's 64) |
| Link | Removed. No URL in the message, no public-URL configuration |
| Confirm route | `GET /api/stack/confirm` becomes `POST /api/stack/confirm`, **authenticated** (bearer token) |
| Cancel route | New `POST /api/stack/cancel`, authenticated |
| Who may tap | The plugin accepts taps only from `TELEGRAM_ALLOWED_USERS` |
| Plugin → app | `PHARMALLM_URL` (`http://localhost:3000`) and `PHARMALLM_API_TOKEN`, already in `~/.hermes/.env` |
| Hermes down | Refuse up front: the switch is not requested and the UI says why |
| Hermes readiness | Gateway control socket reports `running` + Telegram `connected`, **and** the plugin's ready file matches that gateway's `pid` and `start_time` |
| Confirmation window | Unchanged, 5 minutes |

## Flow

1. The owner picks a stack in the UI → `POST /api/stack/switch {stack}` (unchanged browser route).
2. The app checks, in order: known stack name, Telegram configured, **Hermes ready**, no switch
   already pending or running. A Hermes failure returns
   `409 {reason: "hermes_unavailable", error: "Hermes gateway is down — switch with scripts/switch-stack.sh <stack>"}`.
3. The app creates the pending switch and sends the message with an inline keyboard:
   ```
   PharmaLLM: switch the LLM stack from omlx to mlx?
   Confirm within 5 minutes. If you did not ask for this, tap Cancel or ignore it.
   [ ✅ Switch to mlx ] [ ✖ Cancel ]
   ```
   On a send failure the pending switch is dropped and the route returns `502`, as today.
4. The owner taps. Telegram delivers a `callback_query` to the Hermes gateway; the plugin's
   handler (`pattern=r"^pls:(ok|no):[0-9a-f]{32}$"`) receives it.
5. The plugin checks `query.from_user.id` against `TELEGRAM_ALLOWED_USERS`. A stranger gets
   `query.answer("Not authorised")` and nothing else happens.
6. The plugin calls `POST {PHARMALLM_URL}/api/stack/confirm` or `/cancel` with
   `Authorization: Bearer {PHARMALLM_API_TOKEN}` and body `{"token": "<token>"}`, 10 s timeout.
7. The plugin always answers the query (so the button stops spinning) and edits the message text,
   removing the keyboard:

   | App response | Toast / edited message |
   |---|---|
   | confirm `200 {target}` | `✅ Switching to mlx — PharmaLLM restarts in a moment` |
   | cancel `200` | `✖ Switch cancelled` |
   | `410` (expired, used or unknown token) | `⌛ Expired — request the switch again from PharmaLLM` |
   | `401`, network error, other status | `⚠️ Could not reach PharmaLLM (<status or error class>)` — keyboard kept so a retry is possible within the window |

8. The UI already polls `/api/stack/status`. After a confirm it follows progress as today. After a
   cancel it sees `pending: null` with no progress and reverts at once instead of waiting out the
   countdown.

## App changes

**`src/services/telegram-notify.ts`**: `TelegramSender` becomes
`(text: string, options?: { buttons?: TelegramButton[][] }) => Promise<void>`, where
`TelegramButton` is `{ text: string; callbackData: string }`. With buttons it adds
`reply_markup: { inline_keyboard: [[{ text, callback_data }]] }`. The module comment keeps its rule:
the app never polls. Button taps are Hermes' to receive.

**`src/services/stack-switch.ts`**: adds `cancel(token): PendingSwitch | null`. It has the same
token check as `confirm`, clears the pending switch and spawns nothing.

**`src/services/hermes-readiness.ts`** (new): `createHermesReadiness(deps)` exposes
`check(): Promise<{ ready: true } | { ready: false; reason: string }>`. It depends on two injected
functions:
- `queryGatewayStatus()`: one JSON line `{"verb":"status","v":1}` to `~/.hermes/gateway.sock`,
  2 s timeout, returning the parsed `result` or `null`;
- `readPluginReadyFile()`: parses `~/.hermes/pharmallm-switch.ready.json`, or returns `null`.

Ready means `gateway_state === "running"`, `platforms.telegram.state === "connected"`, and the
ready file's `pid` and `start_time` equal the status result's. A `pid` alone could be reused after
a restart; the pair names exactly one gateway lifetime, so a ready file left by a crashed gateway
fails the check.

**`src/api/stack.ts`**:
- `/switch` sends the buttons and calls the readiness check before `switcher.request`.
- `/confirm` becomes `POST`, reads `token` from the JSON body, answers `200 {status: "switching", target}`
  or `410 {error}` in JSON (no HTML any more).
- New `POST /cancel`: `200 {status: "cancelled", target}` or `410 {error}`.
- `/status` adds `hermes_ready: boolean`, computed by the same readiness check. The UI polls
  `/status`, so the readiness result is cached for 5 s; `/switch` always runs a fresh check.
- Removed: `resolveConfirmBaseUrl`, `PUBLIC_URL_FILE`, `confirmBaseUrl` dep, `PHARMALLM_PUBLIC_URL`.

**`src/api/auth.ts`**: `["GET", "/api/stack/confirm"]` leaves `BROWSER_ROUTES`. Confirm and cancel
are therefore protected by the existing bearer-token rule, with no new code.

**`public/app.js`**: the selector is disabled with a tooltip when `hermes_ready` is false, the same
pattern as `telegram_configured`. It shows the `hermes_unavailable` error text, and when a
pending switch disappears with no progress it shows "Switch cancelled".

**`scripts/switch-stack.sh`**: removes `PUBLIC_URL_FILE`, `public_url()` and the
`PHARMALLM_PUBLIC_URL` export. The leftover `data/run/public-url` is deleted by hand once; nothing
reads it any more.

## Hermes plugin

Source in the repo at `hermes/plugins/pharmallm-switch/`:

- `plugin.yaml`: name, version, description.
- `__init__.py`: `register(ctx)` only calls `ctx.register_telegram_handler(factory)`. The factory
  runs when the gateway's Telegram adapter connects (never in a CLI session, which also loads
  plugins), and there it does two things:
  1. imports PTB and adds `CallbackQueryHandler(handle_tap, pattern=PATTERN)`;
  2. writes `$HERMES_HOME/pharmallm-switch.ready.json` = `{pid, start_time}` of the current
     process. `start_time` is taken the same way the gateway's own pid file records it, so the two
     compare equal; the plan's first task confirms the exact source.
- The HTTP call uses the standard library (`urllib.request` in a thread via `asyncio.to_thread`)
  so the plugin adds no dependency to Hermes' venv.
- Values come from the environment Hermes already loads: `PHARMALLM_URL`,
  `PHARMALLM_API_TOKEN`, `TELEGRAM_ALLOWED_USERS`. Nothing is logged that contains the token.

**Install**: new `scripts/hermes-setup.sh install-plugin` (also run by `all`). It copies the
directory to `~/.hermes/plugins/pharmallm-switch/`, adds `pharmallm-switch` to `plugins.enabled`
in `~/.hermes/config.yaml` when absent (and mirrors that in `hermes/config.template.yaml`), and
restarts the gateway through the existing service-restart path. `status` reports whether the
plugin is installed and whether the ready file matches the running gateway.

## Error handling summary

| Situation | Behaviour |
|---|---|
| Gateway down, Telegram disconnected, or plugin not loaded | `/switch` → 409 `hermes_unavailable`; selector disabled via `hermes_ready: false` |
| Hermes goes down after the message was sent | Tap does nothing; the 5-minute window expires and the UI reverts (existing path) |
| Tap after expiry or second tap | App 410 → "⌛ Expired" |
| Tap from another Telegram user | "Not authorised", app never called |
| App unreachable from the plugin | "⚠️ Could not reach PharmaLLM", keyboard kept |
| Telegram send fails | Pending dropped, 502 (unchanged) |

## Testing

All tests use injected fakes. None touches the real bot, the real gateway socket, `~/.hermes`, or a
running server.

- **Jest**:
  - the sender puts `reply_markup` in the body only when buttons are given;
  - `/switch` sends buttons with the right `callback_data`, returns 409 when readiness fails, and
    sends nothing then;
  - `/confirm` and `/cancel` return 200 or 410 and are protected (`isProtectedRequest` is true);
  - `switcher.cancel` clears without spawning;
  - readiness: running + connected + matching pair means ready, and each mismatch gives its own
    reason (pid differs, start_time differs, file missing, socket null, Telegram disconnected);
  - `/status` exposes `hermes_ready`.
- **pytest** for the plugin, with a fake query object and a fake HTTP function: a
  non-matching `callback_data` is ignored; an unauthorised user never triggers an HTTP call; each
  app response maps to the right answer and edit; the ready file contains the process identity.
- **Live** (owner on the iPad): refusal with the gateway stopped, then a confirm tap, a cancel
  tap, and an expired tap. The results go into the verification doc.

## Out of scope

- A separate bot for switch confirmations.
- Cancelling a pending switch from the web UI (Telegram's Cancel button covers it).
- Fixing the certificate's missing SAN. Still worth doing for iPad mic access, but no longer on
  this path.
