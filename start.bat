@echo off
title Local Dev Dashboard
cd /d "%~dp0"
echo Starting Local Dev Dashboard on http://localhost:4000...
node server.mjs
pause
