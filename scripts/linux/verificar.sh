#!/usr/bin/env bash
# TypeScript, ESLint e testes automatizados (Jest) com cobertura
set -euo pipefail
cd "$(dirname "$0")/../.."
[ -d node_modules ] || { echo "[ERRO] Rode antes scripts/linux/instalar.sh"; exit 1; }
echo "== 1/3 TypeScript (tsc --noEmit) =="
npx tsc --noEmit
echo "[OK] Sem erros de tipo."
echo "== 2/3 ESLint =="
npx eslint . --max-warnings 0
echo "[OK] Lint sem erros e sem avisos."
echo "== 3/3 Testes (Jest) com cobertura =="
npx jest --coverage --coverageReporters=text-summary
echo "[OK] Todos os testes passaram."
