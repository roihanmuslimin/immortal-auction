# Immortal Auction: Liquid Ink

Browser game inspired by Chinese cultivation donghua. This repository is the Stage A foundation:
the deterministic Living Ledger core, persistence, localization and tooling described in the
Consolidated Design Document v1.1 (sections 5.1 to 5.13).

Status: **Stage A, task A1 (scaffold, lint, CI skeleton, import workflow).** Later tasks arrive one at a time through the import workflow.

## Commands

Requires Node.js 22 or newer. No runtime dependencies. The bundler (esbuild, pinned) is a dev dependency used only by `build`.

| Command | What it does |
|---|---|
| `node tools/lint/run.mjs` | Project lint: dependency boundaries, simulation purity, no display text |
| `node --test "tests/**/*.test.mjs"` | All automated tests (Node built-in runner) |
| `npm install && node tools/build.mjs` | Bundle `src/main.js` to `dist/app.js` and write `dist/size-report.json` |

`npm run lint`, `npm test`, `npm run build` and `npm run check` are shortcuts for the same commands.

## Layout

- `src/core`: Ledger, commands, projections, clocks, RNG, money (grows in A2 to A7, A14, A15).
- `src/data`: content registry (A6). `src/persistence`: saves (A8 to A10). `src/i18n`: text (A11). `src/dev`: developer tools (A12).
- `src/main.js`: application entry, the only file allowed to import every layer.
- `tools/lint`: lint rules and runner. `tools/import`: task-package validator and importer. `tools/package-task.mjs`: builds task packages.
- `tests`: automated tests and fixtures. `docs`: documentation. `.github/workflows`: CI and the import workflow.

## Rules enforced by lint

1. **Boundaries.** Core imports only core. Gameplay never imports persistence. UI never imports persistence. Bare (package) imports are not allowed in `src/`. Node built-ins only in `src/dev`. New `src/` folders must be registered in `tools/lint/rules.mjs`.
2. **Simulation purity** (`core`, `data`, `gameplay`). No `Math.random`, `Date`, `performance.now`, timers, floating-point literals, `parseFloat`, floating-point `Math` functions or `**`. Exceptions need `// lint-allow:<float|random-time> <reason>` on the same line.
3. **No display text** (`core`, `data`, `gameplay`). English sentences belong in `src/i18n`. Developer error messages passed to `new Error(...)` are exempt. Exceptions need `// lint-allow:display-text <reason>`.

## Delivery

Tasks arrive as ZIP packages through a validated import workflow. See `docs/DELIVERY.md`.
Design reference: `docs/stage-a/A1.md` and the Consolidated Design Document v1.1.
