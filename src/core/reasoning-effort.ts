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

import { stripFastSuffix } from "./model-registry.ts";

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
    `[Effort] Unknown reasoning effort '${value}' — defaulting to high`,
  );
  return "high";
}

/**
 * Returns the clean, canonical model id, stripping any legacy suffix.
 */
export function applyEffortToModel(
  model: string,
  _effort: NormalizedEffort | undefined,
): string {
  return model.replace(/-(?:low|medium|high|fast|no-thinking|thinking)$/, "");
}

/**
 * Chat-completions mapping: effort -> Qwen reasoning mode.
 * - low    → "fast"     (thinking OFF / Fast mode)
 * - medium → "auto"     (thinking AUTO / Qwen decides dynamically)
 * - high   → "thinking" (thinking ON / forced reasoning mode)
 */
export function effortToReasoningMode(
  effort: NormalizedEffort | undefined,
): "fast" | "auto" | "thinking" | undefined {
  if (effort === "low") return "fast";
  if (effort === "medium") return "auto";
  if (effort === "high") return "thinking";
  return undefined;
}
