@echo off
cd /d "%~dp0"
start http://localhost:3033
npx next dev --port 3033
