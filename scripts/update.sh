#!/usr/bin/env bash
set -euo pipefail

# Move para a raiz do projeto (pasta pai de scripts/)
cd "$(dirname "$0")/.."

echo "============================================"
echo "  🔄 QwenBridge - Atualização"
echo "============================================"
echo ""

# --- Verifica Node.js ---
if ! command -v node >/dev/null 2>&1; then
  echo "❌ [ERRO] Node.js não encontrado. Rode ./scripts/install.sh primeiro."
  exit 1
fi

# --- Atualiza o código via git, se for um repositório ---
if ! command -v git >/dev/null 2>&1; then
  echo "⚠️  Git não encontrado. Pulando atualização de código."
  echo "   Baixe em: https://git-scm.com/"
elif [ ! -d ".git" ]; then
  echo "⚠️  Este diretório não é um repositório git. Pulando git pull."
else
  echo "🔄 Atualizando código com git pull..."
  if git pull; then
    echo "✅ Código atualizado."
  else
    echo "❌ [ERRO] git pull falhou. Resolva conflitos ou verifique a conexão."
    exit 1
  fi
  echo ""
fi

# --- Atualiza dependências ---
echo "📦 Atualizando dependências com npm install..."
npm install
echo "✅ Dependências atualizadas."
echo ""

# --- Garante que o navegador do Playwright está instalado/atualizado ---
echo "🎭 Verificando navegador do Playwright..."
if npx playwright install chromium; then
  echo "✅ Chromium do Playwright verificado."
else
  echo "⚠️  Falha ao instalar chromium via Playwright. O servidor pode não iniciar."
fi

echo ""
echo "============================================"
echo "  ✅ Atualização concluída!"
echo "  Próximo passo: ./scripts/start.sh"
echo "============================================"
