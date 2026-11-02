' Runs node with a script, without showing a console window. Used by install-autostart.ps1.
Set shell = CreateObject("WScript.Shell")
shell.Run """" & WScript.Arguments(0) & """ """ & WScript.Arguments(1) & """", 0, False
