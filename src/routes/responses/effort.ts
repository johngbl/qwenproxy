/**
 * Normalize OpenAI / Codex / provider reasoning.effort values.
 *
 * Provider-compatible names (common across OpenAI, Codex, Cursor, agents):
 * - Max / high / xhigh  → thinking ON  (Qwen thinking_mode: "Thinking")
 * - Fast / none / low   → thinking OFF (Qwen thinking_mode: "Fast")
 * - medium              → thinking ON  (default mid-tier agents)
 *
 * Qwen upstream only has a boolean + Thinking|Fast — no true medium gradient.
 */

import { stripFastSuffix } from "../../core/model-registry.ts";

export type NormalizedEffort = "low" | "medium" | "high";

/** Human-facing / provider aliases → normalized. */
const EFFORT_ALIASES: Record<string, NormalizedEffort> = {
  // Fast path (thinking off)
  none: "low",
  off: "low",
  disable: "low",
  disabled: "low",
  minimal: "low",
  min: "low",
  low: "low",
  fast: "low",
  quick: "low",
  "thinking-off": "low",
  thinking_off: "low",
  "no-thinking": "low",
  no_thinking: "low",

  // Mid
  medium: "medium",
  med: "medium",
  default: "medium",

  // Max path (thinking on)
  high: "high",
  xhigh: "high",
  "x-high": "high",
  max: "high",
  maximum: "high",
  ultra: "high",
  deep: "high",
  thinking: "high",
  "thinking-on": "high",
  thinking_on: "high",
};

/**
 * Map any client-provided effort string to low|medium|high.
 * Unknown values fall back to "high" (prefer thinking for agentic clients like Codex).
 */
export function normalizeReasoningEffort(
  value: unknown,
): NormalizedEffort | undefined {
  if (value === null || value === undefined || value === "") return undefined;

  const key = String(value).trim().toLowerCase();
  if (!key) return undefined;

  if (EFFORT_ALIASES[key]) return EFFORT_ALIASES[key];

  // numeric 0-100 style (rare)
  const n = Number(key);
  if (Number.isFinite(n)) {
    if (n <= 33) return "low";
    if (n <= 66) return "medium";
    return "high";
  }

  console.warn(
    `[Responses] Unknown reasoning.effort '${value}' — defaulting to high`,
  );
  return "high";
}

/**
 * Whether this effort enables Qwen thinking.
 * medium/high → on; low → off.
 */
export function effortEnablesThinking(
  effort: NormalizedEffort | undefined,
  defaultWhenUnset = true,
): boolean {
  if (!effort) return defaultWhenUnset;
  return effort !== "low";
}

/**
 * Optionally rewrite the model id based on effort.
 * low/Fast → *-fast
 * medium/high/Max → the base model (Thinking)
 */
export function applyEffortToModel(
  model: string,
  effort: NormalizedEffort | undefined,
): string {
  if (!effort) return model;

  const base = stripFastSuffix(model);

  if (effort === "low") {
    return `${base}-fast`;
  }

  // medium/high: strip -fast so the base model enables Thinking.
  return base;
}
