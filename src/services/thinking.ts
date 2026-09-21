// Thinking levels, per stack, and the splitter that keeps model reasoning out of
// the answer stream.
//
// The stacks are not interchangeable here: MLX drives a Qwen3 chat-template flag
// that is strictly on/off, while Ollama takes a graded reasoning_effort. Rather
// than inventing a shared vocabulary that lies on one of them, each stack
// declares what it can actually do and the UI renders that.
import type { StackConfig } from "../config/llm-stacks.js";

export type ThinkingLevel = "off" | "on" | "low" | "medium" | "high";

const BINARY: ThinkingLevel[] = ["off", "on"];
const GRADED: ThinkingLevel[] = ["off", "low", "medium", "high"];

/** The levels this stack can honour. Anything else is refused, never downgraded. */
export function thinkingLevels(stack: StackConfig): ThinkingLevel[] {
  return stack.name === "ollama" ? GRADED : BINARY;
}

export function isThinkingLevel(stack: StackConfig, value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (thinkingLevels(stack) as string[]).includes(value);
}

/** The request-body fragment that expresses `level` on `stack`. */
export function thinkingBody(stack: StackConfig, level: ThinkingLevel): Record<string, unknown> {
  if (!isThinkingLevel(stack, level)) {
    throw new Error(
      `thinking level "${level}" is not supported on the ${stack.name} stack ` +
        `(supported: ${thinkingLevels(stack).join(", ")})`,
    );
  }
  if (stack.name === "ollama") {
    return { reasoning_effort: level === "off" ? "none" : level };
  }
  return { chat_template_kwargs: { enable_thinking: level !== "off" } };
}
