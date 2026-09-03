#!/usr/bin/env bash
set -euo pipefail

# Move para a raiz do projeto (pasta pai de scripts/)
cd "$(dirname "$0")/.."

echo "============================================"
echo "  📦 QwenProxy - Instalação"
echo "============================================"
echo ""

# --- Verifica Node.js ---
if ! command -v node >/dev/null 2>&1; then
  echo "❌ [ERRO] Node.js não encontrado."
  echo "   Baixe e instale em: https://nodejs.org/ (versão 22 ou superior)"
  exit 1
fi

# --- Verifica versão mínima do Node (22+) ---
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "❌ [ERRO] Node.js 22+ é necessário. Versão atual: $(node -v)"
  exit 1
fi
echo "✅ Node.js encontrado: $(node -v)"
echo ""

# --- Instala dependências (o postinstall já roda playwright install chromium) ---
echo "📦 Instalando dependências com npm..."
npm install
echo "✅ Dependências instaladas."
echo ""

# --- Cria .env a partir do exemplo, se não existir ---
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp ".env.example" ".env"
    echo "✅ .env criado a partir de .env.example"
    echo "⚠️  Edite o .env e configure suas contas Qwen antes de iniciar."
  else
    echo "⚠️  .env.example não encontrado. Crie um .env manualmente."
  fi
else
  echo "✅ .env já existe, nada a criar."
fi

echo ""
echo "============================================"
echo "  ✅ Instalação concluída!"
echo "  Próximo passo: ./scripts/start.sh"
echo "============================================"
