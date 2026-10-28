@echo off
rem Starts Blackjack Pipeline in this window (Ctrl+C stops it; runs resume on the next start).
rem For a background server with no window, use "Start Blackjack Pipeline.vbs" instead.
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" server.js --open
) else (
  node server.js --open
)
pause
