// Stack switching for the browser UI. The route itself needs no token: approval arrives out of band,
// as a one-time link in a Telegram message. The spawned script outlives the app it restarts.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Router } from "express";
import type { Request, Response } from "express";
import { getActiveStack, isStackName, STACK_NAMES } from "../config/llm-stacks.js";
import type { StackName } from "../config/llm-stacks.js";
import { getRunningJobs, isBenchmarkActive } from "../services/bench-mode.js";
import { createStackSwitch, parseProgress } from "../services/stack-switch.js";
import type { StackSwitch, SwitchProgress } from "../services/stack-switch.js";
import { createTelegramSender, isTelegramConfigured, readTelegramConfig } from "../services/telegram-notify.js";
import type { TelegramSender } from "../services/telegram-notify.js";

const PROGRESS_FILE = join(process.cwd(), "data", "run", "stack-switch.json");

export interface StackRouterDeps {
  switcher: StackSwitch;
  sendTelegram: TelegramSender;
  spawnSwitch(target: StackName): void;
  activeStack(): StackName;
  readProgress(): SwitchProgress | null;
  confirmBaseUrl(): string;
  telegramConfigured(): boolean;
}

export function createStackRouter(deps: StackRouterDeps): Router {
  const router = Router();

  router.post("/switch", async (req: Request, res: Response): Promise<void> => {
    const target = (req.body as { stack?: unknown } | undefined)?.stack;
    if (!isStackName(target)) {
      res.status(400).json({ error: "Unknown stack (expected ollama, mlx or omlx)" });
      return;
    }
    if (!deps.telegramConfigured()) {
      res.status(409).json({
        reason: "telegram_unconfigured",
        error: "Telegram confirmation is not configured (scripts/switch-stack.sh telegram)",
      });
      return;
    }
    const outcome = deps.switcher.request(target);
    if (!outcome.ok) {
      res.status(409).json({ reason: outcome.reason, error: outcome.message });
      return;
    }
    const link = `${deps.confirmBaseUrl()}/api/stack/confirm?token=${outcome.pending.token}`;
    try {
      await deps.sendTelegram(
        `PharmaLLM: switch the LLM stack from ${deps.activeStack()} to ${target}?\n` +
          `Confirm within 5 minutes:\n${link}\n` +
          `If you did not ask for this, ignore this message and nothing happens.`
      );
    } catch (err) {
      // Drop the pending switch: nobody was asked, so nobody can confirm
      deps.switcher.confirm(outcome.pending.token);
      // Log the detail server-side only: the underlying error can carry the bot token (e.g. in a
      // fetch failure's URL), and this response reaches the browser
      console.error(`stack switch: Telegram send failed: ${err instanceof Error ? err.message : "unknown error"}`);
      res.status(502).json({ error: "Could not send the Telegram confirmation. Check the Telegram bot configuration and try again." });
      return;
    }
    res.status(202).json({
      status: "pending_confirmation",
      target,
      expires_at: outcome.pending.expiresAt,
    });
  });

  router.get("/confirm", (req: Request, res: Response): void => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const pending = deps.switcher.confirm(token);
    if (!pending) {
      res.status(410).type("html").send("<h1>Link expired</h1><p>Request the switch again from PharmaLLM.</p>");
      return;
    }
    deps.spawnSwitch(pending.target);
    res
      .status(200)
      .type("html")
      .send(`<h1>Switching to ${pending.target}</h1><p>PharmaLLM restarts in a moment. You can close this page.</p>`);
  });

  router.get("/status", (_req: Request, res: Response): void => {
    const pending = deps.switcher.pending();
    res.json({
      active: deps.activeStack(),
      stacks: STACK_NAMES,
      telegram_configured: deps.telegramConfigured(),
      pending: pending ? { target: pending.target, expires_at: pending.expiresAt } : null,
      progress: deps.readProgress(),
    });
  });

  return router;
}

function readProgressFile(): SwitchProgress | null {
  try {
    return parseProgress(JSON.parse(readFileSync(PROGRESS_FILE, "utf-8")) as unknown);
  } catch {
    return null;
  }
}

const telegramConfig = readTelegramConfig();

export default createStackRouter({
  switcher: createStackSwitch({
    now: () => Date.now(),
    newId: () => randomUUID(),
    newToken: () => randomUUID().replace(/-/g, ""),
    activeStack: () => getActiveStack().name,
    isBenchmarkActive: () => isBenchmarkActive(),
    runningJobs: () => getRunningJobs(),
    currentProgress: readProgressFile,
  }),
  sendTelegram: createTelegramSender(telegramConfig),
  spawnSwitch: (target) => {
    // Detached: switch-stack.sh stops this very app, so the child must outlive it
    const child = spawn(join(process.cwd(), "scripts", "switch-stack.sh"), [target], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
    });
    // Without this, a missing script or a lost executable bit throws an unhandled 'error' event
    // after the confirm page already told the owner it worked
    child.on("error", (err) => console.error(`stack switch spawn failed: ${err.message}`));
    child.unref();
  },
  activeStack: () => getActiveStack().name,
  readProgress: readProgressFile,
  confirmBaseUrl: () => process.env.PHARMALLM_PUBLIC_URL ?? "http://localhost:3000",
  telegramConfigured: () => isTelegramConfigured(telegramConfig),
});
