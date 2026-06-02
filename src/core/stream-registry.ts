import { metrics } from "./metrics.js";

const activeStreams = new Map<
  string,
  {
    abortController: AbortController;
    accountId: string;
    uiSessionId: string;
    targetResponseId: string;
    headers: Record<string, string>;
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
  activeStreams.set(key, entry);
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

export function getStreamKeyBySessionId(sessionId: string): string | undefined {
  return getStreamKeysBySessionId(sessionId)[0];
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

export function updateStreamTargetResponseId(
  key: string,
  targetResponseId: string,
): void {
  const entry = activeStreams.get(key);
  if (entry) {
    entry.targetResponseId = targetResponseId;
  }
}
