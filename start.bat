@echo off
REM Starts the "Kisa Ennustaja" app.
REM Serves the folder over HTTP (ES modules require this) and opens the browser.
REM Works with any Python 3: tries the "py" launcher, then python, then python3.

cd /d "%~dp0"

REM Pick the first command that actually runs Python 3. Running it (rather than
REM just "where") skips the Microsoft Store "python" stub and old Python 2.
set "PY="
py -3 -c "" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(sys.version_info[0] < 3)" >nul 2>nul && set "PY=python"
if not defined PY python3 -c "" >nul 2>nul && set "PY=python3"
if not defined PY (
  echo Python 3 was not found. Install it from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" in the installer.
  pause
  exit /b 1
)

REM Open the app in the default browser
start "" "http://localhost:8000/index.html"

REM Start the local web server (blocks; close this window or press Ctrl+C to stop)
echo Starting server at http://localhost:8000 ...
echo Close this window or press Ctrl+C to stop the server.
%PY% serve.py 8000
