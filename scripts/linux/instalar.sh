#!/usr/bin/env bash
# Instala as dependências do projeto (node_modules)
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/linux/_ambiente.sh
echo "== Instalando dependências =="
command -v node >/dev/null || { echo "[ERRO] Node.js não encontrado. Instale o Node.js 22 LTS (https://nodejs.org)."; exit 1; }
node -v
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
chmod +x android/gradlew scripts/linux/*.sh 2>/dev/null || true
echo "[OK] Dependências instaladas."
