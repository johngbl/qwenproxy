const activeStreams = new Map<string, {
  abortController: AbortController;
  accountId: string;
  uiSessionId: string;
  targetResponseId: string;
  headers: Record<string, string>;
}>();

export function registerStream(key: string, entry: {
  abortController: AbortController;
  accountId: string;
  uiSessionId: string;
  targetResponseId: string;
  headers: Record<string, string>;
}): void {
  activeStreams.set(key, entry);
}

export function getStream(key: string): ReturnType<typeof activeStreams.get> {
  return activeStreams.get(key);
}

export function removeStream(key: string): void {
  activeStreams.delete(key);
}

export function abortStream(key: string): boolean {
  const entry = activeStreams.get(key);
  if (entry) {
    entry.abortController.abort();
    activeStreams.delete(key);
    return true;
  }
  return false;
}
