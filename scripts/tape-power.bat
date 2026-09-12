@echo off
rem Usage: tape-power.bat <on|off|status> [driveName]
rem
rem Point a Veeam pre-job/post-job script at this file with the
rem appropriate arguments, e.g.:
rem   Pre-job:  tape-power.bat on drive1
rem   Post-job: tape-power.bat off drive1
rem
rem Veeam only shows the exit code for these scripts, not their output, so
rem everything below is also logged to tape-power.log next to this file -
rem check that after a failed run to see the actual error.
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
rem
rem Optional: after powering a drive ON, also nudge Veeam Backup &
rem Replication to re-detect it (see refresh-veeam-tape.ps1) instead of
rem leaving it showing offline until the next manual rescan. Off by
rem default - set MSL4048_VEEAM_REFRESH=1 in .env once you've tested
rem refresh-veeam-tape.ps1 manually and confirmed it works for your Veeam
rem setup. A failure here is only logged, not treated as a failure of
rem this script, since it's a newer, less-verified addition than the
rem drive power control itself - see refresh-veeam-tape.ps1's notes.

setlocal EnableDelayedExpansion
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
set "LOG_FILE=%~dp0tape-power.log"

echo [%date% %time%] running as %USERDOMAIN%\%USERNAME%, args="%*", NODE_EXE="%NODE_EXE%" >> "%LOG_FILE%"
"%NODE_EXE%" --env-file="%PROJECT_DIR%\.env" "%PROJECT_DIR%\src\cli.ts" %* >> "%LOG_FILE%" 2>&1
set "EXITCODE=%ERRORLEVEL%"
echo [%date% %time%] exit code %EXITCODE% >> "%LOG_FILE%"

if /i "%~1"=="on" if "%EXITCODE%"=="0" (
    set "MSL4048_VEEAM_REFRESH="
    for /f "usebackq tokens=1,* delims==" %%A in ("%PROJECT_DIR%\.env") do (
        if /i "%%A"=="MSL4048_VEEAM_REFRESH" set "MSL4048_VEEAM_REFRESH=%%B"
    )
    if "!MSL4048_VEEAM_REFRESH!"=="1" (
        echo [%date% %time%] running refresh-veeam-tape.ps1 >> "%LOG_FILE%"
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0refresh-veeam-tape.ps1" >> "%LOG_FILE%" 2>&1
        echo [%date% %time%] refresh-veeam-tape.ps1 exit code !ERRORLEVEL! ^(not treated as fatal^) >> "%LOG_FILE%"
    )
)

exit /b %EXITCODE%
