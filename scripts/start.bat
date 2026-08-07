@echo off
chcp 65001 >nul
setlocal

REM Move para a raiz do projeto (pasta pai de scripts\)
cd /d "%~dp0.."

REM Título da janela do console
title QwenBridge

REM --- Verifica Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo ❌ [ERRO] Node.js nao encontrado. Rode scripts\install.bat primeiro.
  exit /b 1
)

REM --- Verifica se as dependências foram instaladas ---
if not exist "node_modules" (
  echo ⚠️  node_modules nao encontrado. Rode scripts\install.bat primeiro.
  exit /b 1
)

REM --- Aviso se não houver .env ---
if not exist ".env" (
  echo ⚠️  .env nao encontrado. O servidor pode falhar sem contas configuradas.
  echo    Crie um .env a partir de .env.example e configure suas contas Qwen.
  echo.
)

REM O servidor já exibe o próprio banner; --silent oculta o cabeçalho do npm.
call npm start --silent
endlocal
