@echo off
REM Starts the "Kisa Ennustaja" app.
REM Serves the folder over HTTP (ES modules require this) and opens the browser.

cd /d "%~dp0"

REM Open the app in the default browser
start "" "http://localhost:8000/index.html"

REM Start the local web server (blocks; close this window or press Ctrl+C to stop)
echo Starting server at http://localhost:8000 ...
echo Close this window or press Ctrl+C to stop the server.
py -3.13 -m http.server 8000
