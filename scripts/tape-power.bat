@echo off
rem Usage: tape-power.bat <on|off|status> [driveName]
rem
rem Point a Veeam pre-job/post-job script at this file with the
rem appropriate arguments, e.g.:
rem   Pre-job:  tape-power.bat on drive1
rem   Post-job: tape-power.bat off drive1
rem
rem If Node isn't on PATH for the account the Veeam service runs as,
rem replace "node" below with the full path, e.g.
rem "C:\Program Files\nodejs\node.exe".
rem
rem Requires .env (see .env.example) to exist one folder up, next to
rem dist\cli.js (i.e. run `npm run build` first).

setlocal
if "%~1"=="" (
    echo Usage: tape-power.bat ^<on^|off^|status^> [driveName]
    exit /b 2
)

set "PROJECT_DIR=%~dp0.."
node --env-file="%PROJECT_DIR%\.env" "%PROJECT_DIR%\dist\cli.js" %*
exit /b %ERRORLEVEL%
