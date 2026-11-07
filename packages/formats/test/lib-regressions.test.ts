// Regression tests for the adversarial review of @s12/formats (lib/).
import { describe, it, expect } from 'vitest';
import { readFixture, describeFx, hasFixtures } from './fixtures';
import { readHiwareLib, writeHiwareLib, syncLibMembers, writeElf, readElf, bytesEqual, findLibMember } from '../src/index';

const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const LIB = hasFixtures ? u8(readFixture('Lab3', 'Sources', 'Libraries', 'ME305LibV4.0.lib')) : new Uint8Array(0);

describeFx('writeHiwareLib: member.bytes is authoritative', () => {
  it('edits to member.elf are ignored until synced, then persisted', () => {
    const lib = readHiwareLib(LIB, { copy: true });
    const m = lib.members[0];
    const name = m.name.replace('.asm.o', ''); // each member's code section is named after it
    const elf = m.elf!;
    elf.sections.forEach((s, i) => {
      if (i > 0 && s.name === name) s.data = s.data.slice();
    });
    const code = elf.sections.find((s) => s.name === name)!;
    code.data[0] ^= 0xff;
    expect(bytesEqual(writeHiwareLib(lib), LIB)).toBe(true); // elf edit not visible yet
    syncLibMembers(lib);
    const out = writeHiwareLib(lib);
    expect(bytesEqual(out, LIB)).toBe(false);
    const back = findLibMember(readHiwareLib(out), m.name)!;
    expect(back.elf!.sections.find((s) => s.name === name)!.data[0]).toBe(code.data[0]);
  });
  it('syncLibMembers on an unmodified library is a no-op (byte-identical)', () => {
    const lib = syncLibMembers(readHiwareLib(LIB, { copy: true }));
    expect(bytesEqual(writeHiwareLib(lib), LIB)).toBe(true);
    for (const m of lib.members) expect(bytesEqual(m.bytes, writeElf(readElf(m.bytes)))).toBe(true);
  });
});
