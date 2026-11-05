@echo off
chcp 65001 >nul
set TREES_HOME=F:\项目\Trees\forest
node "F:\项目\Trees\tools\bin\cli.js" water-tree quant-entry-timing --in ops >> "%USERPROFILE%\.trees\water-quant.log" 2>&1
