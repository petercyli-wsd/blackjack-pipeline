Option Explicit
Dim shell, fso, root, runtime, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
runtime = fso.BuildPath(root, "runtime\node.exe")
shell.CurrentDirectory = root
If Not fso.FileExists(runtime) Then
  MsgBox "Use npm install and npm start for this source project, or extract the portable ZIP with its runtime folder.", 48, "Dealer Transition Studio Web"
  WScript.Quit 1
End If
command = Chr(34) & runtime & Chr(34) & " " & Chr(34) & fso.BuildPath(root, "server.js") & Chr(34) & " --open"
shell.Run command, 0, False
