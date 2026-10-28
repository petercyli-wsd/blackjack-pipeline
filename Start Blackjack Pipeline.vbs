' Starts Blackjack Pipeline in the background (no window) and opens it in your browser.
' Pipelines keep running after you close the browser. Use "Stop local app" in the page to stop it.
' If it is already running, this just opens it. Output goes to data\server.log.
Option Explicit
Dim shell, fso, root, runtime, node, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
runtime = fso.BuildPath(root, "runtime\node.exe")
shell.CurrentDirectory = root
If fso.FileExists(runtime) Then
  node = Chr(34) & runtime & Chr(34)
Else
  node = "node"
End If
If Not fso.FolderExists(fso.BuildPath(root, "node_modules")) Then
  MsgBox "Run ""npm ci"" in this folder once first, then start the app again.", 48, "Blackjack Pipeline"
  WScript.Quit 1
End If
If Not fso.FolderExists(fso.BuildPath(root, "data")) Then fso.CreateFolder(fso.BuildPath(root, "data"))
command = "cmd /c " & node & " " & Chr(34) & fso.BuildPath(root, "server.js") & Chr(34) & " --open >> " & Chr(34) & fso.BuildPath(root, "data\server.log") & Chr(34) & " 2>&1"
shell.Run command, 0, False
