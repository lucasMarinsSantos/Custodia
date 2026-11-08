@echo off
chcp 65001 >nul
setlocal
rem Abre o projeto Android no Android Studio (Run > Run 'app' compila, instala e abre o app)
cd /d "%~dp0..\.."
call "%~dp0_ambiente.bat"
where node >nul 2>nul || (echo [ERRO] Node.js nao encontrado. Instale o Node 22 LTS: https://nodejs.org & set "ERR=1" & goto :fim)
if not exist node_modules (
  echo == Instalando dependencias ^(npm ci^), necessario antes de abrir no Android Studio ==
  call npm ci
  if errorlevel 1 (echo [ERRO] npm ci falhou. & set "ERR=1" & goto :fim)
)
if defined SDK_PROP if not exist android\local.properties (echo sdk.dir=%SDK_PROP%)> android\local.properties
set "STUDIO="
if exist "%ProgramFiles%\Android\Android Studio\bin\studio64.exe" set "STUDIO=%ProgramFiles%\Android\Android Studio\bin\studio64.exe"
if not defined STUDIO if exist "%LOCALAPPDATA%\Programs\Android Studio\bin\studio64.exe" set "STUDIO=%LOCALAPPDATA%\Programs\Android Studio\bin\studio64.exe"
if not defined STUDIO (
  echo [AVISO] Android Studio nao encontrado no local padrao.
  echo Abra o Android Studio, use File ^> Open e escolha a pasta: %CD%\android
  set "ERR=1" & goto :fim
)
echo Abrindo %CD%\android no Android Studio...
echo Depois do "Gradle sync", escolha o emulador na barra de cima e clique em Run (triangulo verde).
start "" "%STUDIO%" "%CD%\android"
set "ERR=0"
:fim
if not defined CUSTODIA_NO_PAUSE pause
exit /b %ERR%
