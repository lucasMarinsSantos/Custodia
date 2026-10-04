@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
rem Abre o emulador (se necessário), instala o APK e inicia o app
cd /d "%~dp0..\.."
call "%~dp0_ambiente.bat"
where adb >nul 2>nul || (echo [ERRO] adb não encontrado. Instale o Android SDK ^(Android Studio^). & set "ERR=1" & goto :fim)
if not exist dist\custodia.apk (echo [ERRO] APK não encontrado. Rode antes scripts\windows\gerar-apk.bat & set "ERR=1" & goto :fim)
set "DEV="
for /f "skip=1 tokens=1,2" %%a in ('adb devices') do if "%%b"=="device" set "DEV=%%a"
if not defined DEV (
  set "AVD="
  for /f "delims=" %%a in ('emulator -list-avds 2^>nul') do if not defined AVD set "AVD=%%a"
  if not defined AVD (echo [ERRO] Nenhum emulador criado. Crie um no Android Studio: Device Manager ^> Create Device. & set "ERR=1" & goto :fim)
  echo Iniciando o emulador !AVD! ...
  start "Emulador Android" emulator -avd "!AVD!"
)
echo Aguardando o Android iniciar...
adb wait-for-device
:boot
adb shell getprop sys.boot_completed 2>nul | findstr "1" >nul || (ping -n 3 127.0.0.1 >nul & goto :boot)
echo Instalando o APK...
adb install -r dist\custodia.apk
if errorlevel 1 (echo [ERRO] Falha ao instalar o APK. & set "ERR=1" & goto :fim)
adb shell am start -n com.custodia.sprint1/com.custodia.MainActivity
echo [OK] Custódia aberto no emulador.
set "ERR=0"
:fim
if not defined CUSTODIA_NO_PAUSE pause
exit /b %ERR%
