import 'dotenv/config'
import { startServer } from './api/server.js'

startServer().catch(error => {
  console.error('Failed to start server:', error)
  process.exit(1)
})
