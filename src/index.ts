import dotenv from 'dotenv'
import fs from 'node:fs'
import { getEnvFilePath, ensureDataDirs } from './core/paths.ts'

// Ensure persistent user data directory exists
ensureDataDirs()

// Load .env from local directory or persistent global OS directory
const envPath = getEnvFilePath()
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath })
} else {
  dotenv.config()
}
// Prevent benign asynchronous driver/browser teardown exceptions from crashing the server
process.on('uncaughtException', (error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error)
  if (
    msg.includes('Cannot find parent object') ||
    msg.includes('Target page, context or browser has been closed') ||
    msg.includes('Browser has been closed') ||
    msg.includes('Target closed') ||
    msg.includes('Connection closed')
  ) {
    console.warn(`⚠️  [Playwright] Handled benign driver teardown exception: ${msg}`)
    return
  }
  console.error('❌ [Process] Uncaught Exception:', error)
})

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  if (
    msg.includes('Cannot find parent object') ||
    msg.includes('Target page, context or browser has been closed') ||
    msg.includes('Browser has been closed') ||
    msg.includes('Target closed') ||
    msg.includes('Connection closed')
  ) {
    console.warn(`⚠️  [Playwright] Handled benign driver teardown rejection: ${msg}`)
    return
  }
  console.error('❌ [Process] Unhandled Rejection:', reason)
})
import { startServer } from './api/server.js'
const isTui = process.argv.includes('--tui') || process.env.QWEN_TUI === 'true'

if (isTui) {
  const { TuiApp } = await import('./tui/app.ts')
  const app = new TuiApp()
  await app.start()
} else {
  startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // Expected configuration errors are already formatted with an emoji and
    // actionable guidance; print only the message to avoid leaking stack traces.
    if (message.includes('[Server]')) {
      console.error(message)
    } else {
      console.error('❌ [Server] Failed to start:', message)
    }
    process.exit(1)
  })
}
