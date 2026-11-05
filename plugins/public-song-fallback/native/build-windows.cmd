@echo off
setlocal
rem Run in an x64 Visual Studio Developer Command Prompt.
if not exist "%~dp0..\bin" mkdir "%~dp0..\bin"
cl /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /Fo"%TEMP%\echo-next-decode-mv.obj" /Fe"%~dp0..\bin\decode-mv.exe" "%~dp0decode-mv.cpp" mfplat.lib mfreadwrite.lib mfuuid.lib ole32.lib
exit /b %errorlevel%
