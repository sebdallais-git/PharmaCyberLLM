import { describe, expect, it } from "@jest/globals";
import { parseCompletionRequest } from "../src/api/llm.js";

describe("parseCompletionRequest", () => {
  it("accepts an Ollama /api/generate body and ignores model and stream", () => {
    expect(parseCompletionRequest({ model: "gemma2:9b", prompt: "Summarize", stream: false })).toEqual({
      prompt: "Summarize",
    });
  });

  it("keeps a numeric temperature", () => {
    expect(parseCompletionRequest({ prompt: "Rate this", temperature: 0.1 })).toEqual({
      prompt: "Rate this",
      temperature: 0.1,
    });
  });

  it("accepts an Ollama-shaped options.temperature when there is no top-level temperature", () => {
    expect(parseCompletionRequest({ prompt: "Rate this", options: { temperature: 0.2 } })).toEqual({
      prompt: "Rate this",
      temperature: 0.2,
    });
    expect(parseCompletionRequest({ prompt: "Rate this", temperature: 0.1, options: { temperature: 0.9 } })).toEqual({
      prompt: "Rate this",
      temperature: 0.1,
    });
    expect(parseCompletionRequest({ prompt: "Rate this", options: { temperature: "hot" } })).toEqual({
      prompt: "Rate this",
    });
  });

  it("rejects a missing or blank prompt", () => {
    expect(parseCompletionRequest({})).toEqual({ error: "The 'prompt' field is required" });
    expect(parseCompletionRequest({ prompt: "   " })).toEqual({ error: "The 'prompt' field is required" });
    expect(parseCompletionRequest(null)).toEqual({ error: "The 'prompt' field is required" });
  });
});
