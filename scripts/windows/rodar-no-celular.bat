@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
rem Modo de desenvolvimento no CELULAR: o Metro (servidor de código JS) roda neste PC e o app
rem roda no celular, conectado por cabo USB ou por depuração sem fio (Wi-Fi). Salvou um arquivo, o app recarrega.
cd /d "%~dp0..\.."
call "%~dp0_ambiente.bat"
where node >nul 2>nul || (echo [ERRO] Node.js não encontrado. Instale o Node 22 LTS: https://nodejs.org & set "ERR=1" & goto :fim)
where adb >nul 2>nul || (echo [ERRO] adb não encontrado. Instale o Android SDK ^(Android Studio^) ou o "SDK Platform-Tools". & set "ERR=1" & goto :fim)
if not defined JAVA_HOME (echo [ERRO] JDK não encontrado. Instale o Android Studio ^(JBR^) ou defina JAVA_HOME ^(JDK 17+^). & set "ERR=1" & goto :fim)
if not exist node_modules (
  echo == Instalando dependências ^(npm ci^) ==
  call npm ci
  if errorlevel 1 (echo [ERRO] npm ci falhou. & set "ERR=1" & goto :fim)
)
if defined SDK_PROP if not exist android\local.properties (echo sdk.dir=%SDK_PROP%)> android\local.properties

rem Escolhe o aparelho: prefere um celular de verdade; usa o emulador só se não houver celular
set "DEV=" & set "EMU="
for /f "skip=1 tokens=1,2" %%a in ('adb devices') do (
  if "%%b"=="device" (
    echo %%a | findstr /b "emulator-" >nul && (if not defined EMU set "EMU=%%a") || (if not defined DEV set "DEV=%%a")
  )
  if "%%b"=="unauthorized" echo [AVISO] O aparelho %%a não autorizou este PC: desbloqueie a tela e toque em "Permitir" na janela de depuração.
)
if not defined DEV if defined EMU (set "DEV=%EMU%" & echo [AVISO] Nenhum celular encontrado; usando o emulador %EMU%.)
if not defined DEV (
  echo [ERRO] Nenhum celular conectado.
  echo  - Cabo USB: ative "Opções do desenvolvedor" e "Depuração USB" no celular e conecte o cabo.
  echo  - Wi-Fi: ative "Depuração sem fio" e rode  adb pair IP:PORTA  e  adb connect IP:PORTA  ^(veja o README^).
  set "ERR=1" & goto :fim
)
echo Celular: %DEV%
echo.
rem Metro (porta 8082) numa janela própria, se ainda não estiver rodando
set "METRO="
curl.exe -s -m 3 http://localhost:8082/status 2>nul | findstr /c:"packager-status:running" >nul && set "METRO=1"
rem Porta já ocupada (Metro ocupado ou pausado): não abre um segundo, que falharia com "port in use"
netstat -ano | findstr /r /c:":8082 .*LISTENING" >nul && set "METRO=1"
if defined METRO (
  echo Metro já está rodando na porta 8082.
) else (
  echo Abrindo o Metro numa janela própria ^(porta 8082^). Deixe-a aberta enquanto usa o app.
  start "Metro - Custodia (porta 8082)" cmd /k npm start
)
echo.
echo == Compilando a variante debug, instalando e abrindo o app ^(a primeira vez leva vários minutos^) ==
rem run-android: compila a variante debug, faz o "adb reverse" da porta 8082 (o celular acessa o Metro do PC
rem pelo cabo ou pela depuração sem fio), instala e abre o app.
call npx react-native run-android --port 8082 --device %DEV% --no-packager
if errorlevel 1 (echo [ERRO] Falha ao compilar ou instalar. Veja as mensagens acima. & set "ERR=1" & goto :fim)
adb -s %DEV% reverse tcp:8082 tcp:8082 >nul 2>nul
echo.
echo [OK] Custódia aberto no celular, carregando o código do Metro deste PC.
echo  - Edite o código e salve: o app recarrega sozinho ^(Fast Refresh^).
echo  - Menu de desenvolvimento: chacoalhe o celular ou rode  adb shell input keyevent 82
set "ERR=0"
:fim
if not defined CUSTODIA_NO_PAUSE pause
exit /b %ERR%
