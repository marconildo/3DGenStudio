@echo off
cd /d "%~dp0"
set GENSTUDIO_MODE=server
set PORT=3001
set GENSTUDIO_JWT_SECRET=<the 64 hex characters>
set GENSTUDIO_ADMIN_LOGIN=admin
set GENSTUDIO_ADMIN_PASSWORD=<at least 8 characters>
set TRUST_PROXY_HEADERS=0
node server.js