@echo off
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" server.js --open
) else (
  node server.js --open
)
pause
