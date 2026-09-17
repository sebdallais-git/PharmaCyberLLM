# Hermes Agent for PharmaLLM

Everything needed to run [Hermes Agent](https://hermes-agent.nousresearch.com/) as a Telegram assistant on PharmaLLM, on this Mac or on a second Mac on the LAN. Secrets never live here: they stay in `~/.hermes/.env` and `data/run/*-token` (mode 600).

| File | Purpose |
|---|---|
| `config.template.yaml` | Hermes config: PharmaLLM `/v1` model with 64k context, `pharmallm` MCP server (15 tools, no `start_reindex`), Docker sandbox without network, local SearXNG search, deny approvals when unattended |
| `SOUL.md` | Assistant role and tool policy |
| `cron/jobs.json` | Scheduled jobs: news digest 06:00, gap resolution 07:00, health watch 09/14/19 (silent when healthy), feedback digest Monday 08:00 |
| `com.pharmallm.mcp.plist.template` | launchd service for `pharmallm-mcp` |

## 1. Install Hermes (once)

The installer is pinned to a reviewed commit. It installs uv and Python into `~/.hermes`, clones Hermes to `~/.hermes/hermes-agent` and appends a PATH line to `~/.zshrc`, `~/.zprofile` and `~/.profile`. The flags skip the browser download, the third-party computer-use driver and the setup wizard.

```bash
HERMES_COMMIT=228022ef5b209cb0a3d739394edddf887e1db0f6
curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/$HERMES_COMMIT/scripts/install.sh" -o /tmp/hermes-install.sh
less /tmp/hermes-install.sh     # review before running
bash /tmp/hermes-install.sh --commit "$HERMES_COMMIT" --skip-setup --skip-browser --skip-computer-use --non-interactive
exec zsh -l && hermes --version
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

### Docker sandbox

The `terminal` toolset runs in a Docker container. Pull the image once before the first use — the first pull otherwise runs inside the tool-call timeout and the sandbox fails to start:

```bash
docker pull nikolaik/python-nodejs:python3.11-nodejs20
```

The sandbox is sized for a small VM (`container_cpu: 1`, `container_memory: 512`). The Docker VM must keep headroom beyond Neo4j and SearXNG, which already take about 700 MB of colima's 1.91 GB on this Mac; raise those two values only after giving the VM more RAM.

If `docker pull` hangs with no output, the daemon is wedged: `colima restart` clears it. That also restarts Neo4j and SearXNG, so PharmaLLM's graph and web search are briefly unavailable.

**Speed.** The first reply of a session takes about 1.5–2 minutes while the local 27B model reads Hermes' long prompt. Later steps take about 5–25 s. On Ollama, a PharmaLLM web chat between Hermes steps evicts Hermes' cached prompt, so the next step is slow again; MLX keeps several caches.

**Stack switches and benchmarks.** Hermes always uses the active stack. During a switch or a benchmark, PharmaLLM is unavailable or answers 503, and Hermes says so.

## Moving Hermes to a second Mac

On the PharmaLLM Mac, let the MCP service listen on the network (the token is required then):

```bash
launchctl setenv MCP_HOST 0.0.0.0 && scripts/switch-stack.sh mcp stop && scripts/switch-stack.sh mcp start
```

On the Hermes Mac, clone this repo, install Hermes (step 1), then set the URLs and copy the two token values into `~/.hermes/.env` by hand before running `scripts/hermes-setup.sh install-config`, `scripts/hermes-setup.sh install-cron` and `hermes gateway install --force --start-now --start-on-login`:

```
PHARMALLM_URL=http://<pharmallm-mac>:3000
PHARMALLM_MCP_URL=http://<pharmallm-mac>:3200/mcp
SEARXNG_URL=http://<pharmallm-mac>:8888
```

## Troubleshooting

- `hermes doctor --live` probes the model and MCP server.
- `hermes mcp test pharmallm` checks the MCP connection and lists tools.
- "context length below minimum": the gateway model must run with 65536 (`scripts/switch-stack.sh ollama-ctx`).
- MCP calls fail after 5 minutes: `pharmallm-mcp` must be the version that sends keepalives (restart it: `scripts/switch-stack.sh mcp stop && scripts/switch-stack.sh mcp start`).
