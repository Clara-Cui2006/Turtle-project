Option Explicit

Dim shell, fileSystem, projectRoot, command, background
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
projectRoot = fileSystem.GetParentFolderName(WScript.ScriptFullName)
background = WScript.Arguments.Named.Exists("background")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & projectRoot & "\start-turtle.ps1"""
If background Then command = command & " -NoBrowser -SkipBuild"
shell.Run command, 0, False
