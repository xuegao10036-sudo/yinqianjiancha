@echo off
setlocal
rem Remove the pre-2026-10 folder name so old copies do not pile up
if exist "%APPDATA%\Adobe\CEP\extensions\com.workbuddy.ai.preflight" rmdir /S /Q "%APPDATA%\Adobe\CEP\extensions\com.workbuddy.ai.preflight"
set "DEST=%APPDATA%\Adobe\CEP\extensions\yinqianjiancha"
set "FAIL="

echo ============================================
echo   AI Preflight Panel  -  Install
echo ============================================
echo.
echo [1/3] Copy files
echo       from : %~dp0
echo       to   : %DEST%
echo.
if not exist "%DEST%" mkdir "%DEST%"
rem v10.10: clear old sub-folders first so renamed/removed files cannot survive an update
if exist "%DEST%\CSXS" rmdir /S /Q "%DEST%\CSXS"
if exist "%DEST%\css" rmdir /S /Q "%DEST%\css"
if exist "%DEST%\js" rmdir /S /Q "%DEST%\js"
if exist "%DEST%\jsx" rmdir /S /Q "%DEST%\jsx"
xcopy "%~dp0CSXS" "%DEST%\CSXS" /E /I /Y /Q >nul
xcopy "%~dp0css"  "%DEST%\css"  /E /I /Y /Q >nul
xcopy "%~dp0js"   "%DEST%\js"   /E /I /Y /Q >nul
xcopy "%~dp0jsx"  "%DEST%\jsx"  /E /I /Y /Q >nul
xcopy "%~dp0index.html" "%DEST%\" /E /I /Y /Q >nul
if errorlevel 1 set "FAIL=1"
rem v10.10: verify all 5 payloads - the errorlevel above only reflects the last copy
if not exist "%DEST%\CSXS\manifest.xml" set "FAIL=1"
if not exist "%DEST%\css\style.css" set "FAIL=1"
if not exist "%DEST%\js\main.js" set "FAIL=1"
if not exist "%DEST%\jsx\preflight.jsx" set "FAIL=1"
if not exist "%DEST%\index.html" set "FAIL=1"
if defined FAIL echo       FAILED - see TROUBLESHOOTING below.
if not defined FAIL echo       OK - files copied.

echo.
echo [2/3] Enable CEP debug mode (required for unsigned extensions)
set "REGFAIL="
for /l %%V in (9,1,16) do reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
if errorlevel 1 set "REGFAIL=1"
if defined REGFAIL echo       WARN - could not write PlayerDebugMode.
if defined REGFAIL echo              FIX: run as administrator, or add it in regedit by hand.
if not defined REGFAIL echo       OK - PlayerDebugMode set to 1 for CSXS 9 to 16.

echo.
echo [3/3] Done.
echo.
echo   NEXT : restart Adobe Illustrator
echo          Menu: Window -^> Extensions -^> the preflight panel
echo.

if not defined FAIL echo All done. You can close this window.
if not defined FAIL if defined REGFAIL echo NOTE: files copied, but the registry switch FAILED - see [2/3] above.
if defined FAIL echo ------------------------------------------------------------
if defined FAIL echo   TROUBLESHOOTING
if defined FAIL echo   1. Extract the ZIP first, then run this file from the
if defined FAIL echo      extracted folder. Do NOT run it from inside the ZIP.
if defined FAIL echo   2. Avoid Chinese characters or spaces in the folder path.
if defined FAIL echo      Example: put the folder in D:\ailight first.
if defined FAIL echo   3. If this file is blocked: right-click it, Properties,
if defined FAIL echo      tick "Unblock" at the bottom, OK, then run again.
if defined FAIL echo   4. Last resort: right-click, "Run as administrator".
if defined FAIL echo ------------------------------------------------------------
if not defined FAIL powershell -NoProfile -WindowStyle Hidden -EncodedCommand QQBkAGQALQBUAHkAcABlACAALQBBAHMAcwBlAG0AYgBsAHkATgBhAG0AZQAgAFMAeQBzAHQAZQBtAC4AVwBpAG4AZABvAHcAcwAuAEYAbwByAG0AcwA7ACAAWwBTAHkAcwB0AGUAbQAuAFcAaQBuAGQAbwB3AHMALgBGAG8AcgBtAHMALgBNAGUAcwBzAGEAZwBlAEIAbwB4AF0AOgA6AFMAaABvAHcAKAAiAIlbxYgQYp9SAf/yXYaJ1nYgADUAIAAqTodl9k4a/woAbQBhAG4AaQBmAGUAcwB0AC4AeABtAGwAATBzAHQAeQBsAGUALgBjAHMAcwABMG0AYQBpAG4ALgBqAHMAATBwAHIAZQBmAGwAaQBnAGgAdAAuAGoAcwB4AAEwaQBuAGQAZQB4AC4AaAB0AG0AbAAKAAoA94vNkS9UIABJAGwAbAB1AHMAdAByAGEAdABvAHIAGv+XeuNTIACSISAAaWJVXJ9S/YAgAJIhIABwU01SwGjlZy0A6pbVfCIALAAgACIAiVvFiIxbEGIiACwAIAAiAE8ASwAiACwAIAAiAEkAbgBmAG8AcgBtAGEAdABpAG8AbgAiACkA
if defined FAIL powershell -NoProfile -WindowStyle Hidden -EncodedCommand QQBkAGQALQBUAHkAcABlACAALQBBAHMAcwBlAG0AYgBsAHkATgBhAG0AZQAgAFMAeQBzAHQAZQBtAC4AVwBpAG4AZABvAHcAcwAuAEYAbwByAG0AcwA7ACAAWwBTAHkAcwB0AGUAbQAuAFcAaQBuAGQAbwB3AHMALgBGAG8AcgBtAHMALgBNAGUAcwBzAGEAZwBlAEIAbwB4AF0AOgA6AFMAaABvAHcAKAAiAIlbxYgxWSWNAf/mi8VgwYnRnnKCp2M2UvBTl3rjUxr/h2X2Tg1ZNlL6URmVDP8WYgOM1YsAX3NRmVFlUTFZJY0CMCIALAAgACIAiVvFiDFZJY0iACwAIAAiAE8ASwAiACwAIAAiAEUAcgByAG8AcgAiACkA

echo.
if defined FAIL pause
if defined FAIL exit /b 1
exit /b 0
