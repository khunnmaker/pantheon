@echo off
REM ============================================================================
REM  Mercury (local) — one-click launcher for Windows.
REM  Double-click this file. It builds the app (first run installs deps), starts
REM  the local server on http://localhost:4610, and opens your browser.
REM  Everything runs on THIS machine only. Nothing is sent to the cloud.
REM ============================================================================
setlocal
cd /d "%~dp0"

echo [mercury-local] Starting...

REM First run: install dependencies if node_modules is missing.
if not exist "node_modules\" (
  echo [mercury-local] Installing dependencies ^(first run^)...
  call npm install || goto :error
)
if not exist "client\node_modules\" (
  echo [mercury-local] Installing client dependencies ^(first run^)...
  call npm --prefix client install || goto :error
)

REM Ensure the local database + Prisma client exist (idempotent).
call npm run prisma:generate || goto :error
call npx prisma migrate deploy || goto :error

REM Build the client + server and launch (opens the browser).
call npm run start || goto :error

goto :eof

:error
echo.
echo [mercury-local] Startup failed. See the messages above.
pause
exit /b 1
