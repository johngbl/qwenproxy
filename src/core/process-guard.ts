/**
 * Process teardown error guard.
 *
 * Catches unhandled rejections and uncaught exceptions that arise from
 * benign browser/CDP connection closures (e.g. ProtocolError: session closed,
 * Network.setCacheDisabled, target crashed during shutdown) and prevents
 * them from terminating the Node.js process.
 */

export function isPlaywrightAlreadyClosedMessage(message: string): boolean {
  if (!message) return false;
  return (
    message.includes("Target page, context or browser has been closed") ||
    message.includes("Browser has been closed") ||
    message.includes("Target closed") ||
    message.includes("Target crashed") ||
    message.includes("Page crashed") ||
    message.includes("Assertion error") ||
    message.includes("Cannot find parent object") ||
    message.includes("Connection closed") ||
    message.includes("session closed") ||
    message.includes("Session closed") ||
    message.includes("Network.setCacheDisabled") ||
    message.includes("Protocol error") ||
    message.includes("storageState timed out")
  );
}

export function isBenignTeardownError(error: unknown): boolean {
  if (!error) return true;
  if (
    typeof error === "object" &&
    Object.keys(error).length === 0 &&
    !(error instanceof Error)
  ) {
    return true;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && "message" in error
        ? String((error as any).message)
        : String(error);
  return isPlaywrightAlreadyClosedMessage(message);
}

let guardsInstalled = false;

/**
 * Installs process-wide handlers for uncaughtException and unhandledRejection
 * to guard against asynchronous Playwright/CDP driver teardown crashes.
 */
export function installProcessTeardownGuards(label = "Process"): void {
  if (guardsInstalled) return;
  guardsInstalled = true;

  process.on("uncaughtException", (error: unknown) => {
    if (isBenignTeardownError(error)) {
      return;
    }
    console.error(`❌ [${label}] Uncaught Exception:`, error);
  });

  process.on("unhandledRejection", (reason: unknown) => {
    if (isBenignTeardownError(reason)) {
      return;
    }
    console.error(`❌ [${label}] Unhandled Rejection:`, reason);
  });
}
