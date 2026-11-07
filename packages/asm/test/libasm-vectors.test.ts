/**
 * Hand-verified encodings from libasm (Tadashi Takaoka, Apache-2.0), test/test_asm_mc68hc12.cpp, extracted to
 * test/data/libasm-asm-vectors.json with the CPUs each vector applies to (68HC12 → -CpuCPU12, 68HCS12 →
 * -CpuHCS12, 68HCS12X → -CpuHCS12X). Vectors are assembled at their address in an ORG section.
 *
 * Syntax translation: libasm writes PC-relative operands as `<absolute target>,PC`; CodeWarrior spells that
 * `<target>,PCR` (`n,PC` is a literal offset in CW), so `,PC` after an expression becomes `,PCR`.
 * Excluded: test_mmc (libasm's own linear-address / DIRECT / LOW16 extensions, not CodeWarrior syntax) and the
 * "smart-branch" relaxation section (CodeWarrior never relaxes branches).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assemble } from '../src/index.js';

interface Vec {
  fn: string;
  cpus: Array<'CPU12' | 'HCS12' | 'HCS12X'>;
  addr: number;
  text: string;
  bytes: number[];
}

const V: Vec[] = JSON.parse(readFileSync(fileURLToPath(new URL('./data/libasm-asm-vectors.json', import.meta.url)), 'utf8'));

export function cwText(t: string): string {
  return t.replace(/,\s*PC\b(?!R)/g, ',PCR').replace(/\b([ABD]),PCR/g, '$1,PC');
}

function asmAt(cpu: string, addr: number, text: string) {
  const src = `        ORG $${addr.toString(16)}\n        ${text}\n`;
  const r = assemble({ sourcePath: 'v.asm', readFile: () => src, options: `-Cpu${cpu}` });
  const sec = r.object?.sections.find((s) => s.name === '_ORG00001');
  return { r, bytes: sec ? [...sec.data] : [] };
}

const cases = V.filter((v) => v.fn !== 'test_mmc').flatMap((v) => v.cpus.map((cpu) => ({ ...v, cpu })));

describe('libasm assembler vectors', () => {
  it('has a substantial vector set', () => {
    expect(cases.length).toBeGreaterThan(2000);
  });
  for (const cpu of ['CPU12', 'HCS12', 'HCS12X'] as const) {
    it(`all vectors encode identically (-Cpu${cpu})`, () => {
      const failures: string[] = [];
      for (const v of cases.filter((c) => c.cpu === cpu)) {
        const { r, bytes } = asmAt(cpu, v.addr, cwText(v.text));
        if (!r.ok || bytes.join() !== v.bytes.join()) {
          failures.push(`${v.text} @${v.addr.toString(16)}: ${bytes.map((b) => b.toString(16)).join(' ')} ${r.messages.map((m) => m.code).join(',')}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
