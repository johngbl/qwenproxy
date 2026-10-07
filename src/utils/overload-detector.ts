/**
 * Upstream Qwen overload response detector.
 *
 * When Qwen Web servers are overloaded, the model sometimes generates
 * an in-band plain text apology (HTTP 200 SSE) instead of a structured error:
 *   - "Estamos com alta demanda no momento. Tente novamente mais tarde."
 *   - "We are experiencing high demand right now."
 *   - "The server is busy, please try again later."
 *
 * Detecting these in-band messages before emitting output to the client allows
 * QwenProxy to quarantine the overloaded account and auto-retry on another
 * account transparently, so coding agents (Claude Code, OpenCode, Codex)
 * never receive plain text error apologies as assistant responses.
 */

const OVERLOAD_PATTERNS = [
  /high\s+demand/i,
  /problem\s+connecting/i,
  /try\s+again\s+later/i,
  /temporarily\s+unavailable/i,
  /service\s+(is\s+)?overloaded/i,
  /too\s+many\s+requests/i,
  /server\s+is\s+busy/i,
  /experiencing\s+high\s+(traffic|volume|load)/i,
  /unable\s+to\s+connect/i,
  /connection\s+(problem|error|issue)/i,
  /alta\s+demanda/i,
  /problema\s+de\s+conex/i,
  /tente\s+novamente\s+mais\s+tarde/i,
  /servidor\s+ocupado/i,
  /indispon[íi]vel\s+no\s+momento/i,
  /servi[çc]o\s+est[áa]\s+com\s+alta\s+demanda/i,
];

export const OVERLOAD_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export function isOverloadMessage(content: string | null | undefined): boolean {
  if (!content) return false;
  const text = content.trim();

  // Overload apologies are always short (typically 20-150 characters)
  if (!text || text.length > 500) return false;

  // Never match legitimate code blocks, markdown structures or tool calls
  if (
    text.includes("```") ||
    text.includes("<tool_call") ||
    text.includes("<qpx_call") ||
    text.includes("</")
  ) {
    return false;
  }

  return OVERLOAD_PATTERNS.some((pattern) => pattern.test(text));
}
