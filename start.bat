@echo off
cd /d "%~dp0"

echo ============================================
echo   Diary Companion - One-Click Launcher
echo ============================================
echo.

start "diary-proxy" cmd /k python proxy.py
echo [1/3] Local proxy launched in new window (port 8080)

start "diary-web" cmd /k python -m http.server 8000
echo [2/3] Web server launched in new window (port 8000)

timeout /t 2 /nobreak >nul
start http://localhost:8000
echo [3/3] Browser opened at http://localhost:8000

echo.
echo Done! To stop the services, just close the two CMD windows that popped up.
echo.
pause