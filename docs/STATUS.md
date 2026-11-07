# Status (2026-11-06)

## Done
- **M0** scaffold, fixtures (`fixtures/Lab3`, `fixtures/blank_project`; now a private repo, see below), research notes
  (`docs/research/`), plan (`docs/PLAN.md`).
- **M1** `@s12/formats` (ELF/lib/DWARF/looc/.mcp/INI/hwl/cmd/xpr/PRM/BBL/S-record), `@s12/isa` (CPU12+S12X opcode
  table, postbytes, cycles, disassembler), `@s12/devices` (MC9S12XDP512 registers/vectors/MMC, .inc generator, ME305 profile).
- **M2 (assembler)** `@s12/asm`: built + 2 review/fix rounds. Golden: Lab3 & blank_project `main.lst`, `main.dbg`,
  `main.asm.o` byte-identical.
- **M3 (linker/burner)** `@s12/link`: built + 2 review/fix rounds. Golden: Project.abs/.map/.s19/.glo.
- **M4 (simulator)** `@s12/sim`: S12X CPU core, MMC, bus; peripherals CRG, PIM/KWU, MEBI/IRQ, ECT (equality compare,
  TFFCA, the C11 compare race reproduced), PIT, SPI0-2, SCI0-5, IIC, ATD0/1, PWM, flash/EEPROM NVM, misc stubs; ME305
  board (LCD, keypad, LS7366R, MCP4922, motor, LEDs). `createMc9s12xdp512()` in `mcu.ts` wires it all.
- **M5 (debug engine)** `@s12/debug`: Target, SimTarget, symbols/lines, stepping, breakpoints/watchpoints, hiwave
  command language, .cmd hooks, .bpt/.xpr; `createMcuSimTarget()` in `sim-factory.ts`.
- **Project build** `@s12/project`: .mcp + sidecar model, Make reproduces golden outputs (never writes the .mcp).
- **M6 IDE UI + M7 debugger UI** (`apps/ide`, Electron + React, `S12 Studio`): built by 7 tracks, reviewed, integrated,
  and a final fidelity pass. IDE window: CodeWarrior 5.1 menu bar, project window (Files / Link Order / Targets, touch
  marks and Code/Data from CodeWarrior's own outputs on open), Monaco editor, Errors & Warnings, Target Settings
  (Alt+F7), New Project wizard (Device and Connection / Project Parameters / Add Additional Files), Make (F7),
  Debug (F5). Debugger window (hiwave): `.ini` MainFrame placement (FCS opens maximized), toolbar from `TOOLBAR=`,
  MDI layout from the `.hwl`, Source / Assembly / Register / Procedure / Memory / Data / Command / Terminal /
  VisualizationTool / ME305 Board components, Load Executable File and Set Connection dialogs, Controlpoints, the
  simulation in a worker thread at true time (measured 1.00x real time running Lab3 in its keypad-polling loop; ~17x
  with max pacing there). E2E: Playwright `_electron` specs, public ones in `apps/ide/e2e/` and the Lab3 ones in the
  private `fixtures/e2e/` (incl. `final.spec.ts`: Lab3 -> debugger -> ME305 board prompt, and `plan-flows.spec.ts`:
  the 10 PLAN.md student flows through the UI -
  File > Open, Make byte-compared with CodeWarrior's outputs, error/jump/fix, Source-margin breakpoint, register and
  memory edits, F10/F11/Shift+F11, the board at true time with mouse keypad input, Command `bs`/`g`/`rd`/`db`, New
  Project -> `spin`); `m6c-fix.spec.ts`: the m6c verify findings.
- **m6c fixes** (after the verify walk): IDE File > Exit asks "save changes?" first and main closes the IDE window
  before the debugger, so Cancel keeps the debugger window and its session (before, `app.quit()` closed the debugger
  first); text-entry dialogs reset their default during the opening render and select it (`useResetOnOpen` /
  `useSelectOnOpen`), so keys typed right after opening are kept and a changing default (PC while running) no longer
  overwrites typing; Make while debugging prints "Project.abs was rebuilt..." in the Command window and status bar
  (`debug.applicationRebuilt` now has a listener); the Procedure window shows only the current frame after a reset /
  load until the program runs (stale return addresses on the kept stack); plan-flows asserts tightened (`rd`, Memory
  window red after a write, STOPPED after load, `bs main` on main's line).

**Lab3 end-to-end in sim (no fakes) passes** (splash, prompts, keypad entry, LED pattern, error message; asserted by
the private tests); blank_project reaches `spin`. Current test counts: see "Verified locally" under Release 1.

## Release 1 ("Simulator edition"): code complete, waiting on the owner
Plan and decisions: `docs/DISTRIBUTION.md`; release procedure: `docs/RELEASING.md`.

**Decision of 2026-11-06: clone + board only, no course content.** S12 Studio ships only the CodeWarrior-style
IDE/debugger, the simulated ME 305 board and our own demo project (`examples/blinky`). It bundles no ME 305 library
and no instructor template, in the repository or in any installer. Students open the `blank_project` folder their
course gives them (File > Open its `.mcp`). No redistribution permission is needed; a courtesy note to the
instructors (draft in `docs/DISTRIBUTION.md`) replaces the permission email.

What changed for it (2026-11-06):
- **Bundling removed:** `prepare-course-content.mjs`, `resources/templates/`, the `course-content` script, the
  `S12_BUNDLE_COURSE` / `S12_PACKAGED_COURSE` switches, `release.yml`'s deploy key, private checkout and bundle
  branching, and `@s12/project`'s generated course stationery (`newCourseProject` and friends). New Project's ME 305
  entry uses a course `blank_project` (with its `.mcp`) only if one is found in `S12_TEMPLATES_DIR`,
  `<userData>/templates` or (dev only) the fixtures; otherwise it is marked "not found" and points to File > Open.
- **Demo in the installers:** `<resources>/examples/blinky` (no build outputs). Startup dialog "Load Example
  Project" (now enabled) and Help > Open Demo Project copy it once to `Documents/S12 Studio/Demo (blinky)` and open
  that copy. The startup dialog also has an "Open Project..." button.
- **Student flow fixes:** Project > Debug (F5) runs Make (assemble + link) first and does not launch on errors (it
  used to assemble only and debug a stale `bin/Project.abs`); a project path with characters above U+00FF (en dash,
  Hangul, Vietnamese) builds (they are recorded as `?` in the object/ELF/S0/listing paths instead of throwing); a
  missing connection `.ini` falls back to the project's `Full_Chip_Simulation.ini` with a note; the P&E connection
  message is a once-per-project note, not a warning; the ME305 Board panel docks on the right (40%) when a session
  starts with a layout that has none; a failed double-click/command-line open shows a message box; a project opened
  from inside a zip (Windows' `Temp1_*.zip`, 7-Zip, WinRAR temp folders) is refused with "extract the zip first".
- **Scrub:** tests, notes and comments that spelled out the graded Lab3 solution or the instructors' library moved to
  the private fixtures repo: Vitest specs in `fixtures/tests/` (included by `vitest.config.ts` when the fixtures are
  found), Playwright specs in `fixtures/e2e/` (the `private` project of `apps/ide/e2e/playwright.config.ts`; needs
  the checkout at `<repo>/fixtures`), full research notes in `fixtures/research/` (the public `docs/research/r2/`
  and `docs/PLAN.md` keep pointers). Public tests use `examples/`, synthetic code and values read from the fixtures
  at run time. The board caption and profile name no longer echo the library banner.
- **Docs:** README, `apps/ide/README.md`, `docs-site/` (new step 1 "open your course's blank_project", "No course
  project yet?", FAQ), NOTICE / `THIRD_PARTY_NOTICES.md` ("S12 Studio contains no ME 305 course material"),
  `docs/RELEASING.md` (no deploy key, no bundling section; golden CI is §3), `docs/DISTRIBUTION.md` (decision row,
  courtesy note), `CONTRIBUTING.md` and `CLAUDE.md` (private tests and notes locations).

Earlier (2026-11-05, still valid):
- **Repo/docs/CI:** Apache-2.0 `LICENSE`, `NOTICE` (NXP trademark disclaimer), `THIRD_PARTY_NOTICES.md`,
  user-facing `README.md`, `CONTRIBUTING.md`, `.gitattributes` (LF; CRLF/binary goldens `-text`), `.gitignore`
  (`/fixtures/`, installer output). GitHub Actions: `ci.yml` (vitest + typechecks on ubuntu/windows/macos; E2E on
  ubuntu (Xvfb) + windows that must pass at least one test, i.e. the public demo; then `npm run dist:dir` and the
  packaged-app smoke test `e2e/packaged.spec.ts` on the unpacked build), `release.yml` (tag `v*` -> draft GitHub
  Release with Win/mac/Linux installers; tests without fixtures; never checks out the private repo; licence texts via
  `npm run licenses`; write token and signing secrets only on the packaging step; installers kept as workflow
  artifacts), `docs/ci/fixtures-golden.yml` (golden CI, installed in the PRIVATE fixtures repo so fixture diffs never
  reach public logs), `pages.yml` (`docs-site/` download page + install guide).
- **Private fixtures:** `fixtures/` becomes the private repo `s12studio-fixtures` (`Lab3/`, `blank_project/`,
  `research/`, `tests/`, `e2e/`; checkout at `fixtures/`, or `S12_FIXTURES=<dir>`, absolute or relative to the repo
  root); one locator (`packages/formats/test/fixtures-locate.ts`); fixture-dependent tests skip or are not collected
  when absent.
- **Packaging (`apps/ide`, electron-builder 26):** appId `io.github.bigpowder1.s12studio`, icons, NSIS (Win x64,
  per-user, unsigned), dmg+zip (mac arm64+x64, ad-hoc `identity: "-"`), AppImage (Linux x64); env-driven Azure
  Artifact Signing / Developer ID + notarization blocks ready. `npm run dist*` = build -> `licenses`
  (`<resources>/licenses`: LICENSE, NOTICE, THIRD_PARTY_NOTICES, npm licence texts) -> electron-builder (adds
  `<resources>/examples/blinky`). Updates: electron-updater on Windows/Linux, "new version - download" notice on
  macOS (repository `bigPowder1/s12studio`; off in builds still carrying the `OWNER` placeholder).
- **Screenshots:** `docs-site/img/{ide,debugger}.png` (also in `README.md`) from `examples/blinky` only, regenerated
  by `apps/ide/e2e/docs-screenshots.spec.ts` (`S12_DOCS_SCREENSHOTS=<dir>`); both (and the unreferenced
  `new-project.png`) were regenerated on 2026-11-06 with the "ME305 Board" caption and the current stationery labels.
- **Copy-out recipe** (`docs/RELEASING.md` §2) for the public repo's first commit (never reuses this index or
  identity).

**Verified locally (2026-11-06, WSL2):**
- root `npx vitest run` (fixtures present): 3251 passed / 3 skipped (176 files + 1 skipped);
  `S12_FIXTURES=/nonexistent npx vitest run`: 2721 passed / 91 skipped / 0 failed (144 files + 10 skipped; the
  private tests are not collected); `npx tsc -p tsconfig.json --noEmit`, `npx tsc -p fixtures/tests/tsconfig.json
  --noEmit`, `npx tsc -p fixtures/e2e/tsconfig.json --noEmit` and `npm run typecheck -w @s12/ide` clean.
- `npm run e2e -w @s12/ide`: 16 passed / 4 skipped (20 tests: 13 public, 7 private; the packaged and
  docs-screenshot specs are env-gated); without fixtures (`S12_FIXTURES=/nonexistent`): 2 passed / 11 skipped (the
  public demo; the `private` project is not loaded).
- `npm run dist:dir -w @s12/ide` -> `dist/linux-unpacked/resources/` = `app.asar`, `app-update.yml`, `icon.png`,
  `licenses/`, `examples/blinky/` (no `bin/`, no `*_Data/`), no `templates/`; `app.asar` scanned: no Lab3 names, no
  personal names/paths. `e2e:packaged` 2/2 on it.
- End to end in the built app (temporary spec, deleted): a copy of `blank_project` under `Lab 4 – 학생/` builds with
  0 errors; editing `main.asm` (`ldx #$1234` before `spin`) and pressing F5 without F7 relinks (`spin` moves by 3)
  and the run halts in the new `spin` with X = 1234.
- Copy-out dry run (`docs/RELEASING.md` §2 file list, no `git init`): 583 files, 0 under `fixtures/`, 0
  `.lib/.mcp/.abs/.s19/.o`, no `blank_project/` or `Lab3/` directory; grep for the Lab3 label/string names and the
  personal-name/path patterns: no hits.
- **Not verified:** any Windows or macOS build (no Wine/Mac here; first real test is CI + a Windows 11 laptop and an
  Apple Silicon Mac, owner step 8); the workflows have never run on GitHub (YAML parses; not linted with
  actionlint); the Documents copy of the demo and the zip refusal on a real Windows PC.

### What remains for the owner (in order)
1. ~~Decisions~~ done 2026-11-06 (below); `OWNER` set to `bigPowder1` with the named-file sed of
   `docs/RELEASING.md` §1; app id switched.
2. Install `gh` and `gh auth login` in WSL.
3. Delete old E2E temp copies on this machine (`rm -rf /tmp/s12e2e-*`; many are Lab3 copies).
4. Create the private `s12studio-fixtures` repo from a copy of today's `fixtures/` (`Lab3/`, `blank_project/`,
   `research/`, `tests/`, `e2e/`), then the public `s12studio` repo with the copy-out recipe of `docs/RELEASING.md`
   §2 (new directory, `git init`, noreply identity; check 0 files under `fixtures/`, 0 binaries, private-pattern grep
   empty), commit, create the empty GitHub repo, push.
5. Clone the fixtures into `fixtures/` of the new checkout; run `npx vitest run` and
   `S12_FIXTURES=/nonexistent npx vitest run` there (and `npm run e2e -w @s12/ide` once: the `private` project runs).
6. Copy `docs/ci/fixtures-golden.yml` into the private repo (§3); Pages source = GitHub Actions (§4). Check that
   `ci.yml` and Golden pass. (No deploy key or secret is needed any more.)
7. Send the instructors the courtesy note (`docs/DISTRIBUTION.md`; no permission is needed). If they object to
   naming ME 305, drop the course name from the site and README before the release.
8. Tag `v0.1.0`; review the draft release (all installers + `latest*.yml`); install-test on Windows 11 and an Apple
   Silicon Mac (install guide, open a course `blank_project`, the demo, F7, F5, board); publish.

### Owner decisions (2026-11-06)
- **Course content:** none shipped (above). Students open their course's `blank_project`.
- **GitHub owner** `bigPowder1` (repo `bigPowder1/s12studio`, site `https://bigpowder1.github.io/s12studio/`).
- **Debugger window title** `S12 Studio Debugger  <ini path>`; About boxes say "compatible with CodeWarrior ...
  projects" plus the non-affiliation notice.
- **App id** `io.github.bigpowder1.s12studio` (lower case, the reverse of the Pages host name; fixed after v0.1.0).
- **Library research notes** private: `me305-board.md` and the full `elf-lib-formats.md` live in
  `s12studio-fixtures/research/`; code cites them as "private me305-board.md §n". The public
  `docs/research/r2/elf-lib-formats.md` §1 keeps only the generic `.lib` container format.
- Unchanged: product name "S12 Studio" (disclaimers in place); copyright holder "S12 Studio contributors";
  `docs/DISTRIBUTION.md` (decisions, IP-policy note, courtesy note draft) stays public.
- Optional, not done: New Project dialog title copies CodeWarrior's wizard title; a neutral `.lst` header setting.

### Open (code)
- Windows installer opt-out for the `.mcp` association (`build/installer.nsh`; needs a Windows build to test).
- The E2E harness deletes its temp copies (fixtures, examples, New Project dirs) when the worker exits; copies from
  earlier runs (`/tmp/s12e2e-*`) are still on this machine (owner step 3).
- Pressing F5 while a debug session is open relinks first, so the "application was rebuilt" notice appears just
  before the new session replaces the old one (harmless, redundant).
- The P&E connection note is tracked per debugger worker: it shows again after a worker crash and restart.
- Characters above U+00FF in paths are recorded as `?` (UNCERTAIN: CodeWarrior on a Windows-1252 PC writes 0x96 for
  an en dash and `?` for Hangul; paths are exempt from byte-identity).
- The 7-Zip / WinRAR temp-folder names used by the zip check come from observed behaviour (UNCERTAIN).

## How to run (owner)
```bash
npm install                                    # once (repo root)
npm run build -w @s12/ide                      # build the app (apps/ide/out)
cp -r fixtures/Lab3 ~/Lab3                     # never open fixtures/ directly: Make writes next to the .mcp
npm run start -w @s12/ide -- --open ~/Lab3/Lab3.mcp
npm run app                                    # build + start with the Startup dialog
npm run app:e2e                                # build + Playwright E2E
S12_FIXTURES=/nonexistent npx vitest run       # what a public clone runs (golden tests skipped)
```
In the IDE: F7 Make, F5 Debug (Makes first, then opens the hiwave-style window; a P&E connection runs on Full Chip
Simulation until M8, with a note), then F5 Start / F6 Halt / F11 step. The ME305 board panel docks on the right when
the session starts (Component > Open... > ME305 Board reopens it). WSL notes (missing libasound, `--disable-gpu`) are in
`apps/ide/README.md`.

## Known gaps
- UI (M6/M7) deliberate deviations / not done: editor documents are tabs and Errors & Warnings is docked (CodeWarrior
  uses MDI child windows; Window > Cascade/Tile act on the editor only); hiwave `ver`/`help`/`rd`/`T`/`P`/`e PC` output
  formats unverified (need captures from a lab PC); status-bar clock/derivative panes are not clickable (Clock
  Frequency / Set Derivative dialogs not implemented); hiwave File > Configuration..., View > Customize, Help Topics,
  CodeWarrior workspaces / code completion / compare files are present but disabled; renaming a build target is not
  supported; no help system (F1 shows the keyboard shortcuts). Naming: the IDE is "S12 Studio", the debugger keeps
  the descriptive hiwave title "True-Time Simulator & Real-Time Debugger"; About boxes state non-affiliation.
  UNCERTAIN (need a lab PC): hiwave's own reaction to a Make while it is open (S12 Studio prints a notice and reloads on
  Project > Debug), and whether its Procedure window shows leftover stack frames right after a reset (we show none).
- Speed: ~2x real time overall, but timer-flag polling loops run ~0.7x real time. ECT read path / WASM later.
- WAI/STOP state not visible to peripherals (RTIWAI, COPWAI, TSWAI, PITSWAI, ATD/PWM wait mode not modelled).
- Debug session: `.cmd` `wait` should call NVM `finishCommands()`; DBG comparators not mapped to breakpoints.
- `@s12/devices` table still has PERS/PERJ reset = 0 (sim overrides to $FF/$F7 per the guide).
- Keypad DA polarity, 16 MHz oscillator, ECT DLYCT with PRNT=1: UNCERTAIN.

## Next
1. M8 hardware (hiwave bridge mode first, then P&E GDI sidecar, USBDM).
2. Finish Release 1 (`docs/DISTRIBUTION.md`): first tagged beta, install QA on Windows 11 and an Apple Silicon Mac.
3. Release 2: real board on Windows via the CodeWarrior 5.2 SE hiwave bridge.
4. UI follow-ups: MDI editor windows, verified hiwave command output formats, Clock/Derivative dialogs.

## Asks for the owner (from plan; distribution asks are in `docs/DISTRIBUTION.md`)
`mc9s12xdp512.inc` from a lab PC, more `.mcp` samples, lab screenshots, `packages/asm/conformance/allmodes.asm`
assembled on a lab PC (listing), board oscillator/keypad details (does the keypad interrupt fire on press or release?).
