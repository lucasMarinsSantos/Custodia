@echo off
chcp 65001 >nul
setlocal
rem Instala as dependências do projeto (node_modules)
cd /d "%~dp0..\.."
call "%~dp0_ambiente.bat"
echo.
echo == Instalando dependências ==
where node >nul 2>nul || (echo [ERRO] Node.js não encontrado. Instale o Node.js 22 LTS ^(https://nodejs.org^) e abra um novo terminal. & set "ERR=1" & goto :fim)
node -v
if exist package-lock.json (call npm ci --no-audit --no-fund) else (call npm install --no-audit --no-fund)
if errorlevel 1 (echo [ERRO] Falha ao instalar as dependências. & set "ERR=1" & goto :fim)
echo [OK] Dependências instaladas.
set "ERR=0"
:fim
if not defined CUSTODIA_NO_PAUSE pause
exit /b %ERR%
