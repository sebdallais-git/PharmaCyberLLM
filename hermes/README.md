# Hermes Agent for PharmaLLM

Everything needed to run [Hermes Agent](https://hermes-agent.nousresearch.com/) as a Telegram assistant on PharmaLLM, on this Mac or on a second Mac on the LAN. Secrets never live here: they stay in `~/.hermes/.env` and `data/run/*-token` (mode 600).

| File | Purpose |
|---|---|
| `config.template.yaml` | Hermes config: PharmaLLM `/v1` model with 64k context, `pharmallm` MCP server (15 tools, no `start_reindex`), a `pharmallm_cron` server for scheduled runs (14 tools, also no `add_knowledge`), Docker sandbox without network, local SearXNG search, deny approvals when unattended |
| `SOUL.md` | Assistant role and tool policy |
| `cron/jobs.json` | Scheduled jobs: news digest 06:00, gap resolution 07:00, health watch 09/19 (silent when healthy), feedback digest Monday 08:00 |
| `com.pharmallm.mcp.plist.template` | launchd service for `pharmallm-mcp` |

## 1. Install Hermes (once)

The installer is pinned to a reviewed commit. It installs uv and Python into `~/.hermes`, clones Hermes to `~/.hermes/hermes-agent` and appends a PATH line to `~/.zshrc`, `~/.zprofile` and `~/.profile`. The flags skip the browser download, the third-party computer-use driver and the setup wizard.

```bash
HERMES_COMMIT=228022ef5b209cb0a3d739394edddf887e1db0f6
curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/$HERMES_COMMIT/scripts/install.sh" -o /tmp/hermes-install.sh
less /tmp/hermes-install.sh     # review before running
bash /tmp/hermes-install.sh --commit "$HERMES_COMMIT" --skip-setup --skip-browser --skip-computer-use --non-interactive
exec zsh -l
```

`exec` replaces the shell, so anything after it on the same line never runs. Check the install in the new shell:

```bash
hermes --version
```

## 2. Create the Telegram bot

1. In Telegram, message **@BotFather**, send `/newbot` and copy the bot token.
2. Message **@userinfobot** to get your numeric user ID.
3. Put both in `~/.hermes/.env` yourself (never paste them into a chat or command line):

```bash
mkdir -p ~/.hermes && touch ~/.hermes/.env && chmod 600 ~/.hermes/.env
nano ~/.hermes/.env
# TELEGRAM_BOT_TOKEN=<token from BotFather>
# TELEGRAM_ALLOWED_USERS=<your numeric id>
```

## 3. Configure and start

`scripts/hermes-setup.sh` needs the system `python3` (`/usr/bin/python3`, from the Command Line Tools: `xcode-select --install`). Re-run `install-services` after changing Node versions — the launch agent records an absolute `node` path, so the service dies when that path disappears.

```bash
scripts/switch-stack.sh token          # PharmaLLM API token (skip if it exists)
scripts/switch-stack.sh mcp-token      # token Hermes uses for pharmallm-mcp
scripts/hermes-setup.sh all            # config, .env, launchd services, cron jobs
scripts/hermes-setup.sh check          # read-only status; prints variable names, never values
```

`install-config` copies the template and `SOUL.md` into `~/.hermes` (a changed file is backed up first) and fills `~/.hermes/.env`:

| Variable | Value |
|---|---|
| `PHARMALLM_URL` | `http://localhost:3000` |
| `PHARMALLM_MCP_URL` | `http://127.0.0.1:3200/mcp` |
| `SEARXNG_URL` | `http://localhost:8888` |
| `PHARMALLM_API_TOKEN` | from `data/run/api-token` |
| `PHARMALLM_MCP_TOKEN` | from `data/run/mcp-token` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS` | you add them (step 2) |
| `TELEGRAM_HOME_CHANNEL` | defaults to the first id in `TELEGRAM_ALLOWED_USERS`, so scheduled jobs reach your DM |

## Operations

| Task | Command |
|---|---|
| Gateway (Telegram + cron) | `hermes gateway status\|restart\|stop` — logs in `~/.hermes/logs/gateway.log` |
| MCP service | `scripts/switch-stack.sh mcp status\|start\|stop` — logs in `data/logs/mcp.log` |
| Scheduled jobs | `hermes cron list`, `hermes cron run <id>` (runs on the next scheduler tick) |
| One-shot question | `hermes chat -q "…" --format stream-json` (shows each tool call) |
| Update jobs or config after editing this folder | `scripts/hermes-setup.sh install-config` or `install-cron` |
| Switch the LLM stack | `scripts/switch-stack.sh omlx` (or `ollama`/`mlx`) — Hermes follows the active stack, so this also moves the agent, no Hermes change needed |

**After a reboot.** `com.pharmallm.mcp` and the Hermes gateway come back on their own; the PharmaLLM app and the model stack do not (they have no launch agent). Run `scripts/start-services.sh` (or `scripts/switch-stack.sh ollama`) before the first job fires — until then `/healthz` reports `pharmallm:false`, `scripts/hermes-setup.sh check` says `pharmallm-mcp: up, PharmaLLM not reachable`, and the scheduled jobs deliver failure messages.

### Docker sandbox

The `terminal` toolset runs in a Docker container. Pull the image once before the first use — the first pull otherwise runs inside the tool-call timeout and the sandbox fails to start:

```bash
docker pull nikolaik/python-nodejs:python3.11-nodejs20
```

The sandbox is sized for a small VM (`container_cpu: 1`, `container_memory: 512`). The Docker VM must keep headroom beyond Neo4j and SearXNG, which already take about 700 MB of colima's 1.91 GB on this Mac; raise those two values only after giving the VM more RAM.

If `docker pull` hangs with no output, the daemon is wedged: `colima restart` clears it. That also restarts Neo4j and SearXNG, so PharmaLLM's graph and web search are briefly unavailable.

**Speed and GPU budget (measured).** Every Hermes step is a full cold prefill of about 160 s: Hermes' prompt prefix changes from request to request, so the prompt cache never hits. A Telegram answer with 3–4 tool calls therefore takes about 10–20 minutes, and the four scheduled jobs on this branch's schedule cost about 45–55 minutes of GPU per day. A PharmaLLM web chat between two Hermes steps evicts the shared Ollama prompt cache, so nothing is saved even when a prefix would have matched.

**Stack switches and benchmarks.** Hermes always uses the active stack. During a switch or a benchmark, PharmaLLM is unavailable or answers 503, and Hermes says so.

## Moving Hermes to a second Mac

On the PharmaLLM Mac, let the MCP service listen on the network:

```bash
MCP_HOST=0.0.0.0 scripts/hermes-setup.sh install-services
```

This bakes `MCP_HOST` into the launch agent, so it survives a reboot — `launchctl setenv` would not, and `run-mcp.sh` would silently fall back to loopback. An MCP token is then required: `run-mcp.sh` refuses to listen on a non-loopback host without one (`scripts/switch-stack.sh mcp-token`).

On the Hermes Mac, clone this repo, install Hermes (step 1), then set the URLs and copy the two token values into `~/.hermes/.env` by hand before running `scripts/hermes-setup.sh install-config`, `scripts/hermes-setup.sh install-cron` and `hermes gateway install --force --start-now --start-on-login`:

```
PHARMALLM_URL=http://<pharmallm-mac>:3000
PHARMALLM_MCP_URL=http://<pharmallm-mac>:3200/mcp
SEARXNG_URL=http://<pharmallm-mac>:8888
```

On the Hermes Mac, `scripts/hermes-setup.sh check` reports `service com.pharmallm.mcp: not loaded` by design: that service runs on the PharmaLLM Mac, so its absence here is expected and not a fault. To make the health line meaningful there, point the probe at the other Mac: `MCP_HEALTH_URL=http://<pharmallm-mac>:3200/healthz scripts/hermes-setup.sh check`.

## Troubleshooting

- `hermes doctor --live` probes the model and MCP server.
- `hermes mcp test pharmallm` checks the MCP connection and lists tools.
- "context length below minimum": the gateway model must run with 65536 (`scripts/switch-stack.sh ollama-ctx`).
- MCP calls fail after 5 minutes: `pharmallm-mcp` must be the version that sends keepalives (restart it: `scripts/switch-stack.sh mcp stop && scripts/switch-stack.sh mcp start`).
