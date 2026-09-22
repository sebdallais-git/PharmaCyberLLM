import { describe, expect, it } from "@jest/globals";
import { sendTelegramDocument } from "../src/services/export-wiring.js";

// sendTelegramDocument takes an injected fetch so this suite never reaches a
// real Telegram server: config.botToken/chatId below are obvious
// placeholders, never real credentials.
describe("sendTelegramDocument", () => {
  it("posts the file to sendDocument with the chat id", async () => {
    let seenUrl = "";
    let seenBody: FormData | null = null;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenBody = (init?.body ?? null) as FormData | null;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await sendTelegramDocument("roche-brief.pdf", Buffer.from("x"), { botToken: "T", chatId: "42" }, fakeFetch);

    expect(seenUrl).toBe("https://api.telegram.org/botT/sendDocument");
    // Cast (not narrow) at the read site: TS's control-flow analysis does not
    // trace a `let` reassigned only inside a closure, so an un-cast
    // `seenBody?.get(...)` narrows the outer declaration's `null` initializer
    // straight to `never` here, regardless of what fakeFetch actually set.
    expect((seenBody as FormData | null)?.get("chat_id")).toBe("42");
  });

  it("throws when telegram rejects the upload", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;

    await expect(
      sendTelegramDocument("a.pdf", Buffer.from("x"), { botToken: "T", chatId: "42" }, fakeFetch),
    ).rejects.toThrow(/400/);
  });
});
