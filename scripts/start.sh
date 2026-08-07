#!/usr/bin/env bash
set -euo pipefail

# Move para a raiz do projeto (pasta pai de scripts/)
cd "$(dirname "$0")/.."

# Título do terminal (quando suportado)
printf '\033]0;QwenBridge\007' 2>/dev/null || true

# --- Verifica Node.js ---
if ! command -v node >/dev/null 2>&1; then
  echo "❌ [ERRO] Node.js não encontrado. Rode ./scripts/install.sh primeiro."
  exit 1
fi

# --- Verifica se as dependências foram instaladas ---
if [ ! -d "node_modules" ]; then
  echo "⚠️  node_modules não encontrado. Rode ./scripts/install.sh primeiro."
  exit 1
fi

# --- Aviso se não houver .env ---
if [ ! -f ".env" ]; then
  echo "⚠️  .env não encontrado. O servidor pode falhar sem contas configuradas."
  echo "   Crie um .env a partir de .env.example e configure suas contas Qwen."
  echo ""
fi

# O servidor já exibe o próprio banner; --silent oculta o cabeçalho do npm.
exec npm start --silent
