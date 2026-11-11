# S12 Studio — CodeWarrior S12(X) v5.1 clone

A local, functional clone of Freescale CodeWarrior for S12(X) v5.1 (IDE + hiwave "True-Time Simulator & Real-Time
Debugger") for Cal Poly ME 3305 (MC9S12XDP512, assembly only). Full plan: `docs/PLAN.md`.

## Ground rules
- **Fixtures are private and read-only.** The golden projects (`Lab3` = a graded student lab solution,
  `blank_project` = the instructor's template, the ME3305 library) live in a separate PRIVATE repo
  (`s12studio-fixtures`) checked out at `fixtures/` (gitignored here) or pointed to by env `S12_FIXTURES`. They are
  real CodeWarrior 5.1 projects with golden outputs (`bin/*.lst`, `bin/*.map`, `bin/*.abs`, `bin/*.s19`,
  `*_Data/Standard/ObjectCode/*.o`). Never edit them; tests compare our output against them. Each package/app
  resolves the fixtures dir through ONE helper (e.g. `packages/formats/test/fixtures.ts`), and fixture-dependent
  tests skip with a clear reason when it is absent (check with `S12_FIXTURES=/nonexistent npx vitest run`).
  `/Lab3` at repo root is the owner's original copy (gitignored) — never touch it.
- **Never commit course content or student work** to this public repo: no Lab3 code or fragments, no
  `ME305LibV4.0.lib`, no instructor template, no screenshots of them. Course content is never shipped: installers
  contain no ME3305 library or template; students open the course's own `blank_project` (File > Open its `.mcp`).
  Public demo projects go in `examples/` (written by us, standalone `<name>.s12studio.json` sidecar projects, no
  `.mcp`; `examples/blinky` is bundled in the installers). Tests and notes that spell out fixture details (Lab3 names,
  library code) are private too: Vitest specs in `fixtures/tests/`, Playwright specs in `fixtures/e2e/`, research in
  `fixtures/research/` (picked up automatically when the fixtures are present).
- **Byte-identical is the bar** for assembler/linker/burner output (except timestamps, user names, absolute paths).
  When unsure how CodeWarrior behaves, check the golden files first, then `docs/research/`. Do not guess silently —
  mark guesses with a `// UNCERTAIN:` comment and make them easy to change.
- Research specs live in `docs/research/r2/*.md` (S12X/XDP512/ME3305/formats — authoritative for this project) and
  `docs/research/r1/*.md` (CPU12 ISA, assembler, IDE/hiwave UI). Notes on the ME3305 library's internals
  (`me3305-board.md`, the full `elf-lib-formats.md`) are private: `fixtures/research/` (cited as "private
  me3305-board.md"); never copy them into this repo. Keep research notes in our own words: short cited
  excerpts only, no verbatim NXP/Metrowerks manual or template text, no personal paths or names.
- Never ship NXP-copyrighted files (stock `.inc`, templates). Generate equivalents from datasheets.
- GPL code (binutils, gdb sim, USBDM) may be read for reference only; do not copy code from it.

## Code conventions
- npm workspaces monorepo, TypeScript strict, ESM. Packages: formats, isa (shared CPU12/S12X opcode tables +
  disassembler), asm, link, sim, debug, hw, project, devices. Imported as `@s12/<name>` (aliases in
  `tsconfig.base.json` and `vitest.config.ts`). Engine packages (`packages/*`) are pure TS with **no Electron or DOM
  dependency** and must run under plain Node.
- Binary data: `Uint8Array`/`DataView` in engine code (Node `Buffer` only in tests/tools).
- Tests: Vitest, `packages/<pkg>/test/*.test.ts`. Golden tests read fixtures via `packages/formats/test/fixtures.ts`.
  Run `npx vitest run` (all) or `npx vitest run packages/<pkg>`; typecheck with `npx tsc -p tsconfig.json --noEmit`.
- Keep modules small and focused; prefer data tables over long switch statements where the spec is tabular.
- Line endings: inputs may be LF or CRLF; CodeWarrior text outputs (`.lst`, `.dbg`, `.map`, `.s19`) use CRLF.
  The repo stores LF (`.gitattributes`); byte-compared data (`packages/asm/conformance/**`, `**/test/data/**`,
  `examples/**`, CodeWarrior binaries) is `-text`.

## Distribution
- Licence Apache-2.0 (`LICENSE`, `NOTICE` with the NXP trademark disclaimer, `THIRD_PARTY_NOTICES.md`).
- Release process: `docs/RELEASING.md`; decisions and outside asks: `docs/DISTRIBUTION.md`. CI in `.github/workflows/`
  (`ci.yml`, `release.yml`, `pages.yml`); download site in `docs-site/`. Public CI and release jobs never check out
  or test with the private fixtures (public logs); the golden CI workflow lives in the private fixtures repo
  (`docs/ci/fixtures-golden.yml`). The GitHub repo is `bigPowder1/s12studio`
  (app id `io.github.bigpowder1.s12studio`); workflows and update code keep the literal `OWNER/s12studio`
  placeholder on purpose (see `docs/RELEASING.md` §1).
