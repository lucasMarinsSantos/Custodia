@echo off
chcp 65001 >nul
setlocal
rem Instala, verifica (tsc + eslint + jest) e gera o APK, gravando o log em logs\validacao-windows.log
cd /d "%~dp0..\.."
if not exist logs mkdir logs
set "LOG=%CD%\logs\validacao-windows.log"
set "CUSTODIA_NO_PAUSE=1"
echo Validação iniciada em %DATE% %TIME% > "%LOG%"
echo Validando... acompanhe o log em %LOG%
call "%~dp0instalar.bat" >> "%LOG%" 2>&1 || goto :falhou
call "%~dp0verificar.bat" >> "%LOG%" 2>&1 || goto :falhou
call "%~dp0gerar-apk.bat" >> "%LOG%" 2>&1 || goto :falhou
echo VALIDACAO_OK %DATE% %TIME% >> "%LOG%"
echo [OK] Tudo validado. APK em dist\custodia.apk
goto :fim
:falhou
echo VALIDACAO_FALHOU %DATE% %TIME% >> "%LOG%"
echo [ERRO] A validação falhou. Veja %LOG%
:fim
set "CUSTODIA_NO_PAUSE="
pause
