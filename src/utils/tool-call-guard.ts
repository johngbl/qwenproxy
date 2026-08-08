import type { Message } from "./types.ts";

/**
 * Detects tool calls that were already executed (identical name + arguments)
 * earlier in the conversation and returns a short system reminder to be
 * appended to the prompt. This breaks the re-read/re-inspect loops where the
 * model keeps calling the same tool turn after turn instead of answering.
 *
 * The reminder is prompt-only and does not alter caching, session identity or
 * the upstream thread.
 *
 * @param messages - Full message history (assistant tool_calls + tool/function results).
 * @param threshold - Minimum number of identical executions before reminding.
 * @returns Reminder text to append to the prompt, or null when the history is clean.
 */
export function buildRepeatedToolCallReminder(
  messages: Message[] | null | undefined,
  threshold = 2,
): string | null {
  if (!messages || messages.length === 0 || threshold < 2) return null;

  // Canonical key: tool name + normalized arguments (object key order ignored).
  const occurrences = new Map<string, number>();
  let lastToolCallTurnIndex = -1;

  for (let i = 0; i < messages.length; i++) {
    const calls = messages[i]?.tool_calls;
    if (!calls || calls.length === 0) continue;
    lastToolCallTurnIndex = i;
    for (const call of calls) {
      const key = toolCallKey(call.function?.name, call.function?.arguments);
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }
  }

  if (lastToolCallTurnIndex < 0) return null;

  const lastCalls = messages[lastToolCallTurnIndex].tool_calls ?? [];
  const reminders: string[] = [];

  for (const call of lastCalls) {
    const key = toolCallKey(call.function?.name, call.function?.arguments);
    const count = occurrences.get(key) ?? 0;
    if (count >= threshold) {
      reminders.push(
        `[SYSTEM REMINDER] You have already executed the tool call "${call.function?.name}" ${count} time(s) in this conversation with exactly the same arguments, and its result is already in the history. Do NOT call it again: use the existing result and write the final answer now. If the earlier attempts were rejected, do not repeat them either; answer directly.`,
      );
    }
  }

  return reminders.length > 0
    ? reminders.join("\n\n")
    : null;
}

function toolCallKey(name: string | undefined, rawArgs: string | undefined): string {
  const toolName = typeof name === "string" ? name : "";
  const raw = typeof rawArgs === "string" ? rawArgs : "";
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable payloads fall back to the raw string as the key.
  }
  return `${toolName}|${JSON.stringify(canonicalize(parsed))}`;
}

/**
 * Deep-normalizes JSON values so that argument objects with different key
 * orders or whitespace still produce the same canonical key.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = canonicalize(record[key]);
    }
    return result;
  }
  return value;
}