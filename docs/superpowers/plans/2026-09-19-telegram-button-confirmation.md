# Telegram Button Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm or cancel a UI-requested stack switch with inline Telegram buttons handled by a Hermes plugin, replacing the one-time link that needed Tailscale and TLS.

**Architecture:** The app keeps sending the message through the shared bot, now with two inline buttons (`pls:ok:<token>`, `pls:no:<token>`). Hermes' gateway, the bot's only `getUpdates` consumer, routes the tap to a pattern-scoped `CallbackQueryHandler` registered by a new plugin. The plugin calls the app on localhost with the API token. Before sending, the app refuses unless the gateway's control socket says it is running and connected, and the plugin's ready file carries that same gateway's pid and start time.

**Tech Stack:** TypeScript (Node 22, Express, Jest via `npm run test`), Bash, Python 3.11 stdlib (`unittest`, `urllib`) inside Hermes 0.21.3 with python-telegram-bot 22.8.

**Spec:** `docs/superpowers/specs/2026-09-19-telegram-button-confirmation-design.md`

## Global Constraints

- TypeScript strict, ES modules, interfaces over type aliases, no `any` (use `unknown` + type guards), camelCase functions, kebab-case files.
- Code comments in English; match the comment density of the file you edit.
- Tests never touch live services: no real bot, no `~/.hermes`, no real `gateway.sock`, no running PharmaLLM. Every path and I/O function is injected. Test-owned sockets and HTTP servers in a temp dir are fine.
- Never print or log the bot token, the API token or a switch token.
- Callback data: `pls:ok:<token>` confirms, `pls:no:<token>` cancels; handler pattern `^pls:(ok|no):[0-9a-f]{32}$`.
- Confirmation window stays 5 minutes (`CONFIRM_WINDOW_MS`).
- Plugin name `pharmallm-switch`; ready file `$HERMES_HOME/pharmallm-switch.ready.json` = `{"pid": <int>, "start_time": <int>}`.
- Readiness cache for `/status`: 5 s. `/switch` always checks fresh.
- Hermes must run on the same Mac as the app (control socket is local). The two-Mac setup gets `hermes_unavailable`; say so in the docs.
- Run `npm run typecheck` after every code change (CLAUDE.md). Commits use `feat:`/`fix:`/`refactor:`/`test:`/`docs:` and end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Do not touch `.env` files or `/legacy`.

## File Structure

| File | Responsibility |
|---|---|
| `src/services/telegram-notify.ts` (modify) | Send a message, optionally with an inline keyboard |
| `src/services/stack-switch.ts` (modify) | Pending-switch state; adds `cancel` and `lastCancelled` |
| `src/services/hermes-readiness.ts` (create) | Can Hermes receive the button tap? Socket query, ready-file read, pure evaluation, 5 s cache |
| `src/api/stack.ts` (modify) | Routes: `/switch` sends buttons after readiness, `POST /confirm`, `POST /cancel`, `/status` gains `hermes_ready`, `hermes_reason`, `cancelled` |
| `src/api/auth.ts` (modify) | Drop the open `GET /api/stack/confirm` entry |
| `src/services/switch-labels.ts` + `public/app.js` (modify) | Selector disabled when Hermes is not ready; UI notices a cancel |
| `scripts/switch-stack.sh` (modify) | Remove the public-URL machinery |
| `hermes/plugins/pharmallm-switch/{plugin.yaml,__init__.py,tap.py}` (create) | The Hermes plugin: PTB glue in `__init__.py`, pure logic in `tap.py` |
| `hermes/tests/test_pharmallm_switch.py` (create) | stdlib `unittest` for the plugin |
| `scripts/hermes-setup.sh`, `hermes/config.template.yaml` (modify) | `install-plugin`, enable the plugin, `check` reports it |
| `README.md`, `hermes/README.md` (modify) | Docs |

---

### Task 1: Telegram sender can attach buttons

**Files:**
- Modify: `src/services/telegram-notify.ts`
- Test: `__tests__/telegram-notify.test.ts`

**Interfaces:**
- Produces: `interface TelegramButton { text: string; callbackData: string }`, `interface TelegramSendOptions { buttons?: TelegramButton[][] }`, `TelegramSender = (text: string, options?: TelegramSendOptions) => Promise<void>`.

- [ ] **Step 1: Write the failing test.** Add inside `describe("createTelegramSender", …)`:

```ts
  it("attaches an inline keyboard when buttons are given", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (_url: string, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return { ok: true, status: 200, text: async () => "{}" };
    };

    const send = createTelegramSender({ botToken: BOT_TOKEN, chatId: CHAT_ID }, fetchImpl);
    await send("switch?", {
      buttons: [[{ text: "✅ Switch to mlx", callbackData: "pls:ok:abc" }, { text: "✖ Cancel", callbackData: "pls:no:abc" }]],
    });

    expect(bodies[0]).toEqual({
      chat_id: CHAT_ID,
      text: "switch?",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: "✅ Switch to mlx", callback_data: "pls:ok:abc" }, { text: "✖ Cancel", callback_data: "pls:no:abc" }]],
      },
    });
  });
```

- [ ] **Step 2: Run it and check that it fails.** Run `npm run test -- __tests__/telegram-notify.test.ts`. Expected: FAIL (a TS error about the second argument, or `reply_markup` missing).

- [ ] **Step 3: Implement.** In `src/services/telegram-notify.ts`, replace the module comment's second line so it reads `// allowed consumer of that bot's getUpdates stream, so button taps are Hermes' to receive (pharmallm-switch plugin).`. Replace the `TelegramSender` interface and the body construction:

```ts
export interface TelegramButton {
  text: string;
  callbackData: string;
}

export interface TelegramSendOptions {
  // Rows of inline keyboard buttons; a tap reaches Hermes' gateway, never this app
  buttons?: TelegramButton[][];
}

export interface TelegramSender {
  (text: string, options?: TelegramSendOptions): Promise<void>;
}
```

and in `createTelegramSender`:

```ts
  return async (text: string, options?: TelegramSendOptions) => {
    if (!isTelegramConfigured(config)) {
      throw new TelegramError("telegram is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)");
    }
    const payload: Record<string, unknown> = { chat_id: config.chatId, text, disable_web_page_preview: true };
    if (options?.buttons && options.buttons.length > 0) {
      payload.reply_markup = {
        inline_keyboard: options.buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.callbackData }))),
      };
    }
    let response: TelegramResponse;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
```

(the rest of the function is unchanged).

- [ ] **Step 4: Run the tests and typecheck.** Run `npm run test -- __tests__/telegram-notify.test.ts && npm run typecheck`. Expected: all PASS, no type errors.

- [ ] **Step 5: Commit.**

```bash
git add src/services/telegram-notify.ts __tests__/telegram-notify.test.ts
git commit -m "feat: let the Telegram sender attach inline buttons

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Switch state machine can cancel

**Files:**
- Modify: `src/services/stack-switch.ts`
- Test: `__tests__/stack-switch.test.ts`

**Interfaces:**
- Produces: `interface CancelledSwitch { id: string; target: StackName }`; `StackSwitch.cancel(token: string): PendingSwitch | null`; `StackSwitch.lastCancelled(): CancelledSwitch | null`. The most recent cancel is kept until the next accepted `request`.

- [ ] **Step 1: Write the failing tests.** Append to `__tests__/stack-switch.test.ts` (it uses the file's existing `harness()` helper):

```ts
describe("cancel", () => {
  it("clears the pending switch without starting it and remembers which request was cancelled", () => {
    const h = harness();
    const outcome = h.switcher.request("omlx");
    if (!outcome.ok) throw new Error("request refused");

    const cancelled = h.switcher.cancel(outcome.pending.token);

    expect(cancelled?.target).toBe("omlx");
    expect(h.switcher.pending()).toBeNull();
    expect(h.switcher.lastCancelled()).toEqual({ id: outcome.pending.id, target: "omlx" });
    expect(h.switcher.confirm(outcome.pending.token)).toBeNull();
  });

  it("ignores a wrong token and leaves the pending switch alone", () => {
    const h = harness();
    h.switcher.request("omlx");

    expect(h.switcher.cancel("nope")).toBeNull();
    expect(h.switcher.pending()?.target).toBe("omlx");
    expect(h.switcher.lastCancelled()).toBeNull();
  });

  it("refuses an expired token", () => {
    const h = harness();
    const outcome = h.switcher.request("omlx");
    if (!outcome.ok) throw new Error("request refused");
    h.clock.value += CONFIRM_WINDOW_MS;

    expect(h.switcher.cancel(outcome.pending.token)).toBeNull();
  });

  it("forgets the last cancel once a new switch is requested", () => {
    const h = harness();
    const first = h.switcher.request("omlx");
    if (!first.ok) throw new Error("request refused");
    h.switcher.cancel(first.pending.token);

    h.switcher.request("mlx");

    expect(h.switcher.lastCancelled()).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and check that they fail.** Run `npm run test -- __tests__/stack-switch.test.ts`. Expected: FAIL, `cancel is not a function` (or TS errors).

- [ ] **Step 3: Implement.** In `src/services/stack-switch.ts`, change the first comment line to `// Pending stack switches: a UI request becomes a one-time token, confirmed or cancelled out of band through Telegram.`, add after `PendingSwitch`:

```ts
// The most recently cancelled request, so the browser that asked can tell a cancel from a confirm
export interface CancelledSwitch {
  id: string;
  target: StackName;
}
```

extend the interface:

```ts
export interface StackSwitch {
  request(target: StackName): SwitchOutcome;
  confirm(token: string): PendingSwitch | null;
  cancel(token: string): PendingSwitch | null;
  lastCancelled(): CancelledSwitch | null;
  pending(): PendingSwitch | null;
}
```

In `createStackSwitch`, add `let cancelled: CancelledSwitch | null = null;` under `let current`. In `request`, set `cancelled = null;` on the line before `const requestedAt = deps.now();`. Add after `confirm`:

```ts
    cancel(token) {
      const pending = live();
      if (!pending || pending.token !== token) return null;
      current = null;
      cancelled = { id: pending.id, target: pending.target };
      return pending;
    },

    lastCancelled() {
      return cancelled;
    },
```

- [ ] **Step 4: Run the tests and typecheck.** Run `npm run test -- __tests__/stack-switch.test.ts && npm run typecheck`. Expected: PASS. (`__tests__/stack-routes.test.ts` still compiles: it only calls `createStackSwitch`.)

- [ ] **Step 5: Commit.**

```bash
git add src/services/stack-switch.ts __tests__/stack-switch.test.ts
git commit -m "feat: let a pending stack switch be cancelled

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Hermes readiness check

**Files:**
- Create: `src/services/hermes-readiness.ts`
- Test: `__tests__/hermes-readiness.test.ts`

**Interfaces:**
- Produces:
  - `interface HermesReadiness { ready: boolean; reason: string }` (`reason` is `""` when ready)
  - `evaluateReadiness(status: unknown, readyFile: unknown): HermesReadiness`
  - `queryGatewayStatus(socketPath: string, timeoutMs?: number): Promise<unknown>` returns the socket's `result` object or `null`
  - `readPluginReadyFile(path: string): unknown` returns the parsed JSON or `null`
  - `interface HermesReadinessDeps { queryGatewayStatus(): Promise<unknown>; readPluginReadyFile(): unknown; now(): number }`
  - `interface HermesReadinessChecker { check(): Promise<HermesReadiness>; cached(): Promise<HermesReadiness> }`
  - `createHermesReadiness(deps: HermesReadinessDeps): HermesReadinessChecker`
  - `hermesHome(env?: NodeJS.ProcessEnv): string`, `READINESS_CACHE_MS = 5000`

Facts this rests on (verified against Hermes 0.21.3): the socket `~/.hermes/gateway.sock` takes one JSON line `{"verb":"status","v":1}` and answers one line `{"ok":true,"result":{…,"pid":64827,"start_time":178967358296,"gateway_state":"running","platforms":{"telegram":{"state":"connected",…}}}}`, then closes.

- [ ] **Step 1: Write the failing tests.** Create `__tests__/hermes-readiness.test.ts`:

```ts
import { afterEach, describe, expect, it } from "@jest/globals";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHermesReadiness,
  evaluateReadiness,
  hermesHome,
  queryGatewayStatus,
  READINESS_CACHE_MS,
  readPluginReadyFile,
} from "../src/services/hermes-readiness.js";

const RUNNING = {
  pid: 4242,
  start_time: 777,
  gateway_state: "running",
  platforms: { telegram: { state: "connected" } },
};
const READY_FILE = { pid: 4242, start_time: 777 };

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hr-"));
  dirs.push(dir);
  return dir;
}

// A test-owned stand-in for Hermes' control socket: answers one line, then closes (or stays silent)
async function fakeGateway(reply: string | null): Promise<string> {
  const path = join(tempDir(), "g.sock");
  const server = createServer((socket) => {
    socket.once("data", () => {
      if (reply !== null) socket.end(`${reply}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  servers.push(server);
  return path;
}

describe("evaluateReadiness", () => {
  it("is ready when the gateway runs, Telegram is connected and the plugin was loaded by this gateway", () => {
    expect(evaluateReadiness(RUNNING, READY_FILE)).toEqual({ ready: true, reason: "" });
  });

  it("names each way it can fail", () => {
    expect(evaluateReadiness(null, READY_FILE).reason).toMatch(/gateway is not running/);
    expect(evaluateReadiness({ ...RUNNING, gateway_state: "draining" }, READY_FILE).reason).toMatch(/draining/);
    expect(
      evaluateReadiness({ ...RUNNING, platforms: { telegram: { state: "retrying" } } }, READY_FILE).reason
    ).toMatch(/not connected to Telegram/);
    expect(evaluateReadiness(RUNNING, null).reason).toMatch(/plugin is not loaded/);
    expect(evaluateReadiness(RUNNING, { pid: 4242, start_time: 1 }).reason).toMatch(/earlier gateway process/);
    expect(evaluateReadiness(RUNNING, { pid: 1, start_time: 777 }).reason).toMatch(/earlier gateway process/);
    expect(evaluateReadiness({ ...RUNNING, pid: undefined }, READY_FILE).ready).toBe(false);
  });
});

describe("queryGatewayStatus", () => {
  it("sends the status verb and returns the result object", async () => {
    const path = await fakeGateway(JSON.stringify({ ok: true, protocol: 1, result: RUNNING }));
    expect(await queryGatewayStatus(path)).toEqual(RUNNING);
  });

  it("returns null when nothing listens, the reply is not ok, or the gateway stays silent", async () => {
    expect(await queryGatewayStatus(join(tempDir(), "absent.sock"))).toBeNull();
    expect(await queryGatewayStatus(await fakeGateway(JSON.stringify({ ok: false })))).toBeNull();
    expect(await queryGatewayStatus(await fakeGateway("not json"))).toBeNull();
    expect(await queryGatewayStatus(await fakeGateway(null), 100)).toBeNull();
  });
});

describe("readPluginReadyFile", () => {
  it("parses the file, or returns null when it is missing or broken", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "ok.json"), JSON.stringify(READY_FILE));
    writeFileSync(join(dir, "bad.json"), "{");
    expect(readPluginReadyFile(join(dir, "ok.json"))).toEqual(READY_FILE);
    expect(readPluginReadyFile(join(dir, "bad.json"))).toBeNull();
    expect(readPluginReadyFile(join(dir, "missing.json"))).toBeNull();
  });
});

describe("createHermesReadiness", () => {
  it("serves cached() from memory for 5 s but always re-queries on check()", async () => {
    const clock = { value: 0 };
    let queries = 0;
    const readiness = createHermesReadiness({
      queryGatewayStatus: async () => {
        queries += 1;
        return RUNNING;
      },
      readPluginReadyFile: () => READY_FILE,
      now: () => clock.value,
    });

    expect((await readiness.cached()).ready).toBe(true);
    clock.value = READINESS_CACHE_MS - 1;
    await readiness.cached();
    expect(queries).toBe(1);
    await readiness.check();
    expect(queries).toBe(2);
    clock.value += READINESS_CACHE_MS;
    await readiness.cached();
    expect(queries).toBe(3);
  });
});

describe("hermesHome", () => {
  it("honours HERMES_HOME and falls back to ~/.hermes", () => {
    expect(hermesHome({ HERMES_HOME: "/x/h" })).toBe("/x/h");
    expect(hermesHome({})).toMatch(/\.hermes$/);
  });
});
```

- [ ] **Step 2: Run them and check that they fail.** Run `npm run test -- __tests__/hermes-readiness.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** Create `src/services/hermes-readiness.ts`:

```ts
// Can the Hermes gateway receive a stack-switch button tap? The app shares Hermes' bot and Hermes is
// its only update consumer, so the tap reaches us only through the pharmallm-switch plugin. Ready
// means the gateway runs, Telegram is connected, and the plugin's ready file names this very gateway
// process: pid and start time together, since a pid alone can be reused after a crash.

import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const READINESS_CACHE_MS = 5000;

export interface HermesReadiness {
  ready: boolean;
  reason: string;
}

export interface HermesReadinessDeps {
  queryGatewayStatus(): Promise<unknown>;
  readPluginReadyFile(): unknown;
  now(): number;
}

export interface HermesReadinessChecker {
  check(): Promise<HermesReadiness>;
  cached(): Promise<HermesReadiness>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function evaluateReadiness(status: unknown, readyFile: unknown): HermesReadiness {
  const gateway = asRecord(status);
  if (!gateway) return { ready: false, reason: "the Hermes gateway is not running" };
  if (gateway.gateway_state !== "running") {
    return { ready: false, reason: `the Hermes gateway is ${String(gateway.gateway_state ?? "in an unknown state")}` };
  }
  const telegram = asRecord(asRecord(gateway.platforms)?.telegram);
  if (telegram?.state !== "connected") return { ready: false, reason: "Hermes is not connected to Telegram" };
  const plugin = asRecord(readyFile);
  if (!plugin) {
    return { ready: false, reason: "the pharmallm-switch plugin is not loaded (scripts/hermes-setup.sh install-plugin)" };
  }
  if (typeof gateway.pid !== "number" || plugin.pid !== gateway.pid || plugin.start_time !== gateway.start_time) {
    return { ready: false, reason: "the pharmallm-switch plugin was loaded by an earlier gateway process; restart the gateway" };
  }
  return { ready: true, reason: "" };
}

// One request per connection, as Hermes' control socket expects; any failure reads as "not running"
export function queryGatewayStatus(socketPath: string, timeoutMs = 2000): Promise<unknown> {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const socket = createConnection({ path: socketPath });
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on("connect", () => socket.write(`${JSON.stringify({ verb: "status", v: 1 })}\n`));
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf-8");
    });
    socket.on("error", () => finish(null));
    socket.on("end", () => {
      try {
        const reply = asRecord(JSON.parse(data) as unknown);
        finish(reply?.ok === true ? (reply.result ?? null) : null);
      } catch {
        finish(null);
      }
    });
    socket.on("close", () => finish(null));
  });
}

export function readPluginReadyFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

export function hermesHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
}

export function createHermesReadiness(deps: HermesReadinessDeps): HermesReadinessChecker {
  let memo: { at: number; value: HermesReadiness } | null = null;

  const check = async (): Promise<HermesReadiness> => {
    const value = evaluateReadiness(await deps.queryGatewayStatus(), deps.readPluginReadyFile());
    memo = { at: deps.now(), value };
    return value;
  };

  return {
    check,
    async cached() {
      if (memo && deps.now() - memo.at < READINESS_CACHE_MS) return memo.value;
      return check();
    },
  };
}
```

- [ ] **Step 4: Run the tests and typecheck.** Run `npm run test -- __tests__/hermes-readiness.test.ts && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/services/hermes-readiness.ts __tests__/hermes-readiness.test.ts
git commit -m "feat: check that Hermes can receive the switch confirmation

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Routes send buttons, confirm and cancel by POST

**Files:**
- Modify: `src/api/stack.ts`, `src/api/auth.ts`
- Test: `__tests__/stack-routes.test.ts`, `__tests__/auth.test.ts`

**Interfaces:**
- Consumes: `TelegramSendOptions` (Task 1), `StackSwitch.cancel` / `lastCancelled` (Task 2), `HermesReadinessChecker`, `createHermesReadiness`, `queryGatewayStatus`, `readPluginReadyFile`, `hermesHome` (Task 3).
- Produces (HTTP):
  - `POST /api/stack/switch` → `202 {status:"pending_confirmation", id, target, expires_at}`; new refusal `409 {reason:"hermes_unavailable", error}`.
  - `POST /api/stack/confirm {token}` (bearer) → `200 {status:"switching", target}` | `410 {error}`.
  - `POST /api/stack/cancel {token}` (bearer) → `200 {status:"cancelled", target}` | `410 {error}`.
  - `GET /api/stack/status` adds `hermes_ready: boolean`, `hermes_reason: string`, `cancelled: {id, target} | null`.
- `StackRouterDeps` loses `confirmBaseUrl` and gains `hermes: HermesReadinessChecker`. `resolveConfirmBaseUrl` is deleted.

- [ ] **Step 1: Rewrite the route tests.** In `__tests__/stack-routes.test.ts`:
  1. Change the import line to `import { createStackRouter } from "../src/api/stack.js";`, add `import type { TelegramSendOptions } from "../src/services/telegram-notify.js";`, and delete the `mkdtempSync, rmSync, writeFileSync`, `tmpdir` and `join` imports if nothing else uses them. Delete `BOT_MESSAGE_TOKEN_PATTERN`.
  2. Replace the `Fixture` interface and `startApp` with:

```ts
interface SentMessage {
  text: string;
  options?: TelegramSendOptions;
}

interface Fixture {
  url: string;
  messages: SentMessage[];
  spawned: StackName[];
  state: {
    active: StackName;
    benchmark: boolean;
    jobs: string[];
    progress: SwitchProgress | null;
    configured: boolean;
    sendFails: boolean;
    sendFailMessage: string;
    hermesReady: boolean;
  };
}

async function startApp(): Promise<Fixture> {
  const state = {
    active: "ollama" as StackName,
    benchmark: false,
    jobs: [] as string[],
    progress: null as SwitchProgress | null,
    configured: true,
    sendFails: false,
    sendFailMessage: "telegram sendMessage failed (401)",
    hermesReady: true,
  };
  const messages: SentMessage[] = [];
  const spawned: StackName[] = [];
  let counter = 0;
  const switcher = createStackSwitch({
    now: () => Date.now(),
    newId: () => `id-${++counter}`,
    newToken: () => `tok-${counter}`,
    activeStack: () => state.active,
    isBenchmarkActive: () => state.benchmark,
    runningJobs: () => state.jobs,
    // Same underlying state readProgress() below reads, matching the production wiring in
    // src/api/stack.ts (both the route and the state machine read the one progress file).
    currentProgress: () => state.progress,
  });
  const readiness = async () =>
    state.hermesReady ? { ready: true, reason: "" } : { ready: false, reason: "the Hermes gateway is not running" };
  const app = express();
  app.use(express.json());
  app.use(
    "/api/stack",
    createStackRouter({
      switcher,
      sendTelegram: async (text: string, options?: TelegramSendOptions) => {
        if (state.sendFails) throw new Error(state.sendFailMessage);
        messages.push({ text, options });
      },
      spawnSwitch: (target: StackName) => {
        spawned.push(target);
      },
      activeStack: () => state.active,
      readProgress: () => state.progress,
      telegramConfigured: () => state.configured,
      hermes: { check: readiness, cached: readiness },
    })
  );
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, messages, spawned, state };
}

// The token rides in the buttons' callback data, never in the text
function tokenFrom(message: SentMessage): string {
  const data = message.options?.buttons?.[0]?.[0]?.callbackData ?? "";
  return data.replace(/^pls:ok:/, "");
}

async function answer(url: string, action: "confirm" | "cancel", body: unknown) {
  const res = await fetch(`${url}/api/stack/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
```

  3. Replace the first `it(…)` in `describe("POST /api/stack/switch")` with:

```ts
  it("accepts a switch and sends one message with Switch and Cancel buttons, no link, and starts nothing yet", async () => {
    const fixture = await startApp();

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(202);
    expect(body.status).toBe("pending_confirmation");
    expect(body.id).toBe("id-1");
    expect(typeof body.expires_at).toBe("number");
    expect(fixture.messages).toHaveLength(1);
    const [message] = fixture.messages;
    expect(message.text).toContain("from ollama to omlx");
    expect(message.text).not.toMatch(/https?:\/\//);
    expect(message.options?.buttons).toEqual([
      [
        { text: "✅ Switch to omlx", callbackData: "pls:ok:tok-1" },
        { text: "✖ Cancel", callbackData: "pls:no:tok-1" },
      ],
    ]);
    expect(fixture.spawned).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/tok-/);
  });

  it("refuses up front when Hermes cannot receive the tap, and sends nothing", async () => {
    const fixture = await startApp();
    fixture.state.hermesReady = false;

    const { status, body } = await post(fixture.url, "omlx");

    expect(status).toBe(409);
    expect(body.reason).toBe("hermes_unavailable");
    expect(String(body.error)).toContain("the Hermes gateway is not running");
    expect(String(body.error)).toContain("scripts/switch-stack.sh omlx");
    expect(fixture.messages).toEqual([]);

    // Nothing was left pending
    fixture.state.hermesReady = true;
    expect((await post(fixture.url, "omlx")).status).toBe(202);
  });
```

  4. Replace the whole `describe("GET /api/stack/confirm", …)` block with:

```ts
describe("POST /api/stack/confirm", () => {
  it("spawns the switch once for a good token", async () => {
    const fixture = await startApp();
    await post(fixture.url, "omlx");
    const token = tokenFrom(fixture.messages[0]);

    const first = await answer(fixture.url, "confirm", { token });
    const second = await answer(fixture.url, "confirm", { token });

    expect(first).toEqual({ status: 200, body: { status: "switching", target: "omlx" } });
    expect(second.status).toBe(410);
    expect(fixture.spawned).toEqual(["omlx"]);
  });

  it("refuses an unknown, missing or non-string token without spawning", async () => {
    const fixture = await startApp();
    await post(fixture.url, "omlx");

    expect((await answer(fixture.url, "confirm", { token: "nope" })).status).toBe(410);
    expect((await answer(fixture.url, "confirm", {})).status).toBe(410);
    expect((await answer(fixture.url, "confirm", { token: ["tok-1"] })).status).toBe(410);
    expect(fixture.spawned).toEqual([]);
  });
});

describe("POST /api/stack/cancel", () => {
  it("drops the pending switch, starts nothing, and reports which request was cancelled", async () => {
    const fixture = await startApp();
    const requested = await post(fixture.url, "omlx");
    const token = tokenFrom(fixture.messages[0]);

    const cancelled = await answer(fixture.url, "cancel", { token });
    const status = (await (await fetch(`${fixture.url}/api/stack/status`)).json()) as Record<string, unknown>;

    expect(cancelled).toEqual({ status: 200, body: { status: "cancelled", target: "omlx" } });
    expect(status.pending).toBeNull();
    expect(status.cancelled).toEqual({ id: requested.body.id, target: "omlx" });
    expect((await answer(fixture.url, "confirm", { token })).status).toBe(410);
    expect(fixture.spawned).toEqual([]);
  });

  it("answers 410 for a token that is not pending", async () => {
    const fixture = await startApp();
    expect((await answer(fixture.url, "cancel", { token: "nope" })).status).toBe(410);
  });
});
```

  5. In `describe("GET /api/stack/status")`, add at the end of the existing test's expectations: `expect(body.hermes_ready).toBe(true);`, `expect(body.cancelled).toBeNull();`, and add a test:

```ts
  it("reports why Hermes is not ready", async () => {
    const fixture = await startApp();
    fixture.state.hermesReady = false;

    const body = (await (await fetch(`${fixture.url}/api/stack/status`)).json()) as Record<string, unknown>;

    expect(body.hermes_ready).toBe(false);
    expect(body.hermes_reason).toBe("the Hermes gateway is not running");
  });
```

  6. Delete the whole `describe("resolveConfirmBaseUrl", …)` block and the F6 comment above it.
  7. In the remaining `POST /api/stack/switch` tests, nothing else reads `messages[i]` as a string. Check with `grep -n "messages\[" __tests__/stack-routes.test.ts` and change any `fixture.messages[0]` string use to `fixture.messages[0].text`.

- [ ] **Step 2: Update the auth test.** In `__tests__/auth.test.ts`, replace the `"keeps the stack switch routes open for the browser UI"` test with:

```ts
  it("keeps the browser's stack routes open and protects confirm and cancel", () => {
    expect(isProtectedRequest("POST", "/api/stack/switch")).toBe(false);
    expect(isProtectedRequest("GET", "/api/stack/status")).toBe(false);
    // Only the Hermes plugin answers a switch, with the API token; no browser ever opens these
    expect(isProtectedRequest("POST", "/api/stack/confirm")).toBe(true);
    expect(isProtectedRequest("GET", "/api/stack/confirm")).toBe(true);
    expect(isProtectedRequest("POST", "/api/stack/cancel")).toBe(true);
  });
```

- [ ] **Step 3: Run them and check that they fail.** Run `npm run test -- __tests__/stack-routes.test.ts __tests__/auth.test.ts`. Expected: FAIL (TS errors on the `hermes` dep; confirm is still GET; the auth expectations fail).

- [ ] **Step 4: Implement the router.** In `src/api/stack.ts`:
  1. Replace the two header comment lines with:

```ts
// Stack switching for the browser UI. Requesting a switch needs no token; approval arrives out of
// band, as a tap on a Telegram button. Hermes' gateway receives the tap (it is the shared bot's only
// update consumer) and its pharmallm-switch plugin calls /confirm or /cancel here with the API token.
// The spawned script outlives the app it restarts.
```

  2. Add imports: `import { createHermesReadiness, hermesHome, queryGatewayStatus, readPluginReadyFile } from "../services/hermes-readiness.js";` and `import type { HermesReadinessChecker } from "../services/hermes-readiness.js";`. Delete `PUBLIC_URL_FILE`.
  3. `StackRouterDeps`: delete `confirmBaseUrl(): string;` and add `hermes: HermesReadinessChecker;`.
  4. In `/switch`, after the `telegramConfigured` block and before `deps.switcher.request(target)`, insert:

```ts
    // Refuse before anything is pending or sent: a button nobody can receive would only expire
    const hermes = await deps.hermes.check();
    if (!hermes.ready) {
      res.status(409).json({
        reason: "hermes_unavailable",
        error: `Hermes cannot receive the Telegram confirmation: ${hermes.reason}. Switch with scripts/switch-stack.sh ${target}`,
      });
      return;
    }
```

  5. Replace the `const link = …` line and the `sendTelegram` call with:

```ts
    const { token } = outcome.pending;
    try {
      await deps.sendTelegram(
        `PharmaLLM: switch the LLM stack from ${deps.activeStack()} to ${target}?\n` +
          `Confirm within 5 minutes. If you did not ask for this, tap Cancel or ignore it.`,
        {
          buttons: [
            [
              { text: `✅ Switch to ${target}`, callbackData: `pls:ok:${token}` },
              { text: "✖ Cancel", callbackData: `pls:no:${token}` },
            ],
          ],
        }
      );
```

  (the `catch` block stays as it is). In the `202` body add `id: outcome.pending.id,` before `target`.
  6. Replace the `router.get("/confirm", …)` handler with:

```ts
  router.post("/confirm", (req: Request, res: Response): void => {
    const pending = deps.switcher.confirm(bodyToken(req));
    if (!pending) {
      res.status(410).json({ error: "This switch request expired or was already answered" });
      return;
    }
    deps.spawnSwitch(pending.target);
    res.json({ status: "switching", target: pending.target });
  });

  router.post("/cancel", (req: Request, res: Response): void => {
    const pending = deps.switcher.cancel(bodyToken(req));
    if (!pending) {
      res.status(410).json({ error: "This switch request expired or was already answered" });
      return;
    }
    res.json({ status: "cancelled", target: pending.target });
  });
```

  and add above `createStackRouter`:

```ts
function bodyToken(req: Request): string {
  const token = (req.body as { token?: unknown } | undefined)?.token;
  return typeof token === "string" ? token : "";
}
```

  7. Make `/status` async and extend it:

```ts
  router.get("/status", async (_req: Request, res: Response): Promise<void> => {
    const pending = deps.switcher.pending();
    const hermes = await deps.hermes.cached();
    res.json({
      active: deps.activeStack(),
      stacks: STACK_NAMES,
      telegram_configured: deps.telegramConfigured(),
      hermes_ready: hermes.ready,
      hermes_reason: hermes.reason,
      pending: pending ? { target: pending.target, expires_at: pending.expiresAt } : null,
      cancelled: deps.switcher.lastCancelled(),
      progress: deps.readProgress(),
    });
  });
```

  8. Delete `resolveConfirmBaseUrl` and its comment. In the default export, delete `confirmBaseUrl: …` and add:

```ts
  hermes: createHermesReadiness({
    queryGatewayStatus: () => queryGatewayStatus(join(hermesHome(), "gateway.sock")),
    readPluginReadyFile: () => readPluginReadyFile(join(hermesHome(), "pharmallm-switch.ready.json")),
    now: () => Date.now(),
  }),
```

  9. In the `spawnSwitch` comment, change "after the confirm page already told the owner it worked" to "after the Telegram message already told the owner it worked".

- [ ] **Step 5: Implement the auth change.** In `src/api/auth.ts`, delete the line `["GET", "/api/stack/confirm"],`.

- [ ] **Step 6: Run the tests and typecheck.** Run `npm run test -- __tests__/stack-routes.test.ts __tests__/auth.test.ts && npm run typecheck && npm run typecheck:tests`. Expected: PASS. Then `grep -rn "resolveConfirmBaseUrl\|confirmBaseUrl\|PUBLIC_URL" src __tests__` prints nothing.

- [ ] **Step 7: Commit.**

```bash
git add src/api/stack.ts src/api/auth.ts __tests__/stack-routes.test.ts __tests__/auth.test.ts
git commit -m "feat: confirm stack switches with Telegram buttons instead of a link

The message now carries Switch and Cancel buttons whose callback data holds
the one-time token. Confirm and cancel become authenticated POSTs for the Hermes
plugin, and a switch is refused up front when Hermes cannot receive the tap.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Remove the public-URL machinery from switch-stack.sh

**Files:**
- Modify: `scripts/switch-stack.sh`
- Test: `__tests__/switch-stack-config.test.ts`

- [ ] **Step 1: Update the tests.** In `__tests__/switch-stack-config.test.ts`:
  1. In `"passes the Telegram credentials and public URL to the app"`, rename it to `"passes the Telegram credentials to the app and no public URL"`, delete the 3-line "Amended" comment, and replace the `PHARMALLM_PUBLIC_URL` expectation with `expect(script).not.toContain("PHARMALLM_PUBLIC_URL");` and `expect(script).not.toContain("public-url");`.
  2. Replace the test `"also stores the public URL file when PHARMALLM_PUBLIC_URL is set, at mode 600, printing no value"` with:

```ts
  it("never asks for or stores a public URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "tg-url-"));
    dirs.push(dir);

    const result = spawnSync("bash", [join(process.cwd(), "scripts", "switch-stack.sh"), "telegram"], {
      encoding: "utf-8",
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        PHARMALLM_RUN_DIR: join(dir, "run"),
        TELEGRAM_BOT_TOKEN: "123456:AA-secret",
        TELEGRAM_CHAT_ID: "424242",
      },
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(dir, "run", "public-url"))).toBe(false);
    expect(result.stdout + result.stderr).not.toMatch(/public URL/i);
  });
```

  (add `existsSync` to the `node:fs` import if it is missing).
  3. Delete the whole `describe("switch-stack.sh public_url", …)` block.

- [ ] **Step 2: Run them and check that they fail.** Run `npm run test -- __tests__/switch-stack-config.test.ts`. Expected: FAIL on the two changed tests.

- [ ] **Step 3: Implement.** In `scripts/switch-stack.sh`:
  1. Delete line 28, `PUBLIC_URL_FILE="$RUN_DIR/public-url"`. Keep `APP_HTTPS_PORT`: `stop_app` still uses it.
  2. Delete the `public_url()` function and its 2-line comment.
  3. Replace `ensure_telegram` with:

```bash
# Credentials the app uses to ask for confirmation of a UI-triggered switch
ensure_telegram() {
  local token="${TELEGRAM_BOT_TOKEN:-}" chat="${TELEGRAM_CHAT_ID:-}"
  # read -s shows nothing as you type, which reads as a hung terminal unless we say so.
  if [ -z "$token" ] && [ -t 0 ]; then
    read -rs -p "Telegram bot token (input is hidden — paste, then press Enter): " token
    echo >&2
  fi
  if [ -z "$chat" ] && [ -t 0 ]; then read -r -p "Telegram chat id: " chat; fi
  [ -n "$token" ] && [ -n "$chat" ] || { log "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or run this on a terminal"; exit 1; }
  (umask 077 && printf '%s\n' "$token" >"$TELEGRAM_BOT_TOKEN_FILE")
  (umask 077 && printf '%s\n' "$chat" >"$TELEGRAM_CHAT_ID_FILE")
  chmod 600 "$TELEGRAM_BOT_TOKEN_FILE" "$TELEGRAM_CHAT_ID_FILE"
  log "Stored Telegram credentials in $RUN_DIR (mode 600)"
}
```

  4. In `start_app`, delete the four `public_url_value` lines (the `local`, the assignment and the `case … esac`), and delete the line `    PHARMALLM_PUBLIC_URL="$(public_url)" \`. The launch then reads:

```bash
  LLM_PROVIDER="$1" CHROMADB_URL="$CHROMA_URL" PHARMALLM_API_TOKEN="$(api_token)" \
    TELEGRAM_BOT_TOKEN="$(telegram_value bot-token)" TELEGRAM_CHAT_ID="$(telegram_value chat-id)" \
    nohup npx tsx src/server.ts >"$LOG_DIR/app.log" 2>&1 &
```

- [ ] **Step 4: Run the tests.** Run `npm run test -- __tests__/switch-stack-config.test.ts && bash -n scripts/switch-stack.sh && grep -n "public" scripts/switch-stack.sh`. Expected: PASS, no syntax error, grep prints nothing.

- [ ] **Step 5: Commit.**

```bash
git add scripts/switch-stack.sh __tests__/switch-stack-config.test.ts
git commit -m "refactor: drop the public URL now that confirmations need no link

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: UI knows about Hermes readiness and cancels

**Files:**
- Modify: `src/services/switch-labels.ts`, `public/app.js`
- Test: `__tests__/switch-labels.test.ts`

**Interfaces:**
- Consumes: `/api/stack/status` fields `hermes_ready`, `hermes_reason`, `cancelled` and the `id` in the `202` body (Task 4).
- Produces: `StackSelectState` gains `hermes_ready: boolean`.

- [ ] **Step 1: Update the tests.** In `__tests__/switch-labels.test.ts`, in `describe("isStackSelectDisabled")`, add `hermes_ready: true` to every status literal (the existing four expectations and the browser-copy list). Then add:

```ts
  it("disables the selector when Hermes cannot receive the confirmation", () => {
    expect(isStackSelectDisabled({ pending: null, telegram_configured: true, hermes_ready: false }, false)).toBe(true);
  });
```

and add `{ pending: null, telegram_configured: true, hermes_ready: false }` to the list of statuses that the browser-copy drift test loops over.

- [ ] **Step 2: Run them and check that they fail.** Run `npm run test -- __tests__/switch-labels.test.ts`. Expected: FAIL (a TS error on `hermes_ready`, and the new case returns false).

- [ ] **Step 3: Implement the module.** In `src/services/switch-labels.ts`:

```ts
export interface StackSelectState {
  pending: { target: StackName; expires_at: number } | null;
  telegram_configured: boolean;
  hermes_ready: boolean;
}
```

and the function body becomes `return busy || Boolean(status.pending) || !status.telegram_configured || !status.hermes_ready;`.

- [ ] **Step 4: Implement the browser copy and cancel handling.** In `public/app.js`:
  1. Replace the comment line `// switch it asked for, counting down the confirmation window and reverting if it expires unused.` with `// switch it asked for, counting down the confirmation window and reverting if it is cancelled or expires unused.`
  2. Add `let watchId = null; // id from the 202 body: matches status.cancelled when this request is cancelled` under `let watchExpiresAt`.
  3. `isStackSelectDisabled` body becomes `return busy || Boolean(status.pending) || !status.telegram_configured || !status.hermes_ready;`.
  4. Replace the `stackSelect.title = …` statement with:

```js
  stackSelect.title = !status.telegram_configured
    ? "Telegram confirmation not configured - run scripts/switch-stack.sh telegram"
    : !status.hermes_ready
      ? `Hermes cannot receive the Telegram confirmation: ${status.hermes_reason || "unknown reason"}`
      : "LLM stack (deployment environment)";
```

  5. In `renderStackStatus`, replace the `if (watching && !oursHasAppeared) {` branch's opening so that a cancel is checked first:

```js
  if (watching && !oursHasAppeared && status.cancelled && status.cancelled.id === watchId) {
    watching = false;
    watchExpiresAt = null;
    watchId = null;
    label = "Switch cancelled";
    cls = "";
    busy = false;
    stackSelect.value = status.active;
  } else if (watching && !oursHasAppeared) {
```

  (the existing branch body and the following `else if (oursHasAppeared)` stay unchanged).
  6. In the change handler: after `watchExpiresAt = data.expires_at;` add `watchId = data.id;`. Where `watchExpiresAt = null;` is set in the `!res.ok` branch and in the `catch`, also set `watchId = null;`. In the expiry branch (`label = "Switch request expired"`) and in `if (!busy) { watching = false; watchExpiresAt = null; }`, add `watchId = null;` too.

  The `hermes_unavailable` refusal needs no UI code: the existing `setStatus(data.error || …)` shows the server's message.

- [ ] **Step 5: Run the tests and typecheck.** Run `npm run test -- __tests__/switch-labels.test.ts && npm run typecheck && node --check public/app.js`. Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/services/switch-labels.ts public/app.js __tests__/switch-labels.test.ts
git commit -m "feat: disable the stack selector when Hermes is not ready, and show cancels

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The pharmallm-switch Hermes plugin

**Files:**
- Create: `hermes/plugins/pharmallm-switch/plugin.yaml`, `hermes/plugins/pharmallm-switch/tap.py`, `hermes/plugins/pharmallm-switch/__init__.py`
- Create: `hermes/tests/test_pharmallm_switch.py`
- Modify: `package.json` (add a `test:hermes-plugin` script)

**Interfaces:**
- Consumes: the Task 4 HTTP contract (`POST /api/stack/confirm|cancel {token}` with bearer → `200 {target}` / `410`).
- Produces: `$HERMES_HOME/pharmallm-switch.ready.json` `{"pid", "start_time"}` in exactly the form Task 3's `evaluateReadiness` compares.

Facts this rests on (Hermes 0.21.3):
- Plugins are loaded as packages (`plugins/plugin_loader.py` passes `submodule_search_locations`), so `from .tap import …` works.
- `ctx.register_telegram_handler(factory)` calls `factory(ptb_application, adapter)` from the Telegram adapter's `connect()`, **before** core handlers are registered (`adapter.py`: "Plugin PTB handlers go BEFORE core"). A pattern-scoped handler in the default group therefore wins for `pls:` and leaves every other callback to Hermes' catch-all.
- The gateway's pid file gets `start_time` from `gateway.status.get_process_start_time(os.getpid())`. The status socket reports the same value, so the plugin must use the same function.
- The gateway loads `~/.hermes/.env` into `os.environ`: `PHARMALLM_URL`, `PHARMALLM_API_TOKEN` and `TELEGRAM_ALLOWED_USERS` are there.
- An edit with no `reply_markup` removes the inline keyboard.

- [ ] **Step 1: Write the failing tests.** Create `hermes/tests/test_pharmallm_switch.py`:

```python
"""Tests for the pharmallm-switch Hermes plugin. Stdlib only: no Telegram, no Hermes, no live app."""

import asyncio
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

PLUGIN_DIR = Path(__file__).resolve().parent.parent / "plugins" / "pharmallm-switch"
TOKEN = "0123456789abcdef0123456789abcdef"


def load_plugin():
    # Loaded as a package, the way Hermes loads it, so the plugin's relative import resolves
    spec = importlib.util.spec_from_file_location(
        "pharmallm_switch", PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    module = importlib.util.module_from_spec(spec)
    sys.modules["pharmallm_switch"] = module
    spec.loader.exec_module(module)
    return module


plugin = load_plugin()
tap = sys.modules["pharmallm_switch.tap"]


class ParseTapTest(unittest.TestCase):
    def test_reads_confirm_and_cancel(self):
        self.assertEqual(tap.parse_tap(f"pls:ok:{TOKEN}"), tap.Tap("confirm", TOKEN))
        self.assertEqual(tap.parse_tap(f"pls:no:{TOKEN}"), tap.Tap("cancel", TOKEN))

    def test_ignores_anything_else(self):
        for data in ["", "ea:once:1", f"pls:maybe:{TOKEN}", "pls:ok:short", f"pls:ok:{TOKEN}x", None]:
            self.assertIsNone(tap.parse_tap(data))


class AllowedTest(unittest.TestCase):
    def test_only_listed_users(self):
        env = {"TELEGRAM_ALLOWED_USERS": " 424242 , 99"}
        self.assertTrue(tap.is_allowed(424242, env))
        self.assertTrue(tap.is_allowed("99", env))
        self.assertFalse(tap.is_allowed(7, env))
        self.assertFalse(tap.is_allowed(None, env))

    def test_nobody_when_the_list_is_empty(self):
        self.assertFalse(tap.is_allowed(424242, {}))


class OutcomeTest(unittest.TestCase):
    def test_maps_each_app_reply(self):
        confirm, cancel = tap.Tap("confirm", TOKEN), tap.Tap("cancel", TOKEN)
        switching = tap.outcome_for(confirm, tap.AppReply(200, {"status": "switching", "target": "mlx"}))
        self.assertEqual(switching.text, "✅ Switching to mlx — PharmaLLM restarts in a moment")
        self.assertEqual(tap.outcome_for(cancel, tap.AppReply(200, {})).text, "✖ Switch cancelled")
        self.assertEqual(tap.outcome_for(confirm, tap.AppReply(410, {})).text,
                         "⌛ Expired — request the switch again from PharmaLLM")

    def test_keeps_the_buttons_when_the_app_cannot_be_reached(self):
        down = tap.outcome_for(tap.Tap("confirm", TOKEN), tap.AppReply(0, {}, "ConnectionRefusedError"))
        self.assertIsNone(down.text)
        self.assertIn("ConnectionRefusedError", down.toast)
        self.assertIn("401", tap.outcome_for(tap.Tap("confirm", TOKEN), tap.AppReply(401, {})).toast)


class PostJsonTest(unittest.TestCase):
    """Against a test-owned HTTP server on a free port, never the real app."""

    def setUp(self):
        self.seen = []
        seen = self.seen

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append((self.path, self.headers["Authorization"], body))
                code = 200 if body.get("token") == TOKEN else 410
                payload = json.dumps({"status": "switching", "target": "mlx"} if code == 200 else {"error": "x"})
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(payload.encode())

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.env = {"PHARMALLM_URL": f"http://127.0.0.1:{self.server.server_port}/",
                    "PHARMALLM_API_TOKEN": "api-secret"}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_confirms_with_the_bearer_token(self):
        outcome = tap.resolve(tap.Tap("confirm", TOKEN), self.env)
        self.assertEqual(self.seen, [("/api/stack/confirm", "Bearer api-secret", {"token": TOKEN})])
        self.assertTrue(outcome.text.startswith("✅ Switching to mlx"))

    def test_reads_a_410_as_expired(self):
        outcome = tap.resolve(tap.Tap("cancel", "f" * 32), self.env)
        self.assertEqual(self.seen[0][0], "/api/stack/cancel")
        self.assertTrue(outcome.text.startswith("⌛ Expired"))

    def test_unreachable_app_names_the_error_class_and_never_the_token(self):
        reply = tap.post_json("http://127.0.0.1:9/api/stack/confirm", {"token": TOKEN}, "api-secret", timeout=2)
        self.assertEqual(reply.status, 0)
        self.assertTrue(reply.error)
        self.assertNotIn("api-secret", reply.error)


class FakeQuery:
    def __init__(self, data, user_id):
        self.data = data
        self.from_user = mock.Mock(id=user_id)
        self.answers, self.edits = [], []

    async def answer(self, text=None):
        self.answers.append(text)

    async def edit_message_text(self, text):
        self.edits.append(text)


class HandleTapTest(unittest.TestCase):
    ENV = {"TELEGRAM_ALLOWED_USERS": "424242", "PHARMALLM_URL": "http://x", "PHARMALLM_API_TOKEN": "t"}

    def run_tap(self, query, outcome=None):
        update = mock.Mock(callback_query=query)
        resolved = mock.Mock(return_value=outcome)
        with mock.patch.dict("os.environ", self.ENV, clear=True), mock.patch.object(plugin, "resolve", resolved):
            asyncio.run(plugin.handle_tap(update, None))
        return resolved

    def test_answers_and_edits_for_an_allowed_user(self):
        query = FakeQuery(f"pls:ok:{TOKEN}", 424242)
        resolved = self.run_tap(query, tap.Outcome("✅ Switching to mlx", "✅ Switching to mlx — restarts"))
        self.assertEqual(resolved.call_args.args[0], tap.Tap("confirm", TOKEN))
        self.assertEqual(query.answers, ["✅ Switching to mlx"])
        self.assertEqual(query.edits, ["✅ Switching to mlx — restarts"])

    def test_refuses_a_stranger_without_calling_the_app(self):
        query = FakeQuery(f"pls:ok:{TOKEN}", 7)
        resolved = self.run_tap(query)
        resolved.assert_not_called()
        self.assertEqual(query.answers, ["Not authorised"])
        self.assertEqual(query.edits, [])

    def test_leaves_the_message_alone_when_the_outcome_keeps_the_buttons(self):
        query = FakeQuery(f"pls:no:{TOKEN}", 424242)
        self.run_tap(query, tap.Outcome("⚠️ Could not reach PharmaLLM (HTTP 500)", None))
        self.assertEqual(query.edits, [])


class ReadyFileTest(unittest.TestCase):
    def test_writes_pid_and_start_time(self):
        with tempfile.TemporaryDirectory() as home:
            path = plugin.write_ready_file(Path(home), 4242, 777)
            self.assertEqual(json.loads(path.read_text()), {"pid": 4242, "start_time": 777})
            self.assertEqual(path.name, "pharmallm-switch.ready.json")
            self.assertEqual([p.name for p in Path(home).iterdir()], ["pharmallm-switch.ready.json"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Add the npm script.** In `package.json` `scripts`, add `"test:hermes-plugin": "python3 -m unittest discover -s hermes/tests -v",`.

- [ ] **Step 3: Run it and check that it fails.** Run `npm run test:hermes-plugin`. Expected: ERROR, `__init__.py` not found.

- [ ] **Step 4: Write `plugin.yaml`.**

```yaml
name: pharmallm-switch
version: 1.0.0
description: "Confirms or cancels a PharmaLLM stack switch from the Telegram buttons the app sends."
author: PharmaLLM
```

- [ ] **Step 5: Write `tap.py`.**

```python
"""Pure logic for the PharmaLLM switch buttons: parse a tap, check who tapped, ask the app, pick the reply.
No Telegram or Hermes imports, so it tests with the standard library alone."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Mapping, Optional

PATTERN = r"^pls:(ok|no):[0-9a-f]{32}$"
_TAP = re.compile(PATTERN)


@dataclass(frozen=True)
class Tap:
    action: str  # "confirm" or "cancel", the app route it calls
    token: str


@dataclass(frozen=True)
class AppReply:
    status: int  # 0 when the app could not be reached
    body: dict
    error: str = ""  # exception class name only: a message could echo the request


@dataclass(frozen=True)
class Outcome:
    toast: str
    text: Optional[str]  # replaces the message and drops its buttons; None keeps both for a retry


def parse_tap(data: Optional[str]) -> Optional[Tap]:
    if not data or not _TAP.match(data):
        return None
    _, choice, token = data.split(":")
    return Tap("confirm" if choice == "ok" else "cancel", token)


def is_allowed(user_id: object, env: Mapping[str, str]) -> bool:
    allowed = {part.strip() for part in env.get("TELEGRAM_ALLOWED_USERS", "").split(",") if part.strip()}
    return user_id is not None and str(user_id) in allowed


def _json(raw: bytes) -> dict:
    try:
        value = json.loads(raw.decode("utf-8") or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def post_json(url: str, body: dict, token: str, timeout: float = 10.0) -> AppReply:
    request = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return AppReply(response.status, _json(response.read()))
    except urllib.error.HTTPError as err:
        return AppReply(err.code, _json(err.read()))
    except (urllib.error.URLError, OSError) as err:
        return AppReply(0, {}, type(err).__name__)


def outcome_for(tap: Tap, reply: AppReply) -> Outcome:
    if reply.status == 200 and tap.action == "confirm":
        target = str(reply.body.get("target") or "the new stack")
        return Outcome(f"✅ Switching to {target}", f"✅ Switching to {target} — PharmaLLM restarts in a moment")
    if reply.status == 200:
        return Outcome("✖ Switch cancelled", "✖ Switch cancelled")
    if reply.status == 410:
        return Outcome("⌛ Expired", "⌛ Expired — request the switch again from PharmaLLM")
    detail = reply.error or f"HTTP {reply.status}"
    return Outcome(f"⚠️ Could not reach PharmaLLM ({detail})", None)


def resolve(tap: Tap, env: Mapping[str, str],
            post: Callable[[str, dict, str], AppReply] = post_json) -> Outcome:
    base = env.get("PHARMALLM_URL", "http://localhost:3000").rstrip("/")
    reply = post(f"{base}/api/stack/{tap.action}", {"token": tap.token}, env.get("PHARMALLM_API_TOKEN", ""))
    return outcome_for(tap, reply)
```

- [ ] **Step 6: Write `__init__.py`.**

```python
"""pharmallm-switch: confirms or cancels a PharmaLLM stack switch from the Telegram buttons the app sends.

The app shares Hermes' bot and Hermes' gateway is that bot's only getUpdates consumer, so a tap on the
app's buttons lands here. The handler is scoped to ``pls:`` callback data and registered before
Hermes' own catch-all, so every other button keeps working."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Optional

from .tap import PATTERN, is_allowed, parse_tap, resolve

logger = logging.getLogger(__name__)
READY_FILE_NAME = "pharmallm-switch.ready.json"


def register(ctx) -> None:
    ctx.register_telegram_handler(_wire)


def _wire(app, adapter) -> None:
    # Runs only when the gateway's Telegram adapter connects. A CLI session loads plugins too but never
    # gets here, so it cannot overwrite the ready file with its own pid.
    from telegram.ext import CallbackQueryHandler
    from gateway.status import get_process_start_time
    from hermes_cli.config import get_hermes_home

    app.add_handler(CallbackQueryHandler(handle_tap, pattern=PATTERN))
    pid = os.getpid()
    # Same function the gateway's own pid record uses, so PharmaLLM can compare the two exactly
    write_ready_file(Path(get_hermes_home()), pid, get_process_start_time(pid))


def write_ready_file(home: Path, pid: int, start_time: Optional[int]) -> Path:
    path = home / READY_FILE_NAME
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps({"pid": pid, "start_time": start_time}), encoding="utf-8")
    os.replace(temp, path)
    return path


async def handle_tap(update, context) -> None:
    query = update.callback_query
    tap = parse_tap(getattr(query, "data", None))
    if query is None or tap is None:
        return
    if not is_allowed(getattr(query.from_user, "id", None), os.environ):
        await query.answer(text="Not authorised")
        return
    # urllib blocks: keep it off the gateway's event loop
    outcome = await asyncio.to_thread(resolve, tap, dict(os.environ))
    await query.answer(text=outcome.toast)
    if outcome.text is None:
        return
    try:
        await query.edit_message_text(outcome.text)
    except Exception as exc:  # an edit failure must not surface as a gateway error
        logger.warning("pharmallm-switch: could not edit the message (%s)", type(exc).__name__)
```

- [ ] **Step 7: Run the tests.** Run `npm run test:hermes-plugin`. Expected: all tests OK. Also run them under Hermes' own interpreter, which is the one that loads the plugin: `~/.hermes/hermes-agent/venv/bin/python -m unittest discover -s hermes/tests -v`. Expected: OK. (That only *runs* Hermes' Python; it does not touch `~/.hermes` state.)

- [ ] **Step 8: Commit.**

```bash
git add hermes/plugins/pharmallm-switch hermes/tests/test_pharmallm_switch.py package.json
git commit -m "feat: add the pharmallm-switch Hermes plugin for the switch buttons

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Install the plugin with hermes-setup.sh

**Files:**
- Modify: `scripts/hermes-setup.sh`, `hermes/config.template.yaml`
- Test: `__tests__/hermes-setup.test.ts`, `__tests__/hermes-config.test.ts`

- [ ] **Step 1: Verify the Hermes CLI in a throwaway home (ask the owner before running it).** Run it with a temp `HERMES_HOME` so the live `~/.hermes` is never touched:

```bash
T=$(mktemp -d); mkdir -p "$T/plugins/demo-x"
printf 'name: demo-x\nversion: 0.0.1\ndescription: d\n' >"$T/plugins/demo-x/plugin.yaml"
printf 'def register(ctx):\n    pass\n' >"$T/plugins/demo-x/__init__.py"
printf 'model:\n  default: x\n' >"$T/config.yaml"
HERMES_HOME="$T" hermes plugins enable demo-x </dev/null; echo "exit=$?"
HERMES_HOME="$T" hermes plugins enable demo-x </dev/null; echo "exit=$?"
cat "$T/config.yaml"; rm -rf "$T"
```

Expected: both exit 0, no prompt, and `config.yaml` has `plugins: enabled: [demo-x]`. **If the second run fails or it prompts**, change `install_plugin` below to call `enable` only when `hermes plugins list` does not show the plugin as enabled, and adjust the test's stub to match. Record what you saw in the commit message.

- [ ] **Step 2: Write the failing tests.** In `__tests__/hermes-setup.test.ts` add:

```ts
describe("hermes-setup.sh install-plugin", () => {
  it("copies only the plugin's own files, enables it and restarts the gateway", () => {
    const box = sandbox();

    const result = setup(box, ["install-plugin"]);

    expect(result.status).toBe(0);
    const dest = join(box.home, "plugins", "pharmallm-switch");
    expect(readdirSync(dest).sort()).toEqual(["__init__.py", "plugin.yaml", "tap.py"]);
    const calls = readFileSync(box.calls, "utf-8");
    expect(calls).toContain("hermes [plugins] [enable] [pharmallm-switch]");
    expect(calls).toContain("hermes [gateway] [restart]");
    expect(calls.indexOf("[plugins] [enable]")).toBeLessThan(calls.indexOf("[gateway] [restart]"));
  });
});

describe("hermes-setup.sh check: plugin", () => {
  function checkOutput(box: Sandbox): string {
    setup(box, ["install-config"], { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_ALLOWED_USERS: "424242" });
    const result = setup(box, ["check"]);
    return result.stdout + result.stderr;
  }

  it("reports the plugin as missing before install-plugin", () => {
    expect(checkOutput(sandbox())).toContain("plugin pharmallm-switch: missing");
  });

  it("reports a plugin loaded by the running gateway only when pid and start time both match", () => {
    const box = sandbox();
    setup(box, ["install-plugin"]);
    mkdirSync(box.home, { recursive: true });
    writeFileSync(join(box.home, "gateway.pid"), JSON.stringify({ pid: 4242, start_time: 777, kind: "hermes-gateway" }));
    writeFileSync(join(box.home, "pharmallm-switch.ready.json"), JSON.stringify({ pid: 4242, start_time: 777 }));
    expect(checkOutput(box)).toContain("plugin pharmallm-switch: loaded by the running gateway");

    writeFileSync(join(box.home, "pharmallm-switch.ready.json"), JSON.stringify({ pid: 4242, start_time: 1 }));
    expect(checkOutput(box)).toContain("plugin pharmallm-switch: installed, waiting for a gateway restart");
  });
});
```

In `__tests__/hermes-config.test.ts`, add inside `describe("hermes/config.template.yaml")`:

```ts
  it("enables the pharmallm-switch plugin that receives the stack-switch buttons", () => {
    expect(at("plugins.enabled")).toContain("pharmallm-switch");
  });
```

Keep the existing `check` test that asserts the output never contains "not loaded": the new messages avoid that phrase on purpose.

- [ ] **Step 3: Run them and check that they fail.** Run `npm run test -- __tests__/hermes-setup.test.ts __tests__/hermes-config.test.ts`. Expected: FAIL (unknown command, missing template key).

- [ ] **Step 4: Implement.** In `scripts/hermes-setup.sh`:
  1. Usage block: add `#   scripts/hermes-setup.sh install-plugin    install the pharmallm-switch plugin (Telegram switch buttons) and restart the gateway` after the `install-services` line, and change the `all` line to `install-config, install-services, install-plugin, install-cron`. Update the default branch's `sed -n '2,8p'` to `sed -n '2,9p'`.
  2. Under `MCP_LABEL=…` add:

```bash
PLUGIN_NAME="pharmallm-switch"
# Only the plugin's own files: the tests next to it in the repo stay out of ~/.hermes
PLUGIN_FILES=(plugin.yaml __init__.py tap.py)
```

  3. Add after `install_services`:

```bash
install_plugin() {
  require_hermes
  local src="$TEMPLATE_DIR/plugins/$PLUGIN_NAME" dest="$HERMES_HOME/plugins/$PLUGIN_NAME" file
  mkdir -p "$dest"
  for file in "${PLUGIN_FILES[@]}"; do
    cp "$src/$file" "$dest/$file"
  done
  "$HERMES_BIN" plugins enable "$PLUGIN_NAME"
  # The plugin wires its Telegram handler when the gateway connects, so only a restart loads it
  "$HERMES_BIN" gateway restart
  log "Installed the $PLUGIN_NAME plugin and restarted the gateway"
}
```

  4. In `check`, before the MCP health block, add:

```bash
  # "Loaded" means the ready file names the gateway now running (pid and start time): a pid alone
  # can be reused after a crash. The wording avoids "not loaded", which reports services above.
  if [ ! -f "$HERMES_HOME/plugins/$PLUGIN_NAME/plugin.yaml" ]; then
    log "plugin $PLUGIN_NAME: missing"
    problems=1
  elif python3 - "$HERMES_HOME" "$PLUGIN_NAME" <<'PY'
import json, sys
from pathlib import Path
home, name = Path(sys.argv[1]), sys.argv[2]
try:
    gateway = json.loads((home / "gateway.pid").read_text(encoding="utf-8"))
    ready = json.loads((home / f"{name}.ready.json").read_text(encoding="utf-8"))
except (OSError, ValueError):
    sys.exit(1)
same = (ready.get("pid"), ready.get("start_time")) == (gateway.get("pid"), gateway.get("start_time"))
sys.exit(0 if same and ready.get("pid") is not None else 1)
PY
  then
    log "plugin $PLUGIN_NAME: loaded by the running gateway"
  else
    log "plugin $PLUGIN_NAME: installed, waiting for a gateway restart"
    problems=1
  fi
```

  5. Dispatch: add `install-plugin) install_plugin ;;` and in `all` add `install_plugin` between `install_services` and `install_cron`.
  6. In `hermes/config.template.yaml`, append:

```yaml

# Receives the Switch / Cancel buttons PharmaLLM sends for a stack switch (hermes/plugins/pharmallm-switch).
# Installed by scripts/hermes-setup.sh install-plugin.
plugins:
  enabled:
    - pharmallm-switch
```

- [ ] **Step 5: Run the tests.** Run `npm run test -- __tests__/hermes-setup.test.ts __tests__/hermes-config.test.ts && bash -n scripts/hermes-setup.sh`. Expected: PASS. The existing `all` test may now log an extra stub call; if it asserts an exact call list, add the two plugin calls to it.

- [ ] **Step 6: Commit.**

```bash
git add scripts/hermes-setup.sh hermes/config.template.yaml __tests__/hermes-setup.test.ts __tests__/hermes-config.test.ts
git commit -m "feat: install and check the pharmallm-switch plugin from hermes-setup.sh

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`, `hermes/README.md`

- [ ] **Step 1: README, "Switching from the web UI" (around line 211).** Replace "PharmaLLM sends a Telegram message with a one-time confirmation link, valid for 5 minutes. Tapping it starts the switch; ignoring it reverts the selector." with "PharmaLLM sends a Telegram message with **Switch** and **Cancel** buttons, valid for 5 minutes. Tapping Switch starts it, tapping Cancel or ignoring the message reverts the selector. The tap goes through the Hermes gateway (the `pharmallm-switch` plugin), which calls the app on localhost, so the phone never has to reach the Mac." In the requirements paragraph after it, add that the Hermes gateway must be running on this Mac with the plugin installed (`scripts/hermes-setup.sh install-plugin`), or the selector is disabled and says why. Also note that the two-Mac Hermes setup can't confirm switches: use `scripts/switch-stack.sh` there.

- [ ] **Step 2: README API table (around lines 545–546).** Change the `/api/stack/switch` row: "sends a Telegram message with Switch/Cancel buttons (`202` pending confirmation, with `id`; …; `409` … Telegram not configured, or `hermes_unavailable` when the Hermes gateway or its plugin cannot receive the tap; …)". Replace the `/api/stack/confirm` row with two rows:

```
| `/api/stack/confirm` | POST | token | `{ token }` from the Telegram button, sent by the Hermes plugin; starts `scripts/switch-stack.sh <target>` (`200 {status, target}`, `410` if the token expired or was already used) |
| `/api/stack/cancel` | POST | token | `{ token }`; drops the pending switch (`200 {status, target}`, `410` as above) |
```

Add `hermes_ready`, `hermes_reason` and `cancelled` to the `/api/stack/status` row's field list.

- [ ] **Step 3: README project tree (around line 725).** Change the `telegram-notify.ts` comment to `# Sends the switch buttons and the completion message`, add `│   │   ├── hermes-readiness.ts # Can Hermes receive the switch buttons? (gateway socket + plugin ready file)` next to it, and under `hermes/` add `plugins/pharmallm-switch/` with the comment `# Hermes plugin: handles the Switch / Cancel buttons`.

- [ ] **Step 4: hermes/README.md.** Add a section "Stack-switch buttons" explaining: the app and Hermes share one bot, and Hermes is its only update consumer, so the `pharmallm-switch` plugin receives the button taps. Install it with `scripts/hermes-setup.sh install-plugin`. It writes `~/.hermes/pharmallm-switch.ready.json`, which the app compares with the gateway's pid and start time. `scripts/hermes-setup.sh check` reports it. Its tests run with `npm run test:hermes-plugin`.

- [ ] **Step 5: Check and commit.** Run `grep -n "confirmation link\|public-url\|PUBLIC_URL" README.md hermes/README.md`. Expected: nothing. Then:

```bash
git add README.md hermes/README.md
git commit -m "docs: describe the Telegram switch buttons and the Hermes plugin

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Full verification, then live install with the owner

This task changes the live machine. **Ask the owner before each live step** (it restarts the Hermes gateway and the app).

- [ ] **Step 1: Full suite.** Run `npm run typecheck && npm run typecheck:tests && npm run test && npm run test:hermes-plugin`. Expected: all green. Paste the summary lines into the verification doc.

- [ ] **Step 2: Check for leftovers.** Run `grep -rn "resolveConfirmBaseUrl\|PHARMALLM_PUBLIC_URL\|public-url" src scripts __tests__ public hermes README.md`. Expected: nothing.

- [ ] **Step 3: Install the plugin (live, with approval).** Run `scripts/hermes-setup.sh install-plugin`, then `scripts/hermes-setup.sh check`. Expected: `plugin pharmallm-switch: loaded by the running gateway`. If it says "waiting for a gateway restart", read `~/.hermes/logs/` for `Wired native handlers from plugin 'pharmallm-switch'` or a factory error.

- [ ] **Step 4: Restart the app on the current stack and remove the leftover URL file (live, with approval).** Run `rm -f data/run/public-url`, then `scripts/switch-stack.sh $(cat data/run/active-stack)` so the app runs the new code. Then `curl -sk -H "Authorization: Bearer $(cat data/run/api-token)" https://127.0.0.1:3443/api/stack/status`. Expected: `"hermes_ready":true`. Check the next Hermes cron `next_run_at` in `~/.hermes/cron/jobs.json` first, and do not restart within 10 minutes of a job.

- [ ] **Step 5: Live checks on the iPad (the owner taps).** Record each result in `docs/superpowers/plans/2026-09-18-omlx-stack-verification.md` under a new "Telegram buttons (2026-09-19)" heading:
  1. **Confirm:** pick MLX in the UI. The message has two buttons and no link. Tap Switch. The message edits to "✅ Switching to mlx…" and the UI walks through to "MLX stack ready".
  2. **Cancel:** pick oMLX, tap Cancel. The message edits to "✖ Switch cancelled", and within 3 s the UI shows "Switch cancelled" and the selector is back on MLX.
  3. **Expired:** pick oMLX, wait more than 5 minutes, then tap Switch. The message edits to "⌛ Expired…" and nothing starts.
  4. **Hermes down:** `hermes gateway stop`. The selector is disabled with the Hermes reason as its tooltip, and a forced POST returns `409 hermes_unavailable`. Then `hermes gateway start` and confirm that `hermes_ready` is back to true within a few seconds. Do this when no cron job is due.
  5. **Hermes' own buttons still work:** trigger any Hermes flow with buttons (e.g. `/model` in the chat) and check that it still responds.

- [ ] **Step 6: Commit the verification notes.**

```bash
git add docs/superpowers/plans/2026-09-18-omlx-stack-verification.md
git commit -m "docs: record the live Telegram button confirmation checks

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```
