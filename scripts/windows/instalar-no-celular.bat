@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
rem Instala o APK de release (dist\custodia.apk) no celular conectado.
rem Depois de instalado, o app funciona sozinho: não precisa do PC nem do Metro.
cd /d "%~dp0..\.."
call "%~dp0_ambiente.bat"
where adb >nul 2>nul || (echo [ERRO] adb não encontrado. Instale o Android SDK ^(Android Studio^) ou o "SDK Platform-Tools". & set "ERR=1" & goto :fim)
if not exist dist\custodia.apk (
  echo O APK ainda não existe. Gerando com gerar-apk.bat...
  set "CUSTODIA_NO_PAUSE=1"
  call "%~dp0gerar-apk.bat"
  set "CUSTODIA_NO_PAUSE="
  if not exist dist\custodia.apk (echo [ERRO] Não foi possível gerar o APK. & set "ERR=1" & goto :fim)
)
set "DEV=" & set "EMU="
for /f "skip=1 tokens=1,2" %%a in ('adb devices') do (
  if "%%b"=="device" (
    echo %%a | findstr /b "emulator-" >nul && (if not defined EMU set "EMU=%%a") || (if not defined DEV set "DEV=%%a")
  )
  if "%%b"=="unauthorized" echo [AVISO] O aparelho %%a não autorizou este PC: desbloqueie a tela e toque em "Permitir".
)
if not defined DEV if defined EMU (set "DEV=%EMU%" & echo [AVISO] Nenhum celular encontrado; usando o emulador %EMU%.)
if not defined DEV (
  echo [ERRO] Nenhum celular conectado. Ative a "Depuração USB" e conecte o cabo, ou use a depuração sem fio ^(README^).
  echo Também dá para copiar dist\custodia.apk para o celular e abrir o arquivo nele.
  set "ERR=1" & goto :fim
)
echo Instalando no aparelho %DEV%...
adb -s %DEV% install -r dist\custodia.apk
if errorlevel 1 (echo [ERRO] Falha ao instalar. Se já houver outra versão assinada com outra chave: adb uninstall com.custodia.sprint2 & set "ERR=1" & goto :fim)
adb -s %DEV% shell am start -n com.custodia.sprint2/com.custodia.MainActivity >nul
echo [OK] Custódia instalado e aberto no celular.
set "ERR=0"
:fim
if not defined CUSTODIA_NO_PAUSE pause
exit /b %ERR%
