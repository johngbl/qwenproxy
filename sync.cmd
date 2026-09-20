@echo off
cd /d "%~dp0"
npx.cmd tsx src/sync-clients.ts %*
