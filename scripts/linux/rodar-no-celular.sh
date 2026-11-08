#!/usr/bin/env bash
# Modo de desenvolvimento no CELULAR: o Metro (servidor de código JS) roda neste PC e o app
# roda no celular, conectado por cabo USB ou por depuração sem fio (Wi-Fi). Salvou um arquivo, o app recarrega.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/linux/_ambiente.sh
command -v node >/dev/null || { echo "[ERRO] Node.js não encontrado. Instale o Node 22 LTS."; exit 1; }
command -v adb >/dev/null || { echo "[ERRO] adb não encontrado. Instale o Android SDK (Android Studio) ou o platform-tools."; exit 1; }
[ -n "${JAVA_HOME:-}" ] || command -v java >/dev/null || { echo "[ERRO] JDK 17+ não encontrado. Defina JAVA_HOME."; exit 1; }
[ -d node_modules ] || npm ci
if [ -n "${ANDROID_HOME:-}" ] && [ ! -f android/local.properties ]; then echo "sdk.dir=$ANDROID_HOME" > android/local.properties; fi
adb devices | awk 'NR>1 && $2=="unauthorized"{print "[AVISO] O aparelho "$1" não autorizou este PC: desbloqueie a tela e toque em Permitir."}'
DEV="$(adb devices | awk 'NR>1 && $2=="device" && $1 !~ /^emulator-/{print $1; exit}')"
if [ -z "$DEV" ]; then
  DEV="$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')"
  [ -n "$DEV" ] && echo "[AVISO] Nenhum celular encontrado; usando o emulador $DEV."
fi
if [ -z "$DEV" ]; then
  echo "[ERRO] Nenhum celular conectado."
  echo " - Cabo USB: ative 'Opções do desenvolvedor' e 'Depuração USB' no celular e conecte o cabo."
  echo " - Wi-Fi: ative 'Depuração sem fio' e rode  adb pair IP:PORTA  e  adb connect IP:PORTA  (veja o README)."
  exit 1
fi
echo "Celular: $DEV"
echo "== Compilando a variante debug, instalando e abrindo o app (a primeira vez leva vários minutos) =="
# Inicia o Metro (porta 8082) em segundo plano se ainda não estiver rodando
if ! curl -s --max-time 2 http://localhost:8082/status | grep -q running; then
  mkdir -p logs
  nohup npx react-native start --port 8082 > logs/metro.log 2>&1 &
  echo "Metro iniciado em segundo plano (log em logs/metro.log)."
  sleep 5
fi
npx react-native run-android --port 8082 --device "$DEV" --no-packager
adb -s "$DEV" reverse tcp:8082 tcp:8082 >/dev/null 2>&1 || true
echo "[OK] Custódia aberto no celular, carregando o código do Metro deste PC."
echo " - Edite o código e salve: o app recarrega sozinho (Fast Refresh)."
echo " - Menu de desenvolvimento: chacoalhe o celular ou rode  adb shell input keyevent 82"
