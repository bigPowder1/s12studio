/** The assembler must never throw: any input produces messages, never an exception. */
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/index.js';

const TOKENS = [
  'LDAA', 'MOVB', 'BRSET', 'DBNE', 'TFR', 'CALL', 'DC.B', 'DS.W', 'EQU', 'SET', 'IF', 'ELSE', 'ENDIF', 'MACRO', 'ENDM',
  'MEXIT', 'SECTION', 'ORG', 'XDEF', 'XREF', 'INCLUDE', 'OFFSET', 'ALIGN', 'END', 'LIST', 'NOLIST', 'FAIL', 'BASE', 'lab',
  'lab:', 'x', '#', ',', '[', ']', '(', ')', '+', '-', '*', '/', '%', '$', '@', "'", '"', ';', ':', 'X', 'Y', 'SP', 'PC',
  'PCR', 'D', 'A', 'B', '1', '$FF', '%101', '\\1', '\\@', '\\0', '<', '>', '.B', 'HIGH(', 'PAGE(', '0FFh', '[?', '?]', '\t',
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('robustness', () => {
  it('random token soup never throws', () => {
    const r = rng(12345);
    for (let n = 0; n < 400; n++) {
      const lines: string[] = [];
      const count = 1 + Math.floor(r() * 12);
      for (let i = 0; i < count; i++) {
        const k = Math.floor(r() * 7);
        const parts: string[] = [];
        for (let j = 0; j < k; j++) parts.push(TOKENS[Math.floor(r() * TOKENS.length)]);
        lines.push((r() < 0.5 ? ' ' : '') + parts.join(r() < 0.5 ? ' ' : ''));
      }
      const src = lines.join('\n');
      for (const cpu of ['CPU12', 'HCS12X']) {
        expect(() => assemble({ sourcePath: 'f.asm', readFile: (p) => (p === 'f.asm' ? src : undefined), options: `-Cpu${cpu} -L` }), src).not.toThrow();
      }
    }
  });
});
