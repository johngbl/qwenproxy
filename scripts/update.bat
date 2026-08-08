@echo off
chcp 65001 >nul
setlocal

REM Move para a raiz do projeto (pasta pai de scripts\)
cd /d "%~dp0.."

REM Título da janela do console
title QwenProxy - Atualizacao

echo ============================================
echo   🔄 QwenProxy - Atualizacao
echo ============================================
echo.

REM --- Verifica Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo ❌ [ERRO] Node.js nao encontrado. Rode scripts\install.bat primeiro.
  exit /b 1
)

REM --- Atualiza o codigo via git, se for um repositorio ---
where git >nul 2>nul
if errorlevel 1 (
  echo ⚠️  Git nao encontrado. Pulando atualizacao de codigo.
  echo    Baixe em: https://git-scm.com/
  goto :deps
)

if not exist ".git" (
  echo ⚠️  Este diretorio nao e um repositorio git. Pulando git pull.
  goto :deps
)

echo 🔄 Atualizando codigo com git pull...
git pull
if errorlevel 1 (
  echo ❌ [ERRO] git pull falhou. Resolva conflitos ou verifique a conexao.
  exit /b 1
)
echo ✅ Codigo atualizado.
echo.

:deps
REM --- Atualiza dependencias ---
echo 📦 Atualizando dependencias com npm install...
call npm install
if errorlevel 1 (
  echo ❌ [ERRO] npm install falhou.
  exit /b 1
)
echo ✅ Dependencias atualizadas.
echo.

REM --- Garante que o navegador do Playwright esta instalado/atualizado ---
echo 🎭 Verificando navegador do Playwright...
call npx playwright install chromium
if errorlevel 1 (
  echo ⚠️  Falha ao instalar chromium via Playwright. O servidor pode nao iniciar.
) else (
  echo ✅ Chromium do Playwright verificado.
)

echo.
echo ============================================
echo   ✅ Atualizacao concluida!
echo   Proximo passo: scripts\start.bat
echo ============================================
endlocal
