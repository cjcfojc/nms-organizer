' No Man's Organizer — Windows hidden launcher.
'
' Double-click to start the server with NO visible CMD window. Browser opens
' to http://localhost:8765 after a brief delay. Stop with stop-windows.bat.
'
' Server output still streams into logs/session.<timestamp>.<pid>.jsonl — that
' file has every event (boot, requests, errors) in case you need to debug.

Option Explicit

Dim sh, fso, scriptDir
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

' Verify Node is installed before launching (so we can show a friendly popup
' instead of silently failing).
Dim nodeCheck
nodeCheck = sh.Run("cmd /c where node >nul 2>&1", 0, True)
If nodeCheck <> 0 Then
  MsgBox "Node.js is required but was not found on PATH." & vbCrLf & vbCrLf & _
         "Install it from https://nodejs.org/  (any LTS release works).", _
         vbExclamation, "No Man's Organizer"
  WScript.Quit 1
End If

' Verify port 8765 isn't already taken (the server is already running).
Dim portCheck
portCheck = sh.Run("cmd /c netstat -ano | findstr "":8765"" | findstr LISTENING >nul", 0, True)
If portCheck = 0 Then
  ' Server already running — just open the browser.
  sh.Run "http://localhost:8765"
  WScript.Quit 0
End If

' Launch the server hidden (window state 0, don't wait).
sh.CurrentDirectory = scriptDir
sh.Run "cmd /c node serve.js", 0, False

' Wait for the server to start listening, then open the browser.
WScript.Sleep 1500
sh.Run "http://localhost:8765"
