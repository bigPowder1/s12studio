import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fixture, readFixture, describeFx, hasFixtures } from './fixtures';
import { parseHiwaveLine, parseHiwaveScript, tokenizeHiwave, parseAttributeList, HiwaveSyntaxError } from '../src/text/hiwave-cmd';

const PROJECTS = ['Lab3', 'blank_project'];

describe('hiwave command lexer', () => {
  it('numbers in all radices', () => {
    const t = tokenizeHiwave('$FF 0xFF 0377 255 %1010 0');
    expect(t.map((x) => (x.type === 'number' ? [x.value, x.radix] : x.type))).toEqual([
      [255, 16],
      [255, 16],
      [255, 8],
      [255, 10],
      [10, 2],
      [0, 10],
    ]);
  });

  it('strings, symrefs, ranges and operators', () => {
    const t = tokenizeHiwave(`"a\\"b\\n" 'Courier New' &main &fibo.c:main+21 0x1000..0x10FF a..b , ; = == <`);
    expect(t[0]).toMatchObject({ type: 'string', value: 'a"b\n', quote: '"' });
    expect(t[1]).toMatchObject({ type: 'string', value: 'Courier New', quote: "'" });
    expect(t[2]).toMatchObject({ type: 'symref', value: 'main' });
    expect(t[3]).toMatchObject({ type: 'symref', value: 'fibo.c:main' });
    expect(t[4]).toMatchObject({ type: 'op', text: '+' });
    expect(t[5]).toMatchObject({ type: 'number', value: 21 });
    expect(t[6]).toMatchObject({ type: 'range', from: { value: 0x1000 }, to: { value: 0x10ff } });
    expect(t[7]).toMatchObject({ type: 'range', from: { text: 'a' }, to: { text: 'b' } });
    expect(t.slice(8).map((x) => x.text)).toEqual([',', ';', '=', '==', '<']);
  });

  it('keeps unknown escapes verbatim so Windows paths survive', () => {
    const [s] = tokenizeHiwave('".\\cmd\\P&E_Multilink_USB_startup.cmd"');
    expect(s).toMatchObject({ type: 'string', value: '.\\cmd\\P&E_Multilink_USB_startup.cmd', inner: '.\\cmd\\P&E_Multilink_USB_startup.cmd' });
  });

  it('parses target, command, args and comment', () => {
    const c = parseHiwaveLine('Data:1 < ADDXPR ONLY_ADD_IF_NEW "RX_FLAG"  // watch', 7)!;
    expect(c).toMatchObject({ line: 7, target: 'Data:1', command: 'ADDXPR', keyword: 'ADDXPR', argText: 'ONLY_ADD_IF_NEW "RX_FLAG"', comment: ' watch' });
    expect(c.args.map((a) => a.type)).toEqual(['ident', 'string']);
    expect(parseHiwaveLine('   // only a comment')).toBeNull();
    expect(parseHiwaveLine('')).toBeNull();
    const w = parseHiwaveLine('wb 0x03c 0x00\t //disable cop')!;
    expect(w).toMatchObject({ command: 'wb', comment: 'disable cop' });
    expect(w.args.map((a) => (a.type === 'number' ? a.value : a.text))).toEqual([0x3c, 0]);
    // '<' inside an expression is not a component redirect
    const e = parseHiwaveLine('IF a < b')!;
    expect(e.target).toBeUndefined();
    expect(e.command).toBe('IF');
  });

  it('comment markers inside strings are not comments', () => {
    const c = parseHiwaveLine('PRINTF "http://x" // real')!;
    expect(c.args[0]).toMatchObject({ type: 'string', value: 'http://x' });
    expect(c.comment).toBe(' real');
  });

  it('reports errors', () => {
    expect(() => parseHiwaveLine('ECHO "unterminated')).toThrow(HiwaveSyntaxError);
    expect(() => parseHiwaveLine('Data <')).toThrow(HiwaveSyntaxError);
    const s = parseHiwaveScript('g\r\nECHO "x\r\nbs &main t\r\n');
    expect(s.errors).toEqual([{ line: 2, message: 'unterminated string' }]);
    expect(s.commands.map((c) => c.keyword)).toEqual(['G', 'BS']);
  });

  it('attribute lists', () => {
    const c = parseHiwaveLine('Assembly < attributes ADR on,CODE off,ABSADR on,SYMB off,FORMAT Auto,FREEZE off,TOPPC 0x4000')!;
    expect(c.keyword).toBe('ATTRIBUTES');
    const at = parseAttributeList(c.args);
    expect(at.map((a) => [a.name, a.value])).toEqual([
      ['ADR', 'on'],
      ['CODE', 'off'],
      ['ABSADR', 'on'],
      ['SYMB', 'off'],
      ['FORMAT', 'Auto'],
      ['FREEZE', 'off'],
      ['TOPPC', '0x4000'],
    ]);
  });
});

describeFx('fixture command files', () => {
  for (const proj of PROJECTS) {
    const files = hasFixtures ? readdirSync(fixture(proj, 'cmd')) : ([] as string[]).filter((f) => f.endsWith('.cmd'));
    it(`${proj}: parses all ${files.length} .cmd files without errors`, () => {
      expect(files.length).toBe(26);
      for (const f of files) {
        const s = parseHiwaveScript(readFixture(proj, 'cmd', f).toString('latin1'));
        expect(s.errors, f).toEqual([]);
        expect(s.eol).toBe('\r\n');
        for (const c of s.commands) expect(c.target, f).toBeUndefined();
      }
    });
  }

  it('P&E postload: bs &main t, then g', () => {
    const s = parseHiwaveScript(readFixture('Lab3', 'cmd', 'P&E_Multilink_USB_Postload.cmd').toString('latin1'));
    expect(s.commands).toHaveLength(2);
    expect(s.commands[0]).toMatchObject({ keyword: 'BS', line: 2 });
    expect(s.commands[0].args).toEqual([
      { type: 'symref', text: '&main', value: 'main' },
      { type: 'ident', text: 't', value: 't' },
    ]);
    expect(s.commands[1]).toMatchObject({ keyword: 'G', args: [], line: 3 });
  });

  it('Full_Chip_Simulation postload is comment-only', () => {
    const s = parseHiwaveScript(readFixture('Lab3', 'cmd', 'Full_Chip_Simulation_Postload.cmd').toString('latin1'));
    expect(s.commands).toEqual([]);
    expect(s.lines[0]).toMatchObject({ kind: 'comment', comment: ' After load the commands written below will be executed' });
  });

  it('erase/unsecure script command subset', () => {
    const s = parseHiwaveScript(readFixture('Lab3', 'cmd', 'P&E_Multilink_USB_Erase_unsecure_hcs12.cmd').toString('latin1'));
    const kws = [...new Set(s.commands.map((c) => c.keyword))];
    expect(kws).toEqual(['DEFINEVALUEDLG', 'FLASH', 'RESET', 'WB', 'WAIT', 'WW', 'UNDEF']);
    const dlg = s.commands[0];
    expect(dlg.args.map((a) => a.type)).toEqual(['string', 'string', 'number', 'string']);
    expect(dlg.args[1]).toMatchObject({ value: 'CLKDIV' });
    expect(dlg.args[2]).toMatchObject({ value: 0x49 });
    const msg = dlg.args[3];
    expect(msg.type === 'string' && msg.value.includes('"bus frequency (kHz) / 175"\n')).toBe(true);
    expect(msg.type === 'string' && msg.value.includes('\t\tE/FCLKDIV')).toBe(true);
    const wbClk = s.commands.find((c) => c.keyword === 'WB' && c.args[1]?.text === 'CLKDIV')!;
    expect(wbClk.args[0]).toMatchObject({ type: 'number', value: 0x100 });
    expect(s.commands.find((c) => c.keyword === 'FLASH')!.args[0]).toMatchObject({ text: 'RELEASE' });
    expect(s.commands.find((c) => c.keyword === 'WAIT')!.args[0]).toMatchObject({ value: 20 });
    expect(s.commands.find((c) => c.keyword === 'WW')!.args.map((a) => (a.type === 'number' ? a.value : -1))).toEqual([0x108, 0xfffe]);
  });

  it('ini CMDFILE values are hiwave commands', () => {
    const c = parseHiwaveLine('CMDFILE STARTUP ON ".\\cmd\\P&E_Multilink_USB_startup.cmd"')!;
    expect(c.keyword).toBe('CMDFILE');
    expect(c.args.map((a) => (a.type === 'string' ? a.inner : a.text))).toEqual(['STARTUP', 'ON', '.\\cmd\\P&E_Multilink_USB_startup.cmd']);
  });
});

describe('hiwave command lexer: review regressions', () => {
  it('a quoted Windows path ending in a backslash parses (finding 6)', () => {
    const c = parseHiwaveLine('CMDFILE STARTUP ON "C:\\dir\\"');
    expect(c!.args.map((t) => t.type)).toEqual(['ident', 'ident', 'string']);
    const s = c!.args[2];
    expect(s.type === 'string' && [s.inner, s.value]).toEqual(['C:\\dir\\', 'C:\\dir\\']);
  });

  it('a trailing comment after such a path is still split off', () => {
    const c = parseHiwaveLine('CD "C:\\dir\\" // go there');
    expect(c!.comment).toBe(' go there');
    const s = c!.args[0];
    expect(s.type === 'string' && s.inner).toBe('C:\\dir\\');
  });

  it('escaped quotes still work when the string is terminated', () => {
    const t = tokenizeHiwave('"a\\"b" x');
    expect(t[0].type === 'string' && t[0].value).toBe('a"b');
    expect(t[1].text).toBe('x');
  });

  it('a genuinely unterminated string is still an error', () => {
    expect(() => tokenizeHiwave('"abc')).toThrow(HiwaveSyntaxError);
    expect(() => tokenizeHiwave('"a\\bc')).toThrow(HiwaveSyntaxError);
  });

  it('parseAttributeList with argText keeps raw value text (finding 7)', () => {
    const c = parseHiwaveLine('Data:1 < attributes SCOPE global,FOO -1,NAME "a,b",X  0x10 ')!;
    const a = parseAttributeList(c.args, c.argText);
    expect(a.map((x) => [x.name, x.value])).toEqual([
      ['SCOPE', 'global'],
      ['FOO', '-1'],
      ['NAME', '"a,b"'],
      ['X', '0x10'],
    ]);
    // without argText: token join (legacy behaviour)
    expect(parseAttributeList(c.args).map((x) => x.value)[1]).toBe('- 1');
  });
});
