# S12 Studio app (`apps/ide`, package `@s12/ide`)

Electron + electron-vite + React 19 + TypeScript. Two window kinds, like CodeWarrior 5.1:

- **IDE window** ("S12 Studio", the CodeWarrior IDE): in-window classic menu bar, toolbar, project window, editor area,
  Errors & Warnings window.
- **Debugger window** ("S12 Studio Debugger", styled as CodeWarrior's hiwave): opened by Project > Debug (F5). Menu bar
  File/View/Run/<Connection>/Component/<component>/Window/Help, toolbar, dockview component area laid out from the
  connection's `.hwl`, status bar.

Specs: `docs/research/r1/ide.md` §1-5 (IDE) and §6-7 (hiwave + `.ini`). Plan: `docs/PLAN.md` M6/M7.

## Quick start (students)

1. **Open your lab project:** copy the `blank_project` folder ME 305 gives you (course page), then File > Open... and
   pick its `.mcp`. S12 Studio does not include the course library or template; they come with your course's project
   folder.
2. F7 builds, F5 opens the debugger (building first if needed) with the ME305 Board docked on the right, F5 again
   runs.

No course project yet? Open the demo project (Help > Open Demo Project / startup dialog), or File > New Project for an
empty assembly project (without the ME 305 library). Where do I get the ME 305 library / blank project? From your
course: they are in its `blank_project` folder. A copy of that folder in `<userData>/templates/blank_project` (or
`$S12_TEMPLATES_DIR/blank_project`) is also listed by File > New Project.

## Run

```bash
npm run app            # (repo root) build + start
npm run app:dev        # (repo root) electron-vite dev server with HMR
npm run app:e2e        # (repo root) build + Playwright _electron E2E

# inside apps/ide (or npm run <x> -w @s12/ide)
npm run dev            # HMR
npm run build          # -> out/main, out/preload, out/renderer
npm run start -- --open /path/to/Lab3.mcp     # run the built app
npm run typecheck      # tsconfig.node.json (main/preload/worker/shared/e2e) + tsconfig.web.json (renderer)
npm test               # Vitest, this app only (the root `npx vitest run` runs these too)
npm run e2e            # build + Playwright; e2e:nobuild skips the build
npm run dist:dir       # build + unpacked packaged app in dist/ (dist / dist:win / dist:mac / dist:linux: installers)
```

Packaging (electron-builder, `electron-builder.config.cjs`; release process in `docs/RELEASING.md`): `npm run dist*`
builds, collects the licence texts (`scripts/collect-licenses.mjs`), then packages into `dist/` with
`--publish never`. The installers contain no course content; they carry the public demo `examples/blinky` as
`<resources>/examples/blinky` (without build outputs). CI's `release.yml` publishes. App identity and the update feed come from this `package.json`
(`s12studio.appId`, `repository`; CI overrides the repository with `GITHUB_REPOSITORY`). Updates: `src/main/updates/`
(`S12_NO_UPDATE=1` disables the check).

Command line: `s12studio [--open] <file.mcp|file.s12studio.json|file.asm ...> [--debug] [--devtools]`. Project files open
as the project; other files are sent to the editor (`files.openRequest`). `--debug` starts the debugger after opening.
Environment: `S12_USER_DATA=<dir>` (isolated userData), `S12_TEMPLATES_DIR=<dir>` (folder holding a `blank_project/`
copy for File > New Project; default `<userData>/templates`), `S12_E2E=1` (harness: no single-instance lock), `S12_FIXTURES=<dir>`
(private fixtures for tests/E2E; default `<repo>/fixtures`; absolute or relative to the repo root), `S12_NO_UPDATE=1`
(no update check). E2E only: `S12_PACKAGED_APP=<packaged executable>` runs `e2e/packaged.spec.ts` (`npm run
e2e:packaged`) against an electron-builder build; `S12_DOCS_SCREENSHOTS=<dir>` runs `e2e/docs-screenshots.spec.ts`,
which writes the README/download-site screenshots of `examples/blinky` (`docs/RELEASING.md` §4). Both specs skip
otherwise.

### WSL2 / Linux notes

- Electron needs `libasound.so.2`, missing on this WSL Ubuntu 26.04 and there is no sudo.
  `scripts/setup-linux-libs.sh` runs `apt-get download` for the missing packages and extracts them with `dpkg -x` into
  `<repo>/.local-libs/root` (gitignored). `scripts/env.mjs` prepends `.local-libs/root/usr/lib/x86_64-linux-gnu` to
  `LD_LIBRARY_PATH` for every launch (dev, start, E2E). Nothing else was missing.
- If npm skipped Electron's postinstall, `scripts/env.mjs` runs `electron/install.js` on first launch.
- Under WSL (`WSL_DISTRO_NAME` or "microsoft" in /proc/version) Electron is started with `--disable-gpu`.
- Do not write `useEffect(() => el.scrollIntoView())`: Chromium's `scrollIntoView()` now returns a Promise, which
  React takes as the cleanup function ("destroy_ is not a function"). Always use a block body for effects.

## Processes

```
renderer (sandboxed, contextIsolation)  --window.s12 (preload)-->  main  --worker_threads-->  debug engine worker
  src/renderer/{ide,debugger}            src/preload/index.ts       src/main/**                 src/worker/**
```

- **main** (`src/main`): `index.ts` (startup, CLI, IPC binding), `windows.ts` (WindowManager: two window kinds,
  event queueing until a renderer calls `app.ready()`, dialogs, security), `ipc/` (router + validators + one handler
  file per domain), `engine/` (ProjectService over `@s12/project`, BuildService (`make`...), DebugHost (worker proxy),
  SettingsStore, FileWatchers, debug-launch). `events.ts` = EventBus (services emit, windows receive).
- **debug engine worker** (`src/worker`): `DebugEngine` owns `DebugSession` + `SimTarget` + `createMc9s12xdp512()`
  (ME305 board) from `@s12/debug`/`@s12/sim`; runs the true-time simulation off the main thread. `protocol.ts` =
  messages; `debug-worker.ts` = thread entry (built to `out/main/debug-worker.js`).
- **preload** (`src/preload/index.ts`, CommonJS because sandboxed): builds `window.s12` from the method lists in
  `src/shared/api`. No Node APIs reach the renderer.
- **renderer**: two HTML entries (`src/renderer/ide/index.html`, `src/renderer/debugger/index.html`), strict CSP
  (relaxed for inline scripts only on the dev server).

Security: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, navigation/window.open blocked,
permission requests denied, IPC accepted only from our windows, every argument validated in main
(`src/main/ipc/validate.ts`) before a handler runs.

## IPC contract (`src/shared/api/*`)

One namespace per domain; every method returns a Promise; arguments/results are structured-cloneable. Channel
`s12:<domain>.<method>` (invoke); events on `s12:evt` as `(domain, event, payload)`. Errors arrive as
`Error("[code] message")`; `parseApiError(e)` gives `{ code, message }`.

| domain | file | purpose |
|---|---|---|
| `app` | `app.ts` | info (window kind), `ready()`, window control, title, quit, openExternal |
| `files` | `files.ts` | open/save dialogs, readText/writeText (EOL kept, CRLF default), stat, readDir, reveal, watch, recent; events `changed`, `openRequest` |
| `project` | `project.ts` | open/close/current/reload/newProject, file/group/link-order/target/connection/debug-flag/options/access-path/output edits (sidecar only), debuggerConfig; events `changed`, `closed`, `externalChange` |
| `build` | `build.ts` | make, bringUpToDate, compile, stop, removeObjectCode, isBuilding, lastResult; events `started`, `progress`, `message`, `finished` |
| `debug` | `debug.ts` | launch (main), session lifecycle, run control (go/halt/step/reset/restart/runTo/resetCycles/setPacing), registers, memory read/write/fill/watch, disassemble, sources/lines/symbols/resolve, breakpoints/watchpoints, command exec/execFile/answerPrompt, expressions/evaluate/globals/callStack, sciSend; events `session`, `snapshot`, `running`, `halted`, `loaded`, `output`, `clearOutput`, `breakpoints`, `watchpoints`, `expressions`, `uiCommand`, `prompt`, `sciOutput`, `engineError` |
| `board` | `board.ts` | ME305 board state, keys, press/release/tap key, motor params/load torque, analog input, pins, power cycle; event `state` |
| `layout` | `layout.ts` | read/write `.hwl`, session layout path, default layout |
| `settings` | `settings.ts` | app settings get/update (userData/settings.json), raw sidecar; event `changed` |

To add a method: add it to the interface **and** the `*_METHODS` list (a compile-time check fails otherwise), add a
handler with validators in `src/main/ipc/handlers/<domain>.ts` (debug/board methods: add validators to the
`DEBUG_ARGS`/`BOARD_ARGS` tables and implement `'debug.<name>'` in `DebugEngine.buildHandlers()`), and a mock default
in `src/renderer/common/testing/mockS12.ts` if useful. `router.missing()` must stay empty (tested).

### How renderer components get data

Never subscribe to `debug.snapshot` per component. Use `src/renderer/common/s12`:

- `useS12()` - the typed API (`await s12.debug.step('instr')`).
- `useDebugSnapshot()` - latest `DebugSnapshot` (run state, status text, cycles, bus clock, registers, watched memory,
  halt + source location). Pushed by the worker at ~30 Hz while running (settings `debugger.snapshotHz`) and
  immediately after every halt, load, reset, register/memory write and watch change.
- `usePreviousHaltSnapshot()` - snapshot of the previous halt, to paint changed values red.
- `useMemoryWatch(ranges)` - registers ranges with `debug.watchMemory`; returns the blocks from each snapshot.
- `useSession()`, `useBoardState()`, `useProject()` - cached state with an initial pull.
- `useS12Event(domain, event, cb)` - any other event (command output, breakpoints, uiCommand, build messages...).
- Tests: `createMockS12(overrides)` + `<S12Provider api={mock.api}>`; `mock.emit(domain, event, payload)`,
  `mock.calls(domain, method)`.

Dialogs: reset their fields with `useResetOnOpen(open, () => ...)` (controls.tsx), not `useEffect(..., [open, initial])`
(that paints the previous text first and resets what the user typed whenever `initial` changes, e.g. the PC while
running); `useSelectOnOpen(open)` gives the field ref whose default text is selected on open.

IDE-window cross-component commands go through `src/renderer/ide/commands.ts` (`useIdeCommand('editor.open', fn)`,
`runIdeCommand('editor.open', { path, line })`). Debugger components talk to the shell through
`src/renderer/debugger/components/contract.ts` (`useComponentHost()`, `useComponentMenu(items)`, `useUiCommands(fn)`,
drag-and-drop payloads `DND_MIME`/`setDnd`/`getDnd`).

## Directory ownership

| path | owner track | notes |
|---|---|---|
| `src/shared/api/**`, `src/shared/ipc.ts` | scaffold, then **engine** track | additive changes only; other tracks ask the engine track |
| `src/shared/theme/**` | scaffold / IDE shell | tokens mirrored in `common/theme.css` |
| `src/main/**` except `src/main/engine/**` | engine track | `ipc/handlers/*` per domain |
| `src/main/engine/**`, `src/worker/**` | engine track | services + debug engine host |
| `src/preload/**` | scaffold (frozen) | generic; needs no change for new methods |
| `src/renderer/common/**` | scaffold, then IDE shell track | shared primitives: menu bar, controls, views, format, icons, s12 hooks, theme |
| `src/renderer/ide/**` except `editor/`, `errors/` | IDE shell track | `shell/` (menus, toolbar, status), `project/` (project window), `dialogs/` (Target Settings, New Project...), `commands.ts` |
| `src/renderer/ide/editor/**`, `src/renderer/ide/errors/**` | editor track | Monaco editor windows; Errors & Warnings window |
| `src/renderer/debugger/shell/**`, `DebuggerApp.tsx`, `main.tsx` | debugger shell track | frame, menus, toolbar, status bar, dockview layout from `.hwl` |
| `src/renderer/debugger/components/{contract,registry}.ts`, `Placeholder.tsx` | debugger shell track | registry by hiwave name |
| `src/renderer/debugger/components/{source,assembly,register,procedure}/**` | components track A | |
| `src/renderer/debugger/components/{memory,data,command,terminal}/**` | components track B | |
| `src/renderer/debugger/components/{board,visualization}/**` | board track | ME305 board panel, VisualizationTool-lite |
| `e2e/**`, `scripts/**`, configs | scaffold | add new `e2e/*.spec.ts` files freely |

Tests live next to the code (`*.test.ts(x)`); files under `src/renderer/**` run in jsdom, everything else in Node.
Fixtures are private and read-only: they come from the private fixtures checkout (`<repo>/fixtures` or `$S12_FIXTURES`),
and tests copy them (`test/fixtures.ts` `copyFixture()`, E2E `copyFixture()` in `e2e/harness.ts`); fixture-dependent
tests and specs skip when the fixtures are absent. Never put fixture content (Lab3 code, the ME305 library) into
non-fixture test data or screenshots that leave this machine.

## Libraries (all installed; do not add new dependencies without the scaffold owner)

- **Monaco** 0.57 (bundled locally, no CDN; verified to build with a separate worker chunk):
  ```ts
  import * as monaco from 'monaco-editor/editor/editor.api';
  import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
  ```
  (0.57 package exports map `monaco-editor/<path>` to `esm/vs/<path>.js`; the old `monaco-editor/esm/vs/...` specifiers
  no longer resolve.) jsdom cannot run Monaco: mock it in component tests.
- **dockview-react** 8 (`DockviewReact`, `themeLight`, CSS `dockview-react/dist/styles/dockview.css`; restyled in
  `debugger/shell/dock-theme.css`).
- **@xterm/xterm** 6 + `@xterm/addon-fit` (CSS `@xterm/xterm/css/xterm.css`) for Terminal/Command if wanted.
- Tests: Vitest 2 + jsdom 26 + @testing-library/react 16 + user-event 14 + jest-dom 6; Playwright 1.64 (`_electron`).

## E2E

`e2e/harness.ts`: `launchApp({ args })` starts the built app through Playwright `_electron` with an isolated userData,
`ideWindow()` / `debuggerWindow()` find the windows by URL, `screenshot(page, name)` saves to `$S12_SCREENS_DIR`
(default `<os tmp>/s12studio-screens`), `copyFixture('Lab3')` copies a fixture to a temp dir (`$S12_E2E_TMP`).
`e2e/smoke.spec.ts`: open a Lab3 copy from the command line, project window lists `main.asm`, toolbar Debug opens the
debugger, Project.abs loads (PC = C000), Assembly Step changes PC.
`e2e/plan-flows.spec.ts`: the PLAN.md student flows end to end through menus/keys/mouse (File > Open with the native
dialog answered from main, Make vs CodeWarrior's outputs, error -> jump -> fix, hwl layout, Source-margin breakpoint,
register/memory edits, F10/F11/Shift+F11, ME305 board at true time, Command `bs`/`g`/`rd`/`db`, New Project -> spin).
`e2e/m6c-fix.spec.ts`: keys typed right after a dialog opens (Assembly/Memory Address, halted and running), Procedure
after a reset, the "rebuilt" notice after Make while debugging, File > Exit with a modified document: Cancel keeps the
debugger and its session, Don't Save quits.

```bash
npm run app:e2e                                           # all specs (builds first)
S12_SCREENS_DIR=/tmp/screens npm run e2e:nobuild -w @s12/ide -- plan-flows   # one spec, screenshots elsewhere
```
