// Thinking levels, per stack, and the splitter that keeps model reasoning out of
// the answer stream.
//
// The stacks are not interchangeable here: mlx and omlx drive a Qwen3 chat-template
// flag that is strictly on/off, while Ollama and Splash take a graded reasoning_effort. Rather
// than inventing a shared vocabulary that lies on one of them, each stack
// declares what it can actually do and the UI renders that.
import type { StackConfig } from "../config/llm-stacks.js";

export type ThinkingLevel = "off" | "on" | "low" | "medium" | "high";

const BINARY: ThinkingLevel[] = ["off", "on"];
const GRADED: ThinkingLevel[] = ["off", "low", "medium", "high"];

// Splash's server accepts reasoning_effort like Ollama does; sending it mlx's
// chat_template_kwargs is a field it does not read.
function usesReasoningEffort(stack: StackConfig): boolean {
  return stack.name === "ollama" || stack.name === "splash";
}

/** The levels this stack can honour. Anything else is refused, never downgraded. */
export function thinkingLevels(stack: StackConfig): ThinkingLevel[] {
  return usesReasoningEffort(stack) ? GRADED : BINARY;
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
  if (usesReasoningEffort(stack)) {
    return { reasoning_effort: level === "off" ? "none" : level };
  }
  return { chat_template_kwargs: { enable_thinking: level !== "off" } };
}
