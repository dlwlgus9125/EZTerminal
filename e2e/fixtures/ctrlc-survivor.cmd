@ECHO off
SETLOCAL
SET "dp0=%~dp0"
IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
)
"%_prog%"  "%dp0%\ctrlc-survivor.js" %*
