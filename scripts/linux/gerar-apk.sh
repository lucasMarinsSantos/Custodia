#!/usr/bin/env bash
# Gera o APK de release (roda sem o Metro) em dist/custodia.apk
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/linux/_ambiente.sh
[ -d node_modules ] || { echo "[ERRO] Rode antes scripts/linux/instalar.sh"; exit 1; }
[ -n "${ANDROID_HOME:-}" ] || { echo "[ERRO] Android SDK não encontrado. Instale o Android Studio ou defina ANDROID_HOME."; exit 1; }
command -v java >/dev/null || { echo "[ERRO] JDK não encontrado. Instale o JDK 17+ (ex.: sudo apt install openjdk-17-jdk) ou defina JAVA_HOME."; exit 1; }
[ -f android/local.properties ] || echo "sdk.dir=$ANDROID_HOME" > android/local.properties
echo "== Gerando APK de release (a primeira vez pode levar de 10 a 20 minutos) =="
chmod +x android/gradlew
(cd android && ./gradlew assembleRelease --no-daemon)
mkdir -p dist
cp android/app/build/outputs/apk/release/app-release.apk dist/custodia.apk
echo "[OK] APK gerado: $(pwd)/dist/custodia.apk"
