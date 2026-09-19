import { describe, expect, it } from "@jest/globals";
import { createTelegramSender, readTelegramConfig, TelegramError } from "../src/services/telegram-notify.js";

const BOT_TOKEN = "123456:AA-secret-bot-token";
const CHAT_ID = "424242";

describe("readTelegramConfig", () => {
  it("reads both values from the environment", () => {
    expect(readTelegramConfig({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_CHAT_ID: CHAT_ID })).toEqual({
      botToken: BOT_TOKEN,
      chatId: CHAT_ID,
    });
  });

  it("treats blank or missing values as not configured", () => {
    expect(readTelegramConfig({ TELEGRAM_BOT_TOKEN: "  ", TELEGRAM_CHAT_ID: CHAT_ID })).toEqual({
      botToken: null,
      chatId: CHAT_ID,
    });
    expect(readTelegramConfig({})).toEqual({ botToken: null, chatId: null });
  });
});

describe("createTelegramSender", () => {
  it("posts the message to the bot API with the chat id in the body", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: JSON.parse(init?.body ?? "{}") });
      return { ok: true, status: 200, text: async () => "{}" };
    };

    const send = createTelegramSender({ botToken: BOT_TOKEN, chatId: CHAT_ID }, fetchImpl);
    await send("switch to omlx?");

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(calls[0].body).toEqual({ chat_id: CHAT_ID, text: "switch to omlx?", disable_web_page_preview: true });
  });

  it("throws a TelegramError without the token when the API refuses", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => "Unauthorized" });

    const send = createTelegramSender({ botToken: BOT_TOKEN, chatId: CHAT_ID }, fetchImpl);

    await expect(send("hello")).rejects.toThrow(TelegramError);
    await expect(send("hello")).rejects.toThrow(/telegram sendMessage failed \(401\)/);
    await expect(send("hello")).rejects.not.toThrow(new RegExp(BOT_TOKEN));
  });

  it("throws when it is not configured", async () => {
    const send = createTelegramSender({ botToken: null, chatId: CHAT_ID }, async () => {
      throw new Error("must not be called");
    });

    await expect(send("hello")).rejects.toThrow(/not configured/);
  });

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
});
