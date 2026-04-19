@echo off
REM ─── Stop the No Man's Organizer server ─────────────────────────────
REM
REM Finds whatever process is listening on port 8765 and kills it. Used
REM together with start-windows-quiet.vbs (which has no visible window
REM you can close to stop the server).

setlocal enabledelayedexpansion
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8765" ^| findstr LISTENING') do (
  taskkill /pid %%a /f >nul 2>nul && (
    echo Stopped server ^(PID %%a^).
    set FOUND=1
  )
)
if !FOUND! EQU 0 echo No server was running on port 8765.
endlocal
echo.
pause
