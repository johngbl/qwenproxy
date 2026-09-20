@echo off
cd /d "%~dp0"
set NODE_ENV=production
set HOST=127.0.0.1
set TEST_MOCK_QWEN_AUTH=
npx.cmd tsx src/index.ts %*
