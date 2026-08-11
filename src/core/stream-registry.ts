import { metrics } from "./metrics.js";

const activeStreams = new Map<
  string,
  {
    abortController: AbortController;
    accountId: string;
    uiSessionId: string;
    targetResponseId: string;
    headers: Record<string, string>;
    /** True once at least one model chunk reached the client. */
    emittedChunk: boolean;
  }
>();

export function registerStream(
  key: string,
  entry: {
    abortController: AbortController;
    accountId: string;
    uiSessionId: string;
    targetResponseId: string;
    headers: Record<string, string>;
  },
): void {
  const existing = activeStreams.get(key);
  if (existing && existing.abortController !== entry.abortController) {
    existing.abortController.abort();
  }

  activeStreams.set(key, { emittedChunk: false, ...entry });
  metrics.gauge("streams.active", activeStreams.size);
}

export function getStream(key: string): ReturnType<typeof activeStreams.get> {
  return activeStreams.get(key);
}

export function getStreamKeysBySessionId(sessionId: string): string[] {
  const keys: string[] = [];
  for (const [key, entry] of activeStreams.entries()) {
    if (entry.uiSessionId === sessionId) {
      keys.push(key);
    }
  }
  return keys;
}

export function getStreamKeyBySessionAndResponse(
  sessionId: string,
  responseId: string,
): string | undefined {
  for (const [key, entry] of activeStreams.entries()) {
    if (
      entry.uiSessionId === sessionId &&
      entry.targetResponseId === responseId
    ) {
      return key;
    }
  }
  return undefined;
}

export function removeStream(key: string): void {
  activeStreams.delete(key);
  metrics.gauge("streams.active", activeStreams.size);
}

/**
 * Mark a stream as having emitted at least one model chunk to the client.
 * The emit-aware supersede uses this to avoid killing a generation the client
 * has not consumed yet (e.g. a parallel title request racing the main stream).
 */
export function markStreamEmitted(key: string): void {
  const entry = activeStreams.get(key);
  if (entry) {
    entry.emittedChunk = true;
  }
}

export function updateStreamTargetResponseId(
  key: string,
  targetResponseId: string,
): void {
  const entry = activeStreams.get(key);
  if (entry) {
    entry.targetResponseId = targetResponseId;
  }
}

export function updateStreamSessionId(key: string, uiSessionId: string): void {
  const entry = activeStreams.get(key);
  if (entry) {
    entry.uiSessionId = uiSessionId;
  }
}
