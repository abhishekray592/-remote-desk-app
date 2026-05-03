@echo off
setlocal

set "VBS=%~dp0start-helper.vbs"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LNK=%STARTUP%\RemoteDeskHelper.lnk"

if not exist "%VBS%" (
    echo [ERROR] Cannot find: %VBS%
    pause
    exit /b 1
)

REM Create the shortcut in the user's Startup folder
powershell -NoProfile -Command "$s = (New-Object -COM WScript.Shell).CreateShortcut('%LNK%'); $s.TargetPath = '%VBS%'; $s.WorkingDirectory = '%~dp0..'; $s.Save()"

if errorlevel 1 (
    echo [ERROR] Failed to create startup shortcut.
    pause
    exit /b 1
)

echo.
echo Installed: %LNK%
echo.
echo The helper will auto-start the next time you log in.
echo Starting it now so you don't have to log out...
wscript "%VBS%"

echo.
echo Done. Open Task Manager and look for "node.exe" to verify it's running.
echo To disable: run uninstall-autostart.bat
echo.
pause
