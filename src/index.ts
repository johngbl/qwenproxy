import 'dotenv/config'
import { startServer } from './api/server.js'

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
