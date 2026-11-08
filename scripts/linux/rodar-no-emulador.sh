#!/usr/bin/env bash
# Abre o emulador (se necessário), instala o APK e inicia o app
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/linux/_ambiente.sh
command -v adb >/dev/null || { echo "[ERRO] adb não encontrado. Instale o Android SDK (Android Studio)."; exit 1; }
[ -f dist/custodia.apk ] || { echo "[ERRO] APK não encontrado. Rode antes scripts/linux/gerar-apk.sh"; exit 1; }
if ! adb devices | awk 'NR>1 && $2=="device"' | grep -q .; then
  AVD="$(emulator -list-avds 2>/dev/null | head -n1)"
  [ -n "$AVD" ] || { echo "[ERRO] Nenhum emulador criado. Crie um no Android Studio: Device Manager > Create Device."; exit 1; }
  echo "Iniciando o emulador $AVD ..."
  nohup emulator -avd "$AVD" >/dev/null 2>&1 &
fi
echo "Aguardando o Android iniciar..."
adb wait-for-device
until adb shell getprop sys.boot_completed 2>/dev/null | grep -q 1; do sleep 2; done
echo "Instalando o APK..."
adb install -r dist/custodia.apk
adb shell am start -n com.custodia.sprint2/com.custodia.MainActivity
echo "[OK] Custódia aberto no emulador."
