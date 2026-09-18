// Outbound-only Telegram messages. The app never polls for updates: Hermes' gateway is the single
// allowed consumer of that bot's getUpdates stream.

export interface TelegramConfig {
  botToken: string | null;
  chatId: string | null;
}

export interface TelegramResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface TelegramFetch {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<TelegramResponse>;
}

export interface TelegramSender {
  (text: string): Promise<void>;
}

export class TelegramError extends Error {}

export function readTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  return {
    botToken: env.TELEGRAM_BOT_TOKEN?.trim() || null,
    chatId: env.TELEGRAM_CHAT_ID?.trim() || null,
  };
}

export function isTelegramConfigured(config: TelegramConfig): boolean {
  return config.botToken !== null && config.chatId !== null;
}

const defaultFetch: TelegramFetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }) as unknown as Promise<TelegramResponse>;

export function createTelegramSender(config: TelegramConfig, fetchImpl: TelegramFetch = defaultFetch): TelegramSender {
  return async (text: string) => {
    if (!isTelegramConfigured(config)) {
      throw new TelegramError("telegram is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)");
    }
    let response: TelegramResponse;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.chatId, text, disable_web_page_preview: true }),
      });
    } catch (err) {
      // Never include the URL: it carries the bot token
      throw new TelegramError(`telegram sendMessage failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!response.ok) {
      throw new TelegramError(`telegram sendMessage failed (${response.status})`);
    }
  };
}
