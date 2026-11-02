@echo off
echo ==========================================================
echo    AEROS PAY - 100%% CLEAN APP INSTANT EXPORTER
echo ==========================================================
echo Exporting clean application files without node_modules (786MB)...
node scripts\export-clean.mjs %*
echo.
pause

