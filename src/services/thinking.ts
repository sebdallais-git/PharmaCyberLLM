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

const OPEN = "<think>";
const CLOSE = "</think>";

/** The longest suffix of `text` that could still become `tag`. */
function danglingPrefix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (text.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

export interface ThinkingSplit {
  thinking: string;
  answer: string;
}

/**
 * Stateful splitter for a token stream containing `<think>...</think>`.
 *
 * Tags routinely straddle chunk boundaries, so any partial tag at the end of a
 * chunk is held back rather than emitted -- emitting it would leak `<thi` into
 * the answer, and the answer is what the MCP client concatenates for Telegram.
 */
export function splitThinking(): { push(chunk: string): ThinkingSplit } {
  let buffer = "";
  let inside = false;

  return {
    push(chunk: string): ThinkingSplit {
      buffer += chunk;
      let thinking = "";
      let answer = "";

      for (;;) {
        const tag = inside ? CLOSE : OPEN;
        const at = buffer.indexOf(tag);
        if (at === -1) break;
        const before = buffer.slice(0, at);
        if (inside) thinking += before;
        else answer += before;
        buffer = buffer.slice(at + tag.length);
        inside = !inside;
      }

      // Keep back anything that might still turn into a tag.
      const hold = danglingPrefix(buffer, inside ? CLOSE : OPEN);
      const emit = buffer.slice(0, buffer.length - hold);
      buffer = buffer.slice(buffer.length - hold);

      if (inside) thinking += emit;
      else answer += emit;

      return { thinking, answer };
    },
  };
}
