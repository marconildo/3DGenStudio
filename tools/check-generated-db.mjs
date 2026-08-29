// Fails if db/names.js or db/schema.pg.sql is out of date with storage.js.
//
// Both are generated from the schema and queries in storage.js, and both fail
// SILENTLY when stale: a missing name means `row.filePath` reads undefined on
// PostgreSQL, and a missing column means a query that works on a desktop install
// errors on the shared server. Neither is caught by lint or by any SQLite test.
//
// Wired into the dist scripts alongside check:packaging, which exists for the
// same reason — a build that cannot run is better than one that runs wrong.
//
//   node tools/check-generated-db.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GENERATED = [
  { file: 'db/names.js', generator: 'tools/gen-db-names.mjs' },
  { file: 'db/schema.pg.sql', generator: 'tools/gen-pg-schema.mjs' }
];

const before = new Map();
for (const { file } of GENERATED) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) {
    console.error(`FAIL: ${file} is missing entirely. Run its generator.`);
    process.exit(1);
  }
  before.set(file, fs.readFileSync(full, 'utf8'));
}

// Regenerating in place and comparing is the only honest check: it is exactly
// what a developer would get by running the generator themselves.
for (const { generator } of GENERATED) {
  execFileSync(process.execPath, [path.join(ROOT, generator)], { cwd: ROOT, stdio: 'pipe' });
}

const stale = [];
for (const { file, generator } of GENERATED) {
  const now = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (now !== before.get(file)) stale.push({ file, generator });
}

if (stale.length) {
  console.error('FAIL: generated database files are out of date with storage.js.\n');
  for (const { file, generator } of stale) {
    console.error(`  ${file} — regenerate with: node ${generator}`);
  }
  console.error('\nThey have just been regenerated in place; review and commit them.');
  process.exit(1);
}

console.log('db/names.js and db/schema.pg.sql are up to date with storage.js');
