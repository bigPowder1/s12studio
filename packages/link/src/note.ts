// Linker `.note` metadata helpers.
import { readElf, parseHiwareNotes, noteDescString, HiwareNoteType, type ElfFile } from '@s12/formats';
import type { NoteMeta } from './types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');

/** C ctime() text WITHOUT the trailing newline, local time: "Mon Oct 19 10:30:47 2026". */
export function ctime(d: Date): string {
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
}

/**
 * The command line the CodeWarrior IDE passes to the linker, as recorded in the .note (type 9):
 *   -add("<in1>"  "<in2>" ) -o"<abs>" -env"K=V" ... (every argument followed by one space).
 * `env` entries are appended in order (the IDE passes GENPATH, OBJPATH, TEXTPATH).
 */
export function linkerCommandLine(inputs: readonly string[], output: string, env: readonly [string, string][] = []): string {
  let s = `-add(${inputs.map((p) => `"${p}" `).join(' ')}) -o"${output}" `;
  for (const [k, v] of env) s += `-env"${k}=${v}" `;
  return s;
}

/** Extract user / time stamp / command line from an existing linked .abs (golden tests, relinking). */
export function readNoteMeta(abs: Uint8Array | ElfFile): NoteMeta | undefined {
  const elf = abs instanceof Uint8Array ? readElf(abs) : abs;
  const note = elf.sections.find((s) => s.name === '.note');
  if (!note) return undefined;
  const notes = parseHiwareNotes(note.data).notes;
  const get = (t: number) => notes.find((n) => n.type === t);
  const user = get(HiwareNoteType.User);
  const created = get(HiwareNoteType.Created);
  const cmd = get(HiwareNoteType.CommandLine);
  if (!user || !created || !cmd) return undefined;
  return { user: noteDescString(user.desc), created: noteDescString(created.desc), commandLine: noteDescString(cmd.desc) };
}
