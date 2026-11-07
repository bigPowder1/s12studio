# Third-party notices

S12 Studio's own code is licensed under the Apache License 2.0 (see `LICENSE` and `NOTICE`). This file lists
material in this repository, or bundled into the installers, that comes from somewhere else.

S12 Studio contains no ME 305 course material; the course's project files and library belong to their authors.
Neither this repository nor the installers include them: students open the `blank_project` folder their course gives
them. The demo project shipped in the installers (`examples/blinky`) is S12 Studio's own code (Apache-2.0).

## In the source repository

### libasm test vectors (Apache-2.0)

- **Files:** `packages/asm/test/data/libasm-asm-vectors.json` (assembler encodings) and the disassembler vectors in
  `packages/isa/test/libasm-vectors.test.ts`.
- **Source:** [libasm](https://github.com/tgtakaoka/libasm) by Tadashi G. Takaoka:
  `test/test_asm_mc68hc12.cpp` and `test/test_dis_mc68hc12.cpp`. The CPU12/S12X opcode table in
  `packages/isa/src/table.ts` was cross-checked against libasm's `table_mc68hc12.cpp`; no code was copied.
- **License:** Apache License 2.0. Copyright Tadashi G. Takaoka.
- **Changes:** the instruction/byte pairs were extracted to JSON, tagged with the CPU variants they apply to, and the
  operand syntax was translated to CodeWarrior's spelling (`,PC` to `,PCR`). Test-only; not shipped in the app.

```
Copyright Tadashi G. Takaoka

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

### MC9S12XDP512 register symbol table (provenance note)

- **File:** `packages/devices/test/data/cw-mc9s12xdp512.json` (test-only; not shipped in the app).
- **What it is:** register names, addresses, sizes and bit-field layouts read with an ELF/DWARF dumper from a
  CodeWarrior-compiled `mc9s12xdp512.c.o` object found in a public GitHub repository
  (`TheTrueTrooper/C-Libs-For-CNT9S12XDP512Mirco-Using-MC9S12XDP512-Chip`, no license stated). Only the symbol
  facts (names, addresses, widths) were kept; no code, comments or header text. These facts are the chip's
  documented register map (MC9S12XDP512 data sheet) and are used only to check that our generated register table
  agrees with CodeWarrior's naming.

### Compatibility message texts

`packages/asm/src/messages.ts` and `packages/link/src/messages.ts` reproduce the short one-line diagnostic texts
(e.g. `A1104: Undeclared user defined symbol`) that CodeWarrior prints, so that students' build output and course
handouts match. They are used for interoperability and are not part of any NXP code.

### npm dependencies

The app bundles open-source npm packages: Electron (with Chromium and Node.js) as the runtime, and React, Monaco
Editor, xterm.js, electron-updater and their dependencies, under MIT and other permissive licenses. The
exact packages and versions are in `package-lock.json`.

What the installers carry: Electron's and Chromium's license files (`LICENSE.electron.txt`,
`LICENSES.chromium.html`) next to the app, and a `licenses/` folder in the app's resources (Windows: next to
`S12Studio.exe` under `resources\licenses`; macOS: `S12 Studio.app/Contents/Resources/licenses`; Linux AppImage:
`resources/licenses` inside the image) with S12 Studio's `LICENSE.txt` and `NOTICE.txt`, this file, and
`THIRD_PARTY_LICENSES.txt`: the license text of every npm package the build bundles into the app (React, Monaco
Editor, xterm.js, ...) and of the runtime dependencies shipped in `app.asar` (electron-updater and its dependencies).
That file is generated at build time by `apps/ide/scripts/collect-licenses.mjs` from the build's sourcemaps, so it
lists exactly what is bundled.
