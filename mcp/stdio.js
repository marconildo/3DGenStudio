#!/usr/bin/env node
// stdio entry point for MCP clients that spawn a process (e.g. Claude Desktop
// local servers). It is a thin bridge: tools still call the RUNNING 3D Gen
// Studio backend over loopback HTTP — this process never opens the database.
//
// Usage: node mcp/stdio.js        (app must be running; its port is discovered)
//        GENSTUDIO_URL=http://localhost:3001 node mcp/stdio.js
//        node mcp/stdio.js --tools=projects,graph,assets   (load only those groups)
//        node mcp/stdio.js --tools=-mesh                   (load everything except mesh)
//
// The full catalog costs a client ~25k tokens of system prompt per session, so
// --tools / MCP_TOOLS lets a small-context model load only what it needs. The
// flag exists as well as the env var because clients differ in whether they
// pass `env` through to the spawned process — every client passes `args`.
import process from 'node:process';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './index.js';

// The backend does not always live on 3001: the desktop shell moves it when
// something else holds that port. It publishes where it landed to
// <data dir>/runtime.json (server.js: publishRuntimeInfo), so look there before
// falling back. Order: explicit URL/PORT -> published file -> 3001.
function runtimeDataDirs() {
  const dirs = [];
  if (process.env.GENSTUDIO_DATA_ROOT) dirs.push(path.join(process.env.GENSTUDIO_DATA_ROOT, 'data'));
  dirs.push(path.join(process.cwd(), 'data')); // repo checkout / Docker mount
  // The desktop app runs the backend with cwd = Electron's userData dir, so the
  // published file lands under the per-platform app-data path, not the checkout.
  const home = os.homedir();
  if (process.platform === 'win32' && process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, '3DGenStudio', 'data'));
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', '3DGenStudio', 'data'));
  } else {
    dirs.push(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), '3DGenStudio', 'data'));
  }
  return dirs;
}

function discoverBaseUrl() {
  if (process.env.GENSTUDIO_URL) return process.env.GENSTUDIO_URL;
  if (process.env.PORT) return `http://127.0.0.1:${process.env.PORT}`;
  for (const dir of runtimeDataDirs()) {
    try {
      const info = JSON.parse(readFileSync(path.join(dir, 'runtime.json'), 'utf8'));
      if (info?.port) return info.origin || `http://127.0.0.1:${info.port}`;
    } catch {
      // not there, or stale/corrupt — try the next location
    }
  }
  return 'http://127.0.0.1:3001';
}

const baseUrl = discoverBaseUrl().replace(/\/+$/, '');

// --tools=a,b  |  --tools a,b  |  fall back to MCP_TOOLS, then every group.
function readToolsFlag(argv) {
  const index = argv.findIndex(arg => arg === '--tools' || arg.startsWith('--tools='));
  if (index === -1) return undefined;
  const arg = argv[index];
  return arg.startsWith('--tools=') ? arg.slice('--tools='.length) : argv[index + 1];
}

const groups = readToolsFlag(process.argv.slice(2)) ?? process.env.MCP_TOOLS;

try {
  const res = await fetch(`${baseUrl}/api/projects`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(`3D Gen Studio is not reachable at ${baseUrl} (${err?.message || err}).`);
  console.error('Start the app first (npm run dev, or launch the desktop app), then retry.');
  process.exit(1);
}

const server = buildMcpServer({ baseUrl, groups });
await server.connect(new StdioServerTransport());
