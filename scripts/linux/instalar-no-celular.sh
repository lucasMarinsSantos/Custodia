#!/usr/bin/env bash
# Instala o APK de release (dist/custodia.apk) no celular conectado.
# Depois de instalado, o app funciona sozinho: não precisa do PC nem do Metro.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/linux/_ambiente.sh
command -v adb >/dev/null || { echo "[ERRO] adb não encontrado. Instale o Android SDK (Android Studio) ou o platform-tools."; exit 1; }
[ -f dist/custodia.apk ] || bash scripts/linux/gerar-apk.sh
adb devices | awk 'NR>1 && $2=="unauthorized"{print "[AVISO] O aparelho "$1" não autorizou este PC: desbloqueie a tela e toque em Permitir."}'
DEV="$(adb devices | awk 'NR>1 && $2=="device" && $1 !~ /^emulator-/{print $1; exit}')"
[ -n "$DEV" ] || DEV="$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')"
[ -n "$DEV" ] || { echo "[ERRO] Nenhum celular conectado. Ative a Depuração USB e conecte o cabo, ou use a depuração sem fio (README)."; exit 1; }
echo "Instalando no aparelho $DEV..."
adb -s "$DEV" install -r dist/custodia.apk
adb -s "$DEV" shell am start -n com.custodia.sprint2/com.custodia.MainActivity >/dev/null
echo "[OK] Custódia instalado e aberto no celular."
