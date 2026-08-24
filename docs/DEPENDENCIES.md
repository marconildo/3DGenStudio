# Dependency notes

Why `package.json` looks the way it does. Mostly this file exists for the
`overrides` block, which is load-bearing and — being JSON — cannot carry its own
comment. Deleting an entry silently reintroduces a published advisory.

## The `overrides` block

Three transitive packages ship known-vulnerable versions and are pinned by their
parents, so npm cannot resolve a fixed version on its own. `npm audit fix
--force` "solves" all three by *downgrading the parent* (`@excalidraw/excalidraw`
→ 0.17.6, `tencentcloud-sdk-nodejs-intl-en` → 3.0.903), which trades an advisory
for a two-year-old dependency. An override is the cheaper fix in every case.

| Override | Why it exists | When it can go away |
| --- | --- | --- |
| `lodash-es: ^4.18.1` | `chevrotain` pins `lodash-es` at exactly `4.17.21`, which is vulnerable to code injection via `_.template` and prototype pollution in `_.unset`/`_.omit`. The chain is `@excalidraw/excalidraw → @excalidraw/mermaid-to-excalidraw → @mermaid-js/parser → langium → chevrotain`, i.e. only the Boards page's mermaid import. All of chevrotain's deep imports (`lodash-es/assign.js`, …) still exist in 4.18.x. | `chevrotain` > 11.1.0, once langium/mermaid pick it up. |
| `@excalidraw/excalidraw: { nanoid: ^3.3.18 }` | Excalidraw pins `nanoid` at exactly `3.3.3` (predictable ids for non-integer sizes, infinite loops on negative/zero size). `3.3.18` is the patched 3.x — the same version `vite → postcss` already resolves, so this dedupes rather than adding a copy. | Excalidraw > 0.18.1 with a patched pin. |
| `@excalidraw/mermaid-to-excalidraw: { nanoid: ^5.1.16 }` | Same advisory, different pin — `4.0.2`. Scoped (not global) on purpose: nanoid 5 is ESM-only, and forcing it globally would break the CJS `postcss` that Vite loads at build time. `mermaid-to-excalidraw` is `type: module` and browser-bundled, so 5.x is safe *there*. | Same as above. |
| `tencentcloud-sdk-nodejs-intl-en: { uuid: ^11.1.1 }` | The SDK asks for `uuid@^9.0.1`; the fix for the v3/v5/v6 buffer bounds check landed in `11.1.1`. The SDK does `require("uuid").v4`, and 11.x still ships a real CJS entry point (`dist/cjs/index.js`) — do **not** bump this to 14.x, which drops it. | The SDK widening its range past 11. |

After changing any of them:

```bash
npm install && npm audit          # must report 0 vulnerabilities
npm run build                     # rolldown statically checks ESM exports —
                                  # a missing lodash-es/nanoid export fails here
```

The Boards page (`/board?projectId=…`) is the only runtime consumer of the
excalidraw/mermaid chain. A conversion that returns elements exercises
`@mermaid-js/parser → langium → chevrotain → lodash-es` and both nanoid copies in
one shot, which is the cheapest way to prove the overrides hold.

## Electron and electron-builder move together

`electron` and `electron-builder` are both devDependencies and both need to stay
current: between them they account for the bulk of any `npm audit` report
(35 Electron/Chromium advisories, plus the `app-builder-lib` → `builder-util` →
`tar` chain, where `tar` is the one that reaches *critical*).

Two things make the Electron major bumps cheap here, and both are worth keeping
that way:

- **The main process uses a small, stable API surface** — `BrowserWindow`,
  `ipcMain.handle`, `shell`, `dialog`, with `contextIsolation: true` and
  `nodeIntegration: false`. Nothing deprecated, nothing removed across majors.
- **`sqlite3` is N-API** (`napi_versions: [3, 6]`), so its binary is ABI-stable.
  electron-builder still runs `@electron/rebuild` on it while packaging, but the
  result loads under *both* plain Node (`npm start`) and Electron. A native
  dependency that is not N-API would break one of those two paths on every
  Electron bump.

`@electron/rebuild` unlinks `node_modules/sqlite3/build/Release/node_sqlite3.node`
while packaging, so a running backend (`npm start`, `npm run dev`) makes
`electron-builder` fail with `EPERM: operation not permitted, unlink`. Stop the
dev server before `npm run dist`.

## Deliberately left behind

These are out of their declared semver range — unrelated to any advisory, and
each needs its own testing pass:

`eslint` / `@eslint/js` 10, `three` + `@types/three` 0.185, `ag-psd` 31,
`concurrently` 10, `react-markdown` 10.

## `npm run lint` runs out of memory

Pre-existing, and not a dependency problem: `eslint.config.js` only ignores
`dist`, so `eslint .` walks into `comfyui/venv/`, `thirdparty/*/.venv/` and
`release/`, hits the multi-megabyte JS bundles vendored inside those Python
packages, and dies at the 4 GB heap limit. Lint the source dirs explicitly until
the ignore list is fixed:

```bash
npx eslint src electron mcp server.js storage.js logs.js meshPivot.js wikiStorage.js
```
