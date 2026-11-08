#!/usr/bin/env bash
# Instala, verifica (tsc + eslint + jest) e gera o APK, gravando o log em logs/validacao-linux.log
set -uo pipefail
cd "$(dirname "$0")/../.."
mkdir -p logs
LOG="$(pwd)/logs/validacao-linux.log"
echo "Validação iniciada em $(date)" > "$LOG"
run() { bash "scripts/linux/$1" 2>&1 | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }
if run instalar.sh && run verificar.sh && { [ "${1:-}" = "--sem-apk" ] || run gerar-apk.sh; }; then
  echo "VALIDACAO_OK $(date)" | tee -a "$LOG"
else
  echo "VALIDACAO_FALHOU $(date), veja $LOG" | tee -a "$LOG"
  exit 1
fi
