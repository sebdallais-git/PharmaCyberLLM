# Rename to PharmaITChat

## Overview

The product is no longer "pharma cyber". It watches the IT vendor scene, three customers and their
competitors, across ten IT domains — and the chat page still says *CyberPharmaCHAT — Cyber Threat
Expert Assistant*. This renames everything to **PharmaITChat**, rewrites the chat page's copy to
describe what the system actually does now, and rewrites the README around the current capability
rather than its origin story.

It is a cutover, not a refactor: no behaviour changes, but identifiers that live services depend on
move, so the order of operations and the verification after each step are the whole design.

## Decisions

| Topic | Decision |
|---|---|
| Name | `PharmaITChat` everywhere; identifiers `pharmaitchat-*`, launchd `com.pharmaitchat.mcp`, model `pharmaitchat-local`, provider `custom:pharmaitchat` |
| Chat UI | Title, header and subtitle renamed; copy rewritten for the broadened scope; the stale "194 topics" news-agent paragraph replaced |
| README | Rewritten around what exists now: three stacks, local-only inference, the watchlist, Hermes, the MCP server |
| GitHub repo | `PharmaCyberLLM` → `PharmaITChat`, remote URL updated |
| Filesystem path | **Unchanged** (`/Users/seb/claude/PharmaLLM`) — see "What deliberately does not move" |
| `~/.hermes/.env` | **Not edited by us** (CLAUDE.md forbids touching .env). The app accepts `PHARMAITCHAT_*` and falls back to `PHARMALLM_*`, so the owner can rename the keys whenever he likes |
| ChromaDB collections | **Unchanged** (`knowledge_base_mlx` / `knowledge_base_ollama`) — they are named after the embedding stack, not the product |
| SQLite files | **Unchanged** (`data/gap_log.db`, `data/watchlist.db`) — no product name inside |
| Old cron jobs | Deleted by id before the renamed ones are created, so the rename cannot silently double every scheduled job |

## What moves

**Code and config in the repo**
- `public/index.html`, `public/app.js` — brand and copy.
- `mcp/src/mcp-server.ts` — `SERVER_INFO.name: "pharmallm"` → `"pharmaitchat"`, and the 117 other
  occurrences across `mcp/`.
- `src/` — 8 occurrences, including the env-var reader that gains the fallback.
- `hermes/config.template.yaml` — provider key, model name, `plugins.enabled`, cron model refs.
- `hermes/cron/jobs.json` — the five job names.
- `hermes/plugins/pharmallm-switch/` → `hermes/plugins/pharmaitchat-switch/`, its `plugin.yaml`
  name, the ready-file name, and `src/services/hermes-readiness.ts`'s path for it.
- `hermes/scripts/pharmallm-watchlist-ingest.sh` → `pharmaitchat-watchlist-ingest.sh`.
- `hermes/com.pharmallm.mcp.plist.template` → `com.pharmaitchat.mcp.plist.template`.
- `scripts/hermes-setup.sh`, `scripts/switch-stack.sh` and the rest of `scripts/` — 15 occurrences,
  including the launchd label and the plugin/script install paths.
- Tests that pin any of the above.

**Live state on the machine (the cutover)**
- The launchd agent: boot out `com.pharmallm.mcp`, install `com.pharmaitchat.mcp`.
- `~/.hermes/config.yaml`: rewritten by `install-config` from the renamed template.
- `~/.hermes/plugins/pharmallm-switch/` → the renamed plugin, gateway restarted.
- `~/.hermes/scripts/`: the renamed wrapper.
- The five cron jobs: deleted by id, then recreated with the new names.
- The GitHub repo name and the local remote URL.

## What deliberately does not move

- **The filesystem path.** `/Users/seb/claude/PharmaLLM` is baked into the launchd plist, the cron
  wrapper, two git worktree registrations and the running app's working directory. Moving it buys a
  tidier `pwd` and risks every one of those. The repo on GitHub is renamed; the local folder stays.
- **`~/.hermes/.env`.** CLAUDE.md forbids touching .env files. The app reads `PHARMAITCHAT_API_TOKEN`
  and falls back to `PHARMALLM_API_TOKEN` (same for `_MCP_TOKEN`, `_URL`, `_MCP_URL`), so nothing
  breaks and the owner renames the keys when it suits him. The fallback is documented as temporary.
- **ChromaDB collections and the SQLite files.** Renaming a collection means re-embedding 439 MB.
  The names describe the embedding stack, not the product.
- **`data/run/` filenames.** `api-token`, `mcp-token`, `active-stack` carry no product name.

## Cutover order

Each step verifies before the next begins. Any failure stops the cutover and the rollback is the
previous step's inverse.

1. **Repo changes committed** (code, config templates, plugin and script renames, tests, docs).
   Verify: full suite green, `npm run typecheck`, and no `pharmallm` left outside the documented
   fallback (`grep -ril pharmallm` reviewed by hand).
2. **App restart** onto the new code: `scripts/switch-stack.sh $(cat data/run/active-stack)`.
   Verify: `/api/health` healthy, `/api/stack/status` answers, chat answers one question.
3. **MCP service**: `hermes-setup.sh install-services` installs `com.pharmaitchat.mcp` after booting
   out the old label. Verify: `launchctl print` finds the new label, `/healthz` reports
   `pharmallm: true` (field name unchanged inside the MCP service's own payload), old label gone.
4. **Hermes config and plugin**: `install-config` + `install-plugin`, gateway restarted.
   Verify: `hermes-setup.sh check` reports the plugin loaded by the running gateway, and
   `/api/stack/status` shows `hermes_ready: true` — the readiness path changed name, so this is the
   step most likely to fail.
5. **Cron jobs**: delete the five old jobs by id, then `install-cron`. Verify: `hermes cron list`
   shows exactly five jobs, all `pharmaitchat-*`, with the watchlist job at 02:30 and
   `script_timeout_seconds` still 7200.
6. **A real Telegram round trip**: send the bot a question, confirm it answers through the local
   stack. This exercises the renamed provider and model names end to end.
7. **GitHub**: rename the repo, update `origin`, push.

## Rollback

Every step is reversible with the inverse command, and the repo changes are one revert. The two
irreversible-looking steps are not: deleting cron jobs is recoverable by re-running `install-cron`
against the old template (kept in git history), and a GitHub rename leaves a redirect from the old
name. Nothing in the cutover touches the knowledge base, the item store or the tokens.

## Risks

- **The 02:30 watchlist run is tonight.** The cutover renames the wrapper script, the cron job and
  the plugin it depends on. If the cutover finishes cleanly this is fine; if it is abandoned midway,
  the job must be left in a working state — that is why cron is step 5, after the pieces it calls.
- **The Hermes readiness path** (`pharmaitchat-switch.ready.json`) must change in the app and the
  plugin together, or `hermes_ready` goes false and UI switches are refused. Step 4 verifies it.
- **Duplicate cron jobs** if the old ones are not deleted first: `install-cron` matches by name.
- **The MCP `/healthz` payload** has a `pharmallm` boolean field. Renaming the field would break
  `hermes-setup.sh check`'s parser; both move together or neither does.

## Out of scope

- Moving the filesystem path.
- Editing `~/.hermes/.env`.
- Re-embedding or renaming ChromaDB collections.
- Any behaviour change: this cutover adds no feature and removes none.
