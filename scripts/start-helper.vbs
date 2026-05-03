' start-helper.vbs
' Launches client-helper.js silently (no console window).
' Resolves the project folder from this script's own location:
'   <project>/scripts/start-helper.vbs

Option Explicit

Dim fso, sh, scriptDir, projectDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

scriptDir  = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)

sh.CurrentDirectory = projectDir
' 0 = hidden window, False = don't wait for exit
sh.Run "cmd /c node client-helper.js", 0, False
