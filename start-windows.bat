@echo off
REM ─── No Man's Organizer launcher (Windows) ───────────────────────────
REM
REM Starts the local server (node serve.js) in this window and opens your
REM default browser to http://localhost:8765. Close the window or press
REM Ctrl+C to stop the server.

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is required but was not found on PATH.
  echo Install it from https://nodejs.org/  ^(any LTS release works^).
  echo.
  pause
  exit /b 1
)

REM Open the browser after a brief delay so the server is listening when it lands.
start "" /b cmd /c "timeout /t 2 >nul & start http://localhost:8765"

echo Starting No Man's Organizer ^(Ctrl+C to stop^)…
node serve.js
