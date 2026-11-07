/**
 * debug.* and board.* handlers: validate in main, then forward to the engine worker (DebugHost). Only
 * debug.launch runs in main (it needs the project and the window manager).
 */
import type { Breakpoint, Watchpoint } from '@s12/debug';
import type { BreakpointInfo, RegisterSetInfo, WatchpointInfo } from '../../../shared/api/debug';
import { REGISTER_NAMES } from '../../../shared/api/debug';
import type { RegisterSet } from '@s12/debug';
import { resolveLaunch } from '../../engine/debug-launch';
import type { MethodHandler, DomainHandlers } from '../router';
import { v, type Validator } from '../validate';
import type { MainServices } from '../../services';
import type { S12Methods } from '../../../shared/api';

// compile-time drift checks between the shared DTOs and the engine types
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _drift: [Same<RegisterSetInfo, RegisterSet>, Same<keyof BreakpointInfo, keyof Breakpoint>, Same<keyof WatchpointInfo, keyof Watchpoint>] = [true, true, true];
void _drift;

const addr = v.address;
const space = v.optional(v.literal('local', 'global'));
const counter = v.optional(v.object({ current: v.int(0, 2147483647), interval: v.int(0, 2147483647) }));
const text = (max = 4096) => v.string({ max });

const bpFields = {
  address: v.optional(addr()),
  global: v.optional(v.address()),
  temporary: v.optional(v.boolean()),
  enabled: v.optional(v.boolean()),
  condition: v.optional(text()),
  conditionEnabled: v.optional(v.boolean()),
  command: v.optional(text()),
  commandEnabled: v.optional(v.boolean()),
  commandContinue: v.optional(v.boolean()),
  counter,
  label: v.optional(text(256)),
  codeSize: v.optional(v.int(0)),
  sourceSize: v.optional(v.int(0)),
};
const bpSpec: Validator<unknown> = (x, p) => {
  const o = v.object(bpFields)(x, p);
  if (o.address === undefined) v.address()(undefined, `${p}.address`);
  return o;
};
const wpFields = {
  start: v.optional(addr()),
  end: v.optional(addr()),
  kind: v.optional(v.literal('read', 'write', 'readwrite')),
  space,
  enabled: v.optional(v.boolean()),
  condition: v.optional(text()),
  conditionEnabled: v.optional(v.boolean()),
  command: v.optional(text()),
  commandEnabled: v.optional(v.boolean()),
  commandContinue: v.optional(v.boolean()),
  counter,
  label: v.optional(text(256)),
};
const wpSpec: Validator<unknown> = (x, p) => {
  const o = v.object(wpFields)(x, p);
  if (o.start === undefined) v.address()(undefined, `${p}.start`);
  if (o.kind === undefined) v.literal('read')(undefined, `${p}.kind`);
  return o;
};
const range = v.object({ address: addr(), length: v.int(1, 0x10000), space });
const stepKind = v.literal('instr', 'over', 'out', 'srcLine', 'srcOver', 'srcOut');
const regName = v.literal(...REGISTER_NAMES);
const id = () => v.int(0);
const watchId = () => v.string({ min: 1, max: 128 });
const label = () => v.string({ min: 1, max: 32 });

/** Validators for every forwarded method (debug.* except launch, then board.*). */
const DEBUG_ARGS: { [M in Exclude<keyof S12Methods['debug'], 'launch'>]: readonly Validator<unknown>[] } = {
  session: [],
  closeSession: [],
  loadApplication: [v.object({ path: v.path(), options: v.optional(v.array(text(256), 32)) })],
  snapshot: [],
  go: [v.optional(v.object({ from: v.optional(addr()), until: v.optional(addr()) }))],
  halt: [],
  step: [stepKind],
  reset: [],
  restart: [],
  runTo: [addr()],
  resetCycles: [],
  setPacing: [v.literal('true-time', 'max'), v.optional(v.number({ min: 0.001, max: 1000 }))],
  readRegisters: [],
  writeRegister: [regName, v.int(0, 0xffff)],
  readMemory: [range],
  writeMemory: [addr(), v.bytes(0x10000), space],
  fillMemory: [addr(), addr(), v.byte(), space],
  watchMemory: [watchId(), v.array(range, 64)],
  unwatchMemory: [watchId()],
  disassemble: [v.object({ address: addr(), count: v.int(1, 2000), before: v.optional(v.int(0, 200)), symbolic: v.optional(v.boolean()) })],
  sourceFiles: [],
  readSource: [v.path()],
  lineAddresses: [v.path()],
  sourceLocation: [addr()],
  symbols: [],
  resolve: [text(1024)],
  breakpoints: [],
  setBreakpoint: [bpSpec],
  updateBreakpoint: [id(), v.object(bpFields)],
  removeBreakpoint: [id()],
  clearBreakpoints: [],
  watchpoints: [],
  setWatchpoint: [wpSpec],
  updateWatchpoint: [id(), v.object(wpFields)],
  removeWatchpoint: [id()],
  clearWatchpoints: [],
  exec: [text(65536), v.optional(v.object({ echo: v.optional(v.boolean()) }))],
  execFile: [v.path()],
  answerPrompt: [id(), v.optional(v.number())],
  expressions: [],
  addExpression: [text(1024), v.optional(text(64))],
  removeExpression: [text(1024)],
  saveExpressions: [],
  evaluate: [v.array(text(1024), 1000)],
  globals: [],
  callStack: [],
  sciSend: [v.int(0, 5), v.stringOrBytes()],
};

const BOARD_ARGS: { [M in keyof S12Methods['board']]: readonly Validator<unknown>[] } = {
  state: [],
  keys: [],
  pressKey: [label()],
  releaseKey: [label()],
  tapKey: [label(), v.optional(v.number({ min: 0, max: 60 }))],
  setMotorParams: [v.record(v.number(), 64)],
  setLoadTorque: [v.number({ min: -1000, max: 1000 })],
  setAnalogInput: [v.literal(0, 1), v.int(0, 15), v.number({ min: -1, max: 6 })],
  setPin: [v.string({ min: 3, max: 8, pattern: /^P(AD\d{2}|[A-Z]\d)$/ }), v.nullable(v.literal(0, 1))],
  powerCycle: [],
};

function forward<D extends 'debug' | 'board'>(s: MainServices, domain: D, table: Record<string, readonly Validator<unknown>[]>): Record<string, MethodHandler<(...a: never[]) => unknown>> {
  const out: Record<string, MethodHandler<(...a: never[]) => unknown>> = {};
  for (const [m, args] of Object.entries(table)) out[m] = { args, run: (_ctx, ...a: unknown[]) => s.debug.call(`${domain}.${m}`, a) as never };
  return out;
}

export function debugHandlers(s: MainServices): DomainHandlers<'debug'> {
  return {
    ...(forward(s, 'debug', DEBUG_ARGS) as unknown as Omit<DomainHandlers<'debug'>, 'launch'>),
    launch: {
      args: [v.optional(v.object({ target: v.optional(v.string({ min: 1, max: 255 })), iniPath: v.optional(v.path()), absPath: v.optional(v.path()), load: v.optional(v.boolean()) }))],
      run: async (_ctx, req) => {
        const prefs = (await s.settings.get()).debugger;
        const open = await resolveLaunch(s.projects, req ?? {}, { pacing: prefs.pacing, speedFactor: prefs.speedFactor, snapshotHz: prefs.snapshotHz, compilerDir: s.compilerDir });
        await s.windows.openDebugger();
        return (await s.debug.call('engine.openSession', [open])) as Awaited<ReturnType<S12Methods['debug']['launch']>>;
      },
    },
  };
}

export function boardHandlers(s: MainServices): DomainHandlers<'board'> {
  return forward(s, 'board', BOARD_ARGS) as unknown as DomainHandlers<'board'>;
}
