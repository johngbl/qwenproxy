@echo off
chcp 65001 >nul
setlocal

REM Move para a raiz do projeto (pasta pai de scripts\)
cd /d "%~dp0.."

REM Título da janela do console
title QwenProxy - Instalacao

echo ============================================
echo   📦 QwenProxy - Instalacao
echo ============================================
echo.

REM --- Verifica Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo ❌ [ERRO] Node.js nao encontrado.
  echo    Baixe e instale em: https://nodejs.org/ ^(versao 22 ou superior^)
  exit /b 1
)

REM --- Verifica versao minima do Node (22+) ---
set "NODE_MAJOR="
for /f "tokens=1 delims=v." %%a in ('node -v 2^>nul') do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR (
  echo ❌ [ERRO] Nao foi possivel determinar a versao do Node.js.
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo ❌ [ERRO] Node.js 22+ e necessario. Versao atual:
  node -v
  exit /b 1
)
echo ✅ Node.js encontrado:
node -v
echo.

REM --- Instala dependencias (o postinstall ja roda playwright install chromium) ---
echo 📦 Instalando dependencias com npm...
call npm install
if errorlevel 1 (
  echo ❌ [ERRO] npm install falhou.
  exit /b 1
)
echo ✅ Dependencias instaladas.
echo.

REM --- Cria .env a partir do exemplo, se nao existir ---
if not exist ".env" (
  if exist ".env.example" (
    copy ".env.example" ".env" >nul
    echo ✅ .env criado a partir de .env.example
    echo ⚠️  Edite o .env e configure suas contas Qwen antes de iniciar.
  ) else (
    echo ⚠️  .env.example nao encontrado. Crie um .env manualmente.
  )
) else (
  echo ✅ .env ja existe, nada a criar.
)

echo.
echo ============================================
echo   ✅ Instalacao concluida!
echo   Proximo passo: scripts\start.bat
echo ============================================
endlocal
