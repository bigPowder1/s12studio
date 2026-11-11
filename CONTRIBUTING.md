# Contributing to S12 Studio

Thanks for helping. Bug reports from students are the most useful contribution: a small project that builds or
runs differently from the lab PC is gold.

## Ground rules

- **Byte-identical is the bar** for assembler, linker and burner output (except timestamps, user names and absolute
  paths). When unsure how CodeWarrior behaves, check golden output first, then `docs/research/`. Mark guesses with an
  `// UNCERTAIN:` comment so they are easy to find and change.
- **No NXP/Freescale/Metrowerks/PEmicro files.** Do not commit stock `.inc` files, wizard templates, manuals, DLLs or
  text copied from them. Generate equivalents from data sheets and describe behaviour in your own words.
- **GPL code** (binutils, the gdb simulator, USBDM) may be read for reference only; do not copy from it.
- **No course content or student work.** Never commit graded lab solutions, the ME 3305 library or the instructor's
  template, and never bundle them into the installers: students open the `blank_project` folder their course gives
  them. Public demo projects in `examples/` must be written by us (`examples/blinky` ships in the installers).
- Engine packages (`packages/*`) are pure TypeScript with no Electron or DOM dependency; they must run under plain
  Node.

## Setup

```bash
npm ci
npx vitest run                          # all tests
npx vitest run packages/asm             # one package
npx tsc -p tsconfig.json --noEmit
npm run typecheck -w @s12/ide
npm run app:e2e                         # app end-to-end tests (Playwright + Electron)
```

Conventions are in `CLAUDE.md` (TypeScript strict, ESM, Vitest tests in `packages/<pkg>/test/*.test.ts`,
`Uint8Array`/`DataView` for binary data). App architecture: `apps/ide/README.md`.

### Golden tests and the private fixtures

Tests that compare against real CodeWarrior output need the private fixtures repository. Maintainers check it out at
`fixtures/` (ignored by git) or set `S12_FIXTURES=/path/to/fixtures`. Without it those tests are skipped, so a plain
clone runs green. Tests that spell out the fixtures' contents (a student's lab, the course library) live in that
private repository too: Vitest specs in its `tests/` (added to `npx vitest run` by `vitest.config.ts` when the
fixtures are found) and Playwright specs in its `e2e/` (the `private` project of `apps/ide/e2e/playwright.config.ts`,
which needs the checkout at `fixtures/`). Public tests use only `examples/` and synthetic code. If your change
touches assembler/linker/burner output, say so in the pull request; a maintainer runs the golden suite (the Golden
workflow of the private fixtures repository, `docs/ci/fixtures-golden.yml`; it is kept out of this repository so
that fixture content never appears in public CI logs).

### Line endings

The repository stores text with LF (`.gitattributes`). Files that must keep CRLF or exact bytes (assembler
conformance sources, CodeWarrior binaries and goldens) are marked `-text`. CodeWarrior text outputs (`.lst`, `.dbg`,
`.map`, `.s19`) are written with CRLF by the tools themselves.

## Pull requests

- Keep changes focused; add or update tests.
- Before opening a PR: `npx vitest run`, `npx tsc -p tsconfig.json --noEmit` and `npm run typecheck -w @s12/ide`
  pass. CI runs these on Windows, macOS and Linux plus the end-to-end tests on Linux and Windows (the public demo
  `e2e/public-demo.spec.ts`; specs that need the private fixtures skip) and a smoke test of a packaged build
  (`npm run dist:dir`, then `e2e/packaged.spec.ts`).
- By contributing you agree that your contribution is licensed under the Apache License 2.0.
