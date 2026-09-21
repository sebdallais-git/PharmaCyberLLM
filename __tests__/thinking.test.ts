import { describe, expect, it } from "@jest/globals";
import { buildStacks } from "../src/config/llm-stacks.js";
import { thinkingBody, thinkingLevels, isThinkingLevel } from "../src/services/thinking.js";
import { splitThinking } from "../src/services/thinking.js";

const stacks = buildStacks({});

describe("thinking capability per stack", () => {
  // The two stacks express thinking incompatibly: MLX drives a Qwen3 chat
  // template flag that is strictly on/off, while Ollama takes a graded
  // reasoning_effort. The UI renders whatever the active stack declares, so a
  // level is never silently downgraded.
  it("declares on/off for the MLX stacks", () => {
    expect(thinkingLevels(stacks.mlx)).toEqual(["off", "on"]);
    expect(thinkingLevels(stacks.omlx)).toEqual(["off", "on"]);
  });

  it("declares graded levels for the Ollama stack", () => {
    expect(thinkingLevels(stacks.ollama)).toEqual(["off", "low", "medium", "high"]);
  });

  it("maps MLX levels onto the chat-template flag", () => {
    expect(thinkingBody(stacks.mlx, "off")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(thinkingBody(stacks.mlx, "on")).toEqual({ chat_template_kwargs: { enable_thinking: true } });
  });

  it("maps Ollama levels onto reasoning_effort", () => {
    expect(thinkingBody(stacks.ollama, "off")).toEqual({ reasoning_effort: "none" });
    expect(thinkingBody(stacks.ollama, "high")).toEqual({ reasoning_effort: "high" });
  });

  it("rejects a level the active stack does not declare", () => {
    // A silent downgrade is what makes a graded UI a lie on a binary stack.
    expect(() => thinkingBody(stacks.mlx, "high")).toThrow(/high.*mlx/i);
  });

  it("recognises only declared levels", () => {
    expect(isThinkingLevel(stacks.ollama, "medium")).toBe(true);
    expect(isThinkingLevel(stacks.mlx, "medium")).toBe(false);
  });
});

describe("splitThinking", () => {
  // The model emits <think>...</think> inline. Tags split across stream chunks,
  // which is exactly where a naive implementation breaks.
  it("separates thinking from the answer in a single chunk", () => {
    const s = splitThinking();

    expect(s.push("<think>weighing options</think>the answer")).toEqual({
      thinking: "weighing options",
      answer: "the answer",
    });
  });

  it("handles a tag split across chunk boundaries", () => {
    const s = splitThinking();

    expect(s.push("<thi")).toEqual({ thinking: "", answer: "" });
    expect(s.push("nk>partial")).toEqual({ thinking: "partial", answer: "" });
    expect(s.push(" more</thi")).toEqual({ thinking: " more", answer: "" });
    expect(s.push("nk>done")).toEqual({ thinking: "", answer: "done" });
  });

  it("treats text with no tags as answer", () => {
    const s = splitThinking();

    expect(s.push("plain answer")).toEqual({ thinking: "", answer: "plain answer" });
  });

  it("does not leak a partial closing tag into the answer", () => {
    const s = splitThinking();
    s.push("<think>reasoning");

    expect(s.push("</th")).toEqual({ thinking: "", answer: "" });
    expect(s.push("ink>visible")).toEqual({ thinking: "", answer: "visible" });
  });
});
