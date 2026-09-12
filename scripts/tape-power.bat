@echo off
rem Usage: tape-power.bat <on|off|status> [driveName]
rem
rem Point a Veeam pre-job/post-job script at this file with the
rem appropriate arguments, e.g.:
rem   Pre-job:  tape-power.bat on drive1
rem   Post-job: tape-power.bat off drive1
rem
rem Exit code 9009 means "node" could not be found. It's common for this
rem to work fine in your own interactive cmd/PowerShell (which has your
rem user's PATH) but fail when Veeam runs it, since the Veeam Backup
rem Service usually runs as a different account (its own service account,
rem or SYSTEM) with a different, often bare, PATH.
rem
rem Fix: run `where node` in your own cmd to find the real path, then set
rem NODE_EXE below to that exact path. The two locations checked
rem automatically below cover a standard, machine-wide Node.js installer
rem run - anything else (nvm, a per-user install, a zip extract) needs the
rem explicit path.
rem
rem Requires .env (see .env.example) to exist one folder up.

setlocal
if "%~1"=="" (
    echo Usage: tape-power.bat ^<on^|off^|status^> [driveName]
    exit /b 2
)

rem Hardcode NODE_EXE here if the auto-detection below doesn't find yours,
rem e.g.: set "NODE_EXE=C:\Program Files\nodejs\node.exe"
set "NODE_EXE=node"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"

set "PROJECT_DIR=%~dp0.."
"%NODE_EXE%" --env-file="%PROJECT_DIR%\.env" "%PROJECT_DIR%\src\cli.ts" %*
exit /b %ERRORLEVEL%
