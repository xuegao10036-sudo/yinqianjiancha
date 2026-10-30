@echo off
setlocal
set "DEST=%APPDATA%\Adobe\CEP\extensions\yinqianjiancha"
set "DEST_OLD=%APPDATA%\Adobe\CEP\extensions\com.workbuddy.ai.preflight"

echo ============================================
echo   AI Preflight Panel  -  Uninstall
echo ============================================
echo.
echo Target: %DEST%
echo.
if not exist "%DEST%" echo       Nothing installed. Nothing to remove.
if exist "%DEST%" rmdir /S /Q "%DEST%"
if exist "%DEST_OLD%" rmdir /S /Q "%DEST_OLD%"
if exist "%DEST%" echo       FAILED - close Illustrator and run again,
if exist "%DEST%" echo                or delete the folder above manually.
if not exist "%DEST%" echo       OK - extension files removed.
echo.
echo   NEXT : restart Adobe Illustrator
echo.
pause
exit /b 0
