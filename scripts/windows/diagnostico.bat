@echo off
chcp 65001 >nul
setlocal
rem Mostra as ferramentas encontradas (util quando algo nao funciona)
cd /d "%~dp0..\.."
call "%~dp0_ambiente.bat"
if not exist logs mkdir logs
set "OUT=%CD%\logs\diagnostico-windows.txt"
(
  echo == Windows ==
  ver
  echo == Node / npm ==
  node -v
  call npm -v
  echo == Java ==
  echo JAVA_HOME=%JAVA_HOME%
  java -version 2>&1
  echo == Android SDK ==
  echo ANDROID_HOME=%ANDROID_HOME%
  dir /b "%ANDROID_HOME%\platforms" 2>nul
  dir /b "%ANDROID_HOME%\build-tools" 2>nul
  dir /b "%ANDROID_HOME%\ndk" 2>nul
  dir /b "%ANDROID_HOME%\cmake" 2>nul
  dir /b /s "%ANDROID_HOME%\system-images" 2>nul | findstr /e "x86_64 arm64-v8a"
  echo == Emuladores ==
  emulator -list-avds
  echo == Dispositivos ==
  adb devices
  echo == App instalado ==
  adb shell dumpsys package com.custodia.sprint1 2>nul | findstr /i "versionName lastUpdateTime"
) > "%OUT%" 2>&1
rem Erros recentes do app (falhas nativas e do JavaScript) para anexar a um relato de problema
adb logcat -d -b crash > "%CD%\logs\logcat-falhas.txt" 2>&1
adb logcat -d -v time ReactNativeJS:V ReactNative:V AndroidRuntime:E DEBUG:V libc:V *:S > "%CD%\logs\logcat-app.txt" 2>&1
type "%OUT%"
echo.
echo Diagnostico salvo em %OUT% ^(logs do app em logs\logcat-app.txt e logs\logcat-falhas.txt^)
if not defined CUSTODIA_NO_PAUSE pause
