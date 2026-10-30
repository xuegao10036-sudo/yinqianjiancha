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
rem v10.44: extension menu icon (images/icon.png) ships with the package
if exist "%DEST%\images" rmdir /S /Q "%DEST%\images"
rem v10.28: each xcopy checks its own errorlevel - a trailing check only reflects the last copy
xcopy "%~dp0CSXS" "%DEST%\CSXS" /E /I /Y /Q >nul || set "FAIL=1"
xcopy "%~dp0css"  "%DEST%\css"  /E /I /Y /Q >nul || set "FAIL=1"
xcopy "%~dp0js"   "%DEST%\js"   /E /I /Y /Q >nul || set "FAIL=1"
xcopy "%~dp0jsx"  "%DEST%\jsx"  /E /I /Y /Q >nul || set "FAIL=1"
rem v11.63b: images/ only carries the menu icon. The repo mirror does not include it,
rem   so a downloaded package may have no images/ at all. Missing icon = cosmetic,
rem   the panel works anyway -> skip instead of failing the whole install.
if exist "%~dp0images" (
  xcopy "%~dp0images" "%DEST%\images" /E /I /Y /Q >nul || set "FAIL=1"
) else (
  echo       NOTE - no images\ in this package; menu icon will be missing.
  echo              The panel itself works fine.
)
xcopy "%~dp0index.html" "%DEST%\" /E /I /Y /Q >nul || set "FAIL=1"
if not exist "%DEST%\CSXS\manifest.xml" set "FAIL=1"
if not exist "%DEST%\css\style.css" set "FAIL=1"
if not exist "%DEST%\js\main.js" set "FAIL=1"
if not exist "%DEST%\jsx\preflight.jsx" set "FAIL=1"
rem v11.63b: only verify the icon when the package actually shipped one
if exist "%~dp0images" if not exist "%DEST%\images\icon.png" set "FAIL=1"
if not exist "%DEST%\index.html" set "FAIL=1"
if defined FAIL echo       FAILED - see TROUBLESHOOTING below.
if not defined FAIL echo       OK - files copied.

echo.
echo [2/3] Enable CEP debug mode (required for unsigned extensions)
set "REGFAIL="
rem v10.28: errorlevel check inside the loop - a check after the loop only sees the last reg add
for /l %%V in (9,1,16) do (
  reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1 || set "REGFAIL=1"
)
if defined REGFAIL echo       WARN - could not write PlayerDebugMode.
if defined REGFAIL echo              FIX: run as administrator, or add it in regedit by hand.
if not defined REGFAIL echo       OK - PlayerDebugMode set to 1 for CSXS 9 to 16.

echo.
echo [3/3] Done.
echo.
echo   NEXT : restart Adobe Illustrator
echo          Menu: Window -^> Extensions -^> the preflight panel
echo.

rem v11.63b: "All done" and "registry FAILED" must not be printed together
if not defined FAIL if not defined REGFAIL echo All done. You can close this window.
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
rem v10.32: fallback hold. Normally the msgbox below blocks until the user clicks OK and
rem   the line after it never runs. But if PowerShell is blocked by AppLocker or group
rem   policy, both msgbox calls return at once and this window flashes past, so nobody
rem   ever sees the FAILED / TROUBLESHOOTING text. Hence a plain builtin wait here.
rem v10.33: the old form was "timeout ... or pause" followed by another pause, so the
rem   window waited twice (found in the v10.32 external review). Now pause only: it is a
rem   cmd builtin (not blocked by group policy) and a keypress beats a blind 30s wait.
rem v11.63c: this block used to be in Chinese. The .bat is UTF-8 but cmd reads it in the
rem   system codepage (GBK on a Chinese Windows), so the bytes were re-decoded into
rem   garbage that broke the parser idea of where quotes and pipes end. The tail then ran
rem   fragments such as ut or pause as commands -- exactly the "not recognized as an
rem   internal or external command" lines users reported. Keep this file ASCII-only:
rem   no Chinese, no pipes, no backticks, no full-width punctuation on rem lines.
rem v11.63b: hold the window for the registry-only failure too -- otherwise the FIX
rem   hint scrolls away and the window closes before anyone can read it.
if defined FAIL echo Press any key to close this window...
if not defined FAIL if defined REGFAIL echo Press any key to close this window...
if defined FAIL pause >nul
if not defined FAIL if defined REGFAIL pause >nul
if defined FAIL exit /b 1
exit /b 0
