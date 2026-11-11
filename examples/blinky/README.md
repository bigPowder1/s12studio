# blinky — S12 Studio example (Apache-2.0)

A standalone S12 Studio project (`blinky.s12studio.json`, no CodeWarrior `.mcp`) for the MC9S12XDP512 on the ME3305
benchtop board. All code is our own; it does not use the course library.

- PLL: 16 MHz crystal -> 10 MHz bus.
- LEDs PP4..PP7: PP4+PP6 and PP5+PP7 alternate every RATE x 100 ms (ECT output compare 0, 10 ms tick).
- LCD (40x2 HD44780 on PORTB, RS/RW/E = PM4/PM5/PM6): `S12 Studio blinky demo` / `Blink: 500 ms per step  (keys 1-9)`.
- Keypad (74C923 encoder: code on PK0..PK4, DA on PJ7): keys 1..9 set RATE; the digit on line 2 follows.

Open it with File > Open (`blinky.s12studio.json`), F7 to Make, F5 to Debug (the ME3305 Board panel opens on the right by
itself), then F5 to run. The installers carry this demo too: startup dialog > Load Example Project or Help > Open
Demo Project copies it to `Documents/S12 Studio/Demo (blinky)` and opens that copy.
Tests: `packages/project/test/example-blinky.test.ts` (Make + full MCU model) and `apps/ide/e2e/public-demo.spec.ts`
(the IDE flow).

Make writes `bin/` and `blinky_Data/` next to the project; they are build outputs (ignored by `examples/.gitignore`).

Note for contributors: `main.asm` is also the public sample text for the editor tests
(`apps/ide/src/renderer/common/monaco/hc12.test.ts`, `asmText.test.ts`, which look up some of its lines and labels) and
its behaviour is asserted by the tests above (LED period, LCD text, keys). Run `npx vitest run` after editing it.
