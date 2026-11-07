/**
 * Minimal runtime validators for IPC arguments (main never trusts the renderer). Each validator returns the value
 * (possibly normalised) or throws ValidationError with a JSON-path-like location.
 */
import { ApiError } from '../../shared/api/common';

export class ValidationError extends ApiError {
  constructor(message: string) {
    super('invalid-argument', message);
  }
}

export type Validator<T> = (value: unknown, path: string) => T;

const fail = (path: string, what: string, value: unknown): never => {
  const shown = typeof value === 'string' ? JSON.stringify(value.length > 40 ? value.slice(0, 40) + '...' : value) : Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  throw new ValidationError(`${path}: expected ${what}, got ${shown}`);
};

export interface StringOpts {
  min?: number;
  max?: number;
  pattern?: RegExp;
}

export interface NumberOpts {
  min?: number;
  max?: number;
  integer?: boolean;
}

export const v = {
  any: ((x: unknown) => x) as Validator<unknown>,

  string(opts: StringOpts = {}): Validator<string> {
    return (x, p) => {
      if (typeof x !== 'string') return fail(p, 'string', x);
      if (opts.min !== undefined && x.length < opts.min) return fail(p, `string of length >= ${opts.min}`, x);
      if (x.length > (opts.max ?? 1 << 24)) return fail(p, `string of length <= ${opts.max ?? 1 << 24}`, x);
      if (opts.pattern && !opts.pattern.test(x)) return fail(p, `string matching ${opts.pattern}`, x);
      return x;
    };
  },

  /** Non-empty path string without NUL bytes (absolute or relative; services resolve it). */
  path(): Validator<string> {
    return (x, p) => {
      if (typeof x !== 'string' || x.length === 0 || x.length > 4096 || x.includes('\0')) return fail(p, 'path string', x);
      return x;
    };
  },

  number(opts: NumberOpts = {}): Validator<number> {
    return (x, p) => {
      if (typeof x !== 'number' || !Number.isFinite(x)) return fail(p, 'finite number', x);
      if (opts.integer && !Number.isInteger(x)) return fail(p, 'integer', x);
      if (opts.min !== undefined && x < opts.min) return fail(p, `number >= ${opts.min}`, x);
      if (opts.max !== undefined && x > opts.max) return fail(p, `number <= ${opts.max}`, x);
      return x;
    };
  },

  int(min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): Validator<number> {
    return v.number({ integer: true, min, max });
  },

  /** 0..$FFFFFF (local, logical $PPAAAA or 23-bit global addresses). */
  address(): Validator<number> {
    return v.int(0, 0xffffff);
  },

  byte(): Validator<number> {
    return v.int(0, 0xff);
  },

  boolean(): Validator<boolean> {
    return (x, p) => (typeof x === 'boolean' ? x : fail(p, 'boolean', x));
  },

  literal<T extends string | number>(...values: T[]): Validator<T> {
    return (x, p) => (values.includes(x as T) ? (x as T) : fail(p, `one of ${values.join('|')}`, x));
  },

  optional<T>(inner: Validator<T>): Validator<T | undefined> {
    return (x, p) => (x === undefined ? undefined : inner(x, p));
  },

  nullable<T>(inner: Validator<T>): Validator<T | null> {
    return (x, p) => (x === null ? null : inner(x, p));
  },

  array<T>(inner: Validator<T>, maxLength = 1 << 20): Validator<T[]> {
    return (x, p) => {
      if (!Array.isArray(x)) return fail(p, 'array', x);
      if (x.length > maxLength) return fail(p, `array of length <= ${maxLength}`, x);
      return x.map((e, i) => inner(e, `${p}[${i}]`));
    };
  },

  /** Uint8Array or number[] of bytes, returned as a fresh Uint8Array. */
  bytes(maxLength = 1 << 24): Validator<Uint8Array> {
    return (x, p) => {
      if (x instanceof Uint8Array) {
        if (x.length > maxLength) return fail(p, `at most ${maxLength} bytes`, x);
        return new Uint8Array(x);
      }
      const arr = v.array(v.byte(), maxLength)(x, p);
      return Uint8Array.from(arr);
    };
  },

  /** Plain object with the given fields; unknown keys are rejected unless `allowExtra`. */
  object<S extends Record<string, Validator<unknown>>>(shape: S, opts: { allowExtra?: boolean } = {}): Validator<{ [K in keyof S]: ReturnType<S[K]> }> {
    return (x, p) => {
      if (typeof x !== 'object' || x === null || Array.isArray(x) || x instanceof Uint8Array) return fail(p, 'object', x);
      const src = x as Record<string, unknown>;
      if (!opts.allowExtra) for (const k of Object.keys(src)) if (!(k in shape)) throw new ValidationError(`${p}.${k}: unexpected field`);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(shape)) {
        const r = val(src[k], `${p}.${k}`);
        if (r !== undefined) out[k] = r;
      }
      return out as { [K in keyof S]: ReturnType<S[K]> };
    };
  },

  /** Record<string, T> with at most `maxKeys` keys. */
  record<T>(inner: Validator<T>, maxKeys = 4096): Validator<Record<string, T>> {
    return (x, p) => {
      if (typeof x !== 'object' || x === null || Array.isArray(x)) return fail(p, 'object', x);
      const entries = Object.entries(x as Record<string, unknown>);
      if (entries.length > maxKeys) return fail(p, `object with <= ${maxKeys} keys`, x);
      return Object.fromEntries(entries.map(([k, e]) => [k, inner(e, `${p}.${k}`)]));
    };
  },

  /** String or number[] of bytes. */
  stringOrBytes(): Validator<string | number[]> {
    return (x, p) => (typeof x === 'string' ? v.string({ max: 1 << 20 })(x, p) : v.array(v.byte(), 1 << 20)(x, p));
  },
};

/** Validate an argument list: missing trailing optional args are fine, extra args are rejected. */
export function validateArgs(validators: readonly Validator<unknown>[], args: readonly unknown[], where: string): unknown[] {
  if (args.length > validators.length) throw new ValidationError(`${where}: expected at most ${validators.length} argument(s), got ${args.length}`);
  return validators.map((val, i) => val(args[i], `${where}#${i}`));
}
