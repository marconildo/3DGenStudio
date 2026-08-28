// Guards both packaging allowlists against a missing backend module.
//
//   node tools/check-packaged-modules.mjs
//
// server.js imports its modules statically, so any module left out of an
// allowlist kills the packaged backend at startup with ERR_MODULE_NOT_FOUND —
// the Docker container never becomes healthy, and the desktop app crashes on
// the splash screen. That has now happened three times (gateway.js and
// dataStore.js in the image, then all five new modules in the Electron build).
//
// Two things make it easy to miss:
//   * uploadQueue.js is reached only via dataStore.js, so checking server.js's
//     own import list is not enough — this walks the graph transitively.
//   * the two allowlists are in different files with different syntax, and
//     adding a module to one is no reminder to add it to the other.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(repoRoot, file), 'utf8');

// Walk every local module reachable from the backend entry point.
function collectModules(entry) {
  const visited = new Set();
  const pending = [entry];

  while (pending.length) {
    const file = pending.shift();
    if (visited.has(file)) continue;
    const absolute = path.join(repoRoot, file);
    if (!existsSync(absolute)) continue;
    visited.add(file);

    const source = readFileSync(absolute, 'utf8');
    const dir = path.dirname(file);
    for (const match of source.matchAll(/from '(\.[^']+)'/g)) {
      pending.push(path.join(dir, match[1]).split(path.sep).join('/'));
    }
  }

  return [...visited].filter(file => file !== entry).sort();
}

const modules = collectModules('server.js');

const dockerfile = read('Dockerfile');
const dockerignore = read('.dockerignore');
const electronBuilder = read('electron-builder.yml');

const problems = [];

for (const module of modules) {
  // Both allowlists work at the top-level entry: a file, or a directory such
  // as mcp/ that is included wholesale.
  const entry = module.split('/')[0];
  const isDirectory = module.includes('/');

  if (!dockerfile.includes(entry)) {
    problems.push(`${module} — missing from the COPY line in Dockerfile`);
  }
  if (!dockerignore.includes(`!${entry}`)) {
    problems.push(`${module} — missing from .dockerignore (add "!${entry}")`);
  }
  // electron-builder lists plain files by name and directories as "dir/**/*".
  const electronPatterns = [`- ${entry}`, `- ${entry}/**`];
  if (!electronPatterns.some(pattern => electronBuilder.includes(pattern))) {
    problems.push(`${module} — missing from files: in electron-builder.yml (add "  - ${isDirectory ? `${entry}/**/*` : entry}")`);
  }
}

if (problems.length) {
  console.error('Backend modules missing from a packaging allowlist:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('\nA packaged build will crash at startup with ERR_MODULE_NOT_FOUND.');
  process.exit(1);
}

console.log(`All ${modules.length} modules reachable from server.js ship in both the Docker image and the desktop build:`);
for (const module of modules) console.log(`  ${module}`);
