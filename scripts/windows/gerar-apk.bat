@echo off
chcp 65001 >nul
setlocal
rem Gera o APK de release (roda sem o Metro) em dist\custodia.apk
cd /d "%~dp0..\.."
call "%~dp0_ambiente.bat"
if not exist node_modules (echo [ERRO] Rode antes scripts\windows\instalar.bat & set "ERR=1" & goto :fim)
if not defined ANDROID_HOME (echo [ERRO] Android SDK nao encontrado. Instale o Android Studio ou defina ANDROID_HOME. & set "ERR=1" & goto :fim)
if not defined JAVA_HOME (echo [ERRO] JDK nao encontrado. Instale o Android Studio ^(JBR^) ou defina JAVA_HOME ^(JDK 17+^). & set "ERR=1" & goto :fim)
if not exist android\local.properties (echo sdk.dir=%SDK_PROP%)> android\local.properties
echo.
echo == Gerando APK de release (a primeira vez pode levar de 10 a 20 minutos) ==
pushd android
call gradlew.bat assembleRelease --no-daemon
set "RC=%ERRORLEVEL%"
popd
if not "%RC%"=="0" (echo [ERRO] Falha no Gradle. & set "ERR=1" & goto :fim)
if not exist dist mkdir dist
copy /y android\app\build\outputs\apk\release\app-release.apk dist\custodia.apk >nul
echo [OK] APK gerado: %CD%\dist\custodia.apk
set "ERR=0"
:fim
if not defined CUSTODIA_NO_PAUSE pause
exit /b %ERR%
