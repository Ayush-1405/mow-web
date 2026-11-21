@echo off
rem Mood AI laptop worker. Starts only when you run this file; close the window (or press Ctrl+C) to stop it.
title Mood AI Worker
cd /d "%~dp0"
:loop
node src\main.js
set CODE=%ERRORLEVEL%
if "%CODE%"=="0" goto end
if "%CODE%"=="3" (
  echo Restarting on request from the Control Center...
  goto loop
)
echo The worker stopped unexpectedly (code %CODE%). Restarting in 15 seconds - close this window to stop.
timeout /t 15 /nobreak >nul
goto loop
:end
echo Mood AI Worker stopped.
pause
