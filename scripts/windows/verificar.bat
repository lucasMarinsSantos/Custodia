@echo off
chcp 65001 >nul
setlocal
rem TypeScript, ESLint e testes automatizados (Jest) com cobertura
cd /d "%~dp0..\.."
call "%~dp0_ambiente.bat"
if not exist node_modules (echo [ERRO] Rode antes scripts\windows\instalar.bat & set "ERR=1" & goto :fim)
echo.
echo == 1/3 TypeScript (tsc --noEmit) ==
call npx tsc --noEmit
if errorlevel 1 (echo [ERRO] Erros de tipo. & set "ERR=1" & goto :fim)
echo [OK] Sem erros de tipo.
echo.
echo == 2/3 ESLint ==
call npx eslint . --max-warnings 0
if errorlevel 1 (echo [ERRO] Problemas de lint. & set "ERR=1" & goto :fim)
echo [OK] Lint sem erros e sem avisos.
echo.
echo == 3/3 Testes (Jest) com cobertura ==
call npx jest --coverage --coverageReporters=text-summary
if errorlevel 1 (echo [ERRO] Testes falharam. & set "ERR=1" & goto :fim)
echo [OK] Todos os testes passaram.
set "ERR=0"
:fim
if not defined CUSTODIA_NO_PAUSE pause
exit /b %ERR%
