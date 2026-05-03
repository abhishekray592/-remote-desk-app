@echo off
setlocal

set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\RemoteDeskHelper.lnk"

if exist "%LNK%" (
    del "%LNK%"
    echo Removed: %LNK%
    echo The helper will no longer start automatically at login.
) else (
    echo Autostart was not installed (no shortcut found).
)

echo.
echo Note: this only removes the autostart entry.
echo If client-helper.js is currently running, kill it from Task Manager
echo (look for node.exe^) to stop it now.
echo.
pause
