@echo off
cd /d "%~dp0"
set GENSTUDIO_MODE=server
set PORT=3001
set GENSTUDIO_JWT_SECRET=<the 64 hex characters>
set GENSTUDIO_ADMIN_LOGIN=admin
set GENSTUDIO_ADMIN_PASSWORD=<at least 8 characters>
set TRUST_PROXY_HEADERS=0

rem A shared server runs on PostgreSQL, because SQLite serialises every request
rem through a single writer and a team feels that immediately.
rem
rem "embedded" means 3D Gen Studio installs and runs PostgreSQL itself, under
rem data\. Nothing to install or administer; the first start downloads about
rem 330 MB and takes a few minutes, and every start after that is seconds.
rem
rem To use a PostgreSQL you already run instead, delete this line and set
rem GENSTUDIO_DATABASE_URL to its connection string. Removing both leaves the
rem server on SQLite, which is fine for one or two people and not beyond that.
set GENSTUDIO_DATABASE=embedded

rem MIGRATING an existing SQLite server: move the data across BEFORE the first
rem start, or the server refuses to boot rather than come up looking wiped.
rem The embedded database prints its own URL on startup; for a one-off migration
rem start the server once to create it, then:
rem   node tools\migrate-sqlite-to-postgres.mjs --from .\data\app.db --to <that url>

node server.js
