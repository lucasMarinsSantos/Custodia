@echo off
rem Prepara JAVA_HOME / ANDROID_HOME / PATH no Windows.
rem Chamado pelos outros scripts; nao precisa ser executado sozinho.
if not defined ANDROID_HOME if defined ANDROID_SDK_ROOT set "ANDROID_HOME=%ANDROID_SDK_ROOT%"
if not defined ANDROID_HOME if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not defined JAVA_HOME if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
if defined JAVA_HOME set "PATH=%JAVA_HOME%\bin;%PATH%"
rem Caminho do SDK no formato de arquivo .properties (barras e dois-pontos escapados), para android\local.properties
if defined ANDROID_HOME set "SDK_PROP=%ANDROID_HOME:\=\\%"
if defined SDK_PROP set "SDK_PROP=%SDK_PROP::=\:%"
if defined ANDROID_HOME set "PATH=%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\emulator;%PATH%"
exit /b 0
