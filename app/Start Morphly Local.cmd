@echo off
setlocal
cd /d "%~dp0"
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0scripts\launch-branded-electron-dev.cjs"
endlocal
