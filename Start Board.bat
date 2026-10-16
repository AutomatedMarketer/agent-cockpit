@echo off
rem Starts the board on this computer. Looks for Node by its full path, from a folder that holds
rem nothing, so a program with the same name left in the board's folder is never the one that runs.
setlocal
set "NoDefaultCurrentDirectoryInExePath=1"
set "BOARD_DIR=%~dp0"
cd /d "%SystemRoot%\System32"

set "NODE="
for /f "delims=" %%N in ('%SystemRoot%\System32\where.exe node 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE (
  echo.
  echo The board needs Node, and it is not installed on this computer.
  echo Install the current LTS version from https://nodejs.org , then double-click Start Board again.
  if not defined BOARD_RESOLVE_ONLY start "" "https://nodejs.org/en/download"
  if not defined BOARD_RESOLVE_ONLY pause
  exit /b 1
)
if defined BOARD_RESOLVE_ONLY (
  echo %NODE%
  exit /b 0
)

"%NODE%" "%BOARD_DIR%local\check-node.cjs"
if errorlevel 1 (
  pause
  exit /b 1
)
"%NODE%" "%BOARD_DIR%local\start.mjs"
if errorlevel 1 (
  echo.
  echo The board stopped. Read the message above, then double-click Start Board to try again.
  pause
  exit /b 1
)
