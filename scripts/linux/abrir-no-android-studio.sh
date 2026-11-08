#!/usr/bin/env bash
# Abre o projeto Android no Android Studio (Run > Run 'app' compila, instala e abre o app).
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/linux/_ambiente.sh
command -v node >/dev/null || { echo "[ERRO] Node.js não encontrado (instale o Node 22 LTS)."; exit 1; }
if [ ! -d node_modules ]; then
  echo "== Instalando dependências (npm ci), necessário antes de abrir no Android Studio =="
  npm ci
fi
if [ -n "${ANDROID_HOME:-}" ] && [ ! -f android/local.properties ]; then
  echo "sdk.dir=$ANDROID_HOME" > android/local.properties
fi
STUDIO=""
for s in studio android-studio /opt/android-studio/bin/studio.sh /usr/local/android-studio/bin/studio.sh "$HOME/android-studio/bin/studio.sh" /snap/bin/android-studio; do
  if command -v "$s" >/dev/null 2>&1 || [ -x "$s" ]; then STUDIO="$s"; break; fi
done
if [ -z "$STUDIO" ]; then
  echo "[AVISO] Android Studio não encontrado. Abra-o e use File > Open na pasta: $PWD/android"
  exit 1
fi
echo "Abrindo $PWD/android no Android Studio..."
echo "Depois do \"Gradle sync\", escolha o emulador na barra de cima e clique em Run (triângulo verde)."
nohup "$STUDIO" "$PWD/android" >/dev/null 2>&1 &
