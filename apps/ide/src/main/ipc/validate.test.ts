import { describe, expect, it } from 'vitest';
import { v, validateArgs, ValidationError } from './validate';

describe('validators', () => {
  it('accepts and rejects primitives', () => {
    expect(v.string()('a', 'x')).toBe('a');
    expect(() => v.string()(1, 'x')).toThrow(ValidationError);
    expect(() => v.string({ pattern: /^https?:/ })('file:///etc', 'u')).toThrow(/matching/);
    expect(v.address()(0xc000, 'a')).toBe(0xc000);
    expect(() => v.address()(-1, 'a')).toThrow(/>= 0/);
    expect(() => v.int()(1.5, 'n')).toThrow(/integer/);
    expect(() => v.path()('a\0b', 'p')).toThrow(/path/);
    expect(v.literal('a', 'b')('b', 'l')).toBe('b');
    expect(() => v.literal('a', 'b')('c', 'l')).toThrow(/one of a\|b/);
  });
  it('objects reject unknown keys and drop undefined optionals', () => {
    const o = v.object({ a: v.int(), b: v.optional(v.string()) });
    expect(o({ a: 1 }, 'r')).toEqual({ a: 1 });
    expect(() => o({ a: 1, c: 2 }, 'r')).toThrow(/r\.c: unexpected field/);
    expect(() => o({ a: 'x' }, 'r')).toThrow(/r\.a: expected integer|r\.a: expected finite number/);
    expect(() => o([], 'r')).toThrow(/object/);
  });
  it('bytes accepts Uint8Array or number[] and copies', () => {
    const src = new Uint8Array([1, 2]);
    const out = v.bytes()(src, 'b');
    expect(out).toEqual(new Uint8Array([1, 2]));
    expect(out).not.toBe(src);
    expect(v.bytes()([255, 0], 'b')).toEqual(new Uint8Array([255, 0]));
    expect(() => v.bytes()([256], 'b')).toThrow(/<= 255/);
  });
  it('validateArgs rejects extra args, allows missing optional ones', () => {
    expect(validateArgs([v.int(), v.optional(v.boolean())], [1], 'm')).toEqual([1, undefined]);
    expect(() => validateArgs([v.int()], [1, 2], 'm')).toThrow(/at most 1/);
    expect(() => validateArgs([v.int()], [], 'm')).toThrow(/m#0/);
  });
});
