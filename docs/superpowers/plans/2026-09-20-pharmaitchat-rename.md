# PharmaITChat Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the whole product to PharmaITChat, rewrite the chat page's copy and the README for the broadened scope, and cut the live services over without losing a night's ingest.

**Architecture:** Three repo tasks (identifiers, chat UI, README) land first and are provable by the test suite. Then one operational task performs the cutover on the machine in a fixed order — app, MCP service, Hermes config and plugin, cron jobs, GitHub — verifying after each step, because each later piece calls the earlier ones.

**Tech Stack:** TypeScript (Node 22, ES modules, Jest), Bash, Hermes Agent 0.21.3, launchd, better-sqlite3, ChromaDB.

**Spec:** `docs/superpowers/specs/2026-09-20-pharmaitchat-rename-design.md`

## Global Constraints

- The name is **PharmaITChat**. Identifiers: `pharmaitchat-*`, launchd label `com.pharmaitchat.mcp`, Hermes provider `custom:pharmaitchat`, model `pharmaitchat-local`, plugin `pharmaitchat-switch`, cron jobs `pharmaitchat-*`, MCP `SERVER_INFO.name: "pharmaitchat"`.
- **Never edit `~/.hermes/.env`** (CLAUDE.md forbids touching .env files). The app reads `PHARMAITCHAT_*` and falls back to `PHARMALLM_*`.
- **Do not move** the filesystem path `/Users/seb/claude/PharmaLLM`, the ChromaDB collections (`knowledge_base_mlx`, `knowledge_base_ollama`), the SQLite files, or `data/run/` filenames.
- No behaviour changes. This cutover adds no feature and removes none.
- TypeScript strict, ES modules, interfaces over type aliases, no `any`, comments in English.
- Tests never touch live services: no ChromaDB, no live model, no network, `:memory:` stores, never `data/watchlist.db` (it holds 203 real items).
- Jest needs `CI=true` in this shell. Run `npm run typecheck` and `npm run typecheck:tests` after code changes.
- Commits use `feat:`/`fix:`/`refactor:`/`docs:` and end with the Co-Authored-By trailer the session's attribution instructions give.

## File Structure

| File | Change |
|---|---|
| `src/config/env-names.ts` (create) | `readEnvWithFallback` — the `PHARMAITCHAT_*` → `PHARMALLM_*` fallback, used by app and MCP |
| `src/api/auth.ts`, `src/services/*.ts`, `src/api/stack.ts` | identifiers, readiness file name, message text |
| `mcp/src/*` (117 refs), `mcp/src/pharmallm-client.ts` → `pharmaitchat-client.ts` | server name, client module, config env reads |
| `scripts/hermes-setup.sh`, `scripts/switch-stack.sh`, `scripts/start-services.sh` | launchd label, plugin/script install paths, token hints |
| `hermes/com.pharmallm.mcp.plist.template` → `com.pharmaitchat.mcp.plist.template` | label |
| `hermes/plugins/pharmallm-switch/` → `hermes/plugins/pharmaitchat-switch/` | dir, `plugin.yaml` name, ready-file name |
| `hermes/scripts/pharmallm-watchlist-ingest.sh` → `pharmaitchat-watchlist-ingest.sh` | name |
| `hermes/config.template.yaml`, `hermes/cron/jobs.json` | provider, model, plugin, job names |
| `public/index.html`, `public/app.js` | brand and copy |
| `README.md`, `hermes/README.md` | rewritten |
| `__tests__/*`, `hermes/tests/*` | pins updated |

---

### Task 1: Rename every identifier in the repo

**Files:** everything in the table above except `public/` and the READMEs.

**Interfaces:**
- Produces: `export function readEnvWithFallback(env: NodeJS.ProcessEnv, suffix: string): string | undefined` in `src/config/env-names.ts` — reads `PHARMAITCHAT_<suffix>` then `PHARMALLM_<suffix>`, trimming and treating blank as absent. Used for `API_TOKEN`, `MCP_TOKEN`, `URL`, `MCP_URL`, `RUN_DIR`.

- [ ] **Step 1: Write the failing test** for the fallback, `__tests__/env-names.test.ts`:

```ts
import { describe, expect, it } from "@jest/globals";
import { readEnvWithFallback } from "../src/config/env-names.js";

describe("readEnvWithFallback", () => {
  it("prefers the new name", () => {
    expect(readEnvWithFallback({ PHARMAITCHAT_API_TOKEN: "new", PHARMALLM_API_TOKEN: "old" }, "API_TOKEN")).toBe("new");
  });

  it("falls back to the legacy name so an unedited ~/.hermes/.env keeps working", () => {
    expect(readEnvWithFallback({ PHARMALLM_API_TOKEN: "old" }, "API_TOKEN")).toBe("old");
  });

  it("treats blank as absent on both names", () => {
    expect(readEnvWithFallback({ PHARMAITCHAT_API_TOKEN: "  ", PHARMALLM_API_TOKEN: " " }, "API_TOKEN")).toBeUndefined();
    expect(readEnvWithFallback({}, "API_TOKEN")).toBeUndefined();
  });

  it("trims a padded value", () => {
    expect(readEnvWithFallback({ PHARMAITCHAT_URL: " http://x " }, "URL")).toBe("http://x");
  });
});
```

- [ ] **Step 2: Run it and check that it fails.** `CI=true npm run test -- __tests__/env-names.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/config/env-names.ts`** and route every `PHARMALLM_*` read through it: `src/api/auth.ts:103`, `mcp/src/config.ts:52-53`. Update the user-facing messages at `src/api/auth.ts:84,91,98` to name `PHARMAITCHAT_API_TOKEN`, adding "(or the legacy PHARMALLM_API_TOKEN)" once.

- [ ] **Step 4: Rename the files** with `git mv` so history follows: `mcp/src/pharmallm-client.ts` → `pharmaitchat-client.ts`, `hermes/com.pharmallm.mcp.plist.template` → `com.pharmaitchat.mcp.plist.template`, `hermes/plugins/pharmallm-switch/` → `pharmaitchat-switch/`, `hermes/scripts/pharmallm-watchlist-ingest.sh` → `pharmaitchat-watchlist-ingest.sh`. Fix every import.

- [ ] **Step 5: Rename the identifiers.** Work file by file, not with a blind global replace — `PharmaLLM` (prose/class names), `pharmallm` (ids) and `PHARMALLM_` (env) have different replacements. Specifically:
  - `mcp/src/mcp-server.ts:12` → `SERVER_INFO = { name: "pharmaitchat", version: "1.0.0" }`.
  - `mcp/src/http.ts:49` — the `/healthz` field `pharmallm` → `pharmaitchat`, **and** `scripts/hermes-setup.sh`'s check parser that reads it (they must move together).
  - `src/api/stack.ts:181` and `src/services/hermes-readiness.ts:2,43,46` — ready file `pharmaitchat-switch.ready.json` and the plugin name in its messages.
  - `hermes/plugins/pharmaitchat-switch/plugin.yaml` name and `__init__.py`'s `READY_FILE_NAME`.
  - `scripts/hermes-setup.sh:22` and `scripts/switch-stack.sh:28` — `MCP_LABEL="com.pharmaitchat.mcp"`; the plist template path at `hermes-setup.sh:160`; `PLUGIN_NAME`; the wrapper script name in `install_cron`.
  - `hermes/config.template.yaml` — provider key `pharmaitchat`, `provider: custom:pharmaitchat`, `default: pharmaitchat-local`, `models.pharmaitchat-local`, `cron.model`/`model_provider`, `plugins.enabled: [pharmaitchat-switch]`, `key_env: PHARMAITCHAT_API_TOKEN`.
  - `hermes/cron/jobs.json` — the five job names to `pharmaitchat-*`, and the script name.
  - `scripts/switch-stack.sh` — the Telegram message text and token hints.
  - `PHARMALLM_RUN_DIR` in both scripts → accept `PHARMAITCHAT_RUN_DIR` first, then the old name (`RUN_DIR="${PHARMAITCHAT_RUN_DIR:-${PHARMALLM_RUN_DIR:-$PROJECT_DIR/data/run}}"`) — the test suites set the old one.

- [ ] **Step 6: Update the tests that pin these strings.** `__tests__/hermes-config.test.ts`, `__tests__/hermes-setup.test.ts`, `__tests__/switch-stack-config.test.ts`, `__tests__/auth.test.ts`, `hermes/tests/test_pharmallm_switch.py` (rename to `test_pharmaitchat_switch.py` with `git mv`), and any MCP test naming the server.

- [ ] **Step 7: Run everything.** `CI=true npm run test`, `npm run typecheck`, `npm run typecheck:tests`, `python3 -m unittest discover -s hermes/tests`, `bash -n scripts/*.sh`. Expected: all green.

- [ ] **Step 8: Check what is left.** `grep -ril "pharmallm" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.worktrees --exclude-dir=data .` — every remaining hit must be either the documented env fallback, a historical reference in `docs/superpowers/` (leave those: they record what was true then), or a CHANGELOG-style mention. List them in the report.

- [ ] **Step 9: Commit.**

```bash
git add -A
git commit -m "refactor: rename the product to PharmaITChat"
```

---

### Task 2: Chat page brand and copy

**Files:** Modify `public/index.html`, `public/app.js`.

The page currently says `<title>CyberPharmaCHAT - Pharma Assistant</title>`, `<h1>CyberPharma</h1>`, `<p class="subtitle">Cyber Threat Expert Assistant</p>`, and an agent paragraph claiming a daily 194-topic Google News scrub that **no longer exists** (retired in commit 288c064).

- [ ] **Step 1: Rewrite the brand.** Use exactly:

```html
<title>PharmaITChat — Pharma IT Intelligence</title>
...
<h1>PharmaITChat</h1>
<p class="subtitle">The IT landscape around pharma — vendors, customers, competitors</p>
```

The subtitle must fit one line at iPad width; if it wraps, shorten to "Pharma IT: vendors, customers, competitors".

- [ ] **Step 2: Rewrite the input placeholder** (`public/index.html:54`, currently "Ask your pharma question...") to:

```html
placeholder="Ask about a vendor, a customer, or what changed this week..."
```

- [ ] **Step 3: Replace the stale agent paragraph** (`public/index.html:119`). It currently claims a daily 194-topic Google News scrub that no longer runs (and the real count is 188 topics, now owned by the watchlist). Replace with:

```html
<p class="agent-description">Every night at 02:30 the watchlist collects from company and vendor feeds, SEC filings and news across 71 watched entities — three customers, their competitors and the IT vendor scene — then tags each item by entity and IT domain (cyber, AI, cloud, infrastructure, R&amp;D IT, manufacturing IT, SAP, data, storage, backup) and stores it for search.</p>
```

Do not claim digests: Phase 2 is not built. Check the entity count against `config/watchlist.yaml` before committing — say what it actually is.

- [ ] **Step 4: Check the page renders.** `node --check public/app.js`, then open `public/index.html` and confirm no leftover "CyberPharma" string: `grep -ci cyberpharma public/index.html` → 0.

- [ ] **Step 5: Run the suite** (`CI=true npm run test`) in case a test pins page copy, then commit:

```bash
git add public/
git commit -m "feat: rebrand the chat page as PharmaITChat and describe the real scope"
```

---

### Task 3: README rewrite

**Files:** Modify `README.md`, `hermes/README.md`.

The owner asked for a README that shows off what the system does now. It currently leads with pharma-cyber. Rewrite around the present capability, keeping every factual claim checkable against the repo.

- [ ] **Step 1: Rewrite `README.md`.** Lead with what it is: a fully local pharma-IT intelligence system on one Mac mini — no cloud inference, no API keys for the model. Then, in order: the three interchangeable LLM stacks with the measured benchmark table (keep the existing numbers — they are real); the watchlist (71 entities, ~37 verified feeds, 46 EDGAR CIKs, nightly tagging into SQLite + ChromaDB); the RAG chat and knowledge base; Hermes on Telegram with its scheduled jobs and the stack-switch buttons; the MCP server; and the architecture diagram. Update the project tree. State plainly what is not built yet (digests, Phase 2/3) rather than implying it exists.

- [ ] **Step 2: Update `hermes/README.md`** for the renamed plugin, scripts and cron jobs.

- [ ] **Step 3: Verify every command and path** the README mentions still exists (`npm run` scripts, `scripts/*.sh` subcommands, file paths in the tree). A README that tells the owner to run a command that no longer exists is worse than a stale one.

- [ ] **Step 4: Commit.**

```bash
git add README.md hermes/README.md
git commit -m "docs: rewrite the README around what PharmaITChat does now"
```

---

### Task 4: The live cutover (with the owner)

This task changes the machine. **Ask the owner before each step**, and stop on any failure — the rollback is the previous step's inverse. The 02:30 watchlist job depends on steps 2–4 having finished, so do not abandon the cutover midway.

- [ ] **Step 1: Pre-flight.** `date`, confirm no Hermes job is due within the hour (`~/.hermes/cron/jobs.json`), record the current state: `hermes cron list`, `launchctl print gui/$(id -u)/com.pharmallm.mcp | head -3`, `curl -sk -H "Authorization: Bearer $(cat data/run/api-token)" https://127.0.0.1:3443/api/stack/status`.

- [ ] **Step 2: App onto the new code.** `scripts/switch-stack.sh $(cat data/run/active-stack)`. Verify: `/api/health` healthy, `/api/stack/status` answers, and one chat question returns an answer.

- [ ] **Step 3: MCP service.** `scripts/hermes-setup.sh install-services`. Verify: `launchctl print gui/$(id -u)/com.pharmaitchat.mcp` exists, the old `com.pharmallm.mcp` is gone (`launchctl print` fails for it), and `curl -sf http://127.0.0.1:3200/healthz` returns `{"ok":true,"pharmaitchat":true}`.

- [ ] **Step 4: Hermes config and plugin.** `scripts/hermes-setup.sh install-config` then `install-plugin`. Verify: `scripts/hermes-setup.sh check` reports `plugin pharmaitchat-switch: loaded by the running gateway`, and `/api/stack/status` shows `hermes_ready: true`. **This is the step most likely to fail** — the ready-file name changed on both sides. If `hermes_ready` is false, check `~/.hermes/pharmaitchat-switch.ready.json` exists and matches the gateway's pid.

- [ ] **Step 5: Cron jobs.** Delete the five old jobs **by id first** (`hermes cron delete <id>` for `7a0a53c100c1`, `3b891b4e0a7e`, `c080636d6a4f`, `071f59c0e11d`, `3f67415f05c4` — re-read the ids with `hermes cron list` in case they changed), then `scripts/hermes-setup.sh install-cron`. Verify: `hermes cron list` shows exactly five `pharmaitchat-*` jobs, the watchlist one at `30 2 * * *` in no-agent script mode, and `grep script_timeout_seconds ~/.hermes/config.yaml` still reads 7200.

- [ ] **Step 6: A real Telegram round trip.** The owner asks the bot a question and confirms it answers. This exercises the renamed provider and model end to end — a rename mistake in `~/.hermes/config.yaml` surfaces here as "resolved without credentials" or a model-not-found error.

- [ ] **Step 7: GitHub.** Rename the repo `PharmaCyberLLM` → `PharmaITChat` in the GitHub UI (the owner does this; `gh` auth is broken on this machine), then `git remote set-url origin git@github.com:sebdallais-git/PharmaITChat.git` and `git push`. Verify: `git ls-remote origin | head -1` succeeds.

- [ ] **Step 8: Record the cutover** in `docs/superpowers/plans/2026-09-20-pharmaitchat-rename-verification.md` — what each verification printed, anything that needed a second attempt — and commit.
