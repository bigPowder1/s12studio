// hiwave Data-window watch list (<app>.xpr next to the .abs): `Data < ADDXPR ONLY_ADD_IF_NEW "expr"` lines, CRLF.
import { parseHiwaveScript } from './hiwave-cmd';

export interface XprEntry {
  expression: string;
  /** target component, normally "Data" */
  component: string;
  onlyIfNew: boolean;
  line: number;
}

export interface XprFile {
  entries: XprEntry[];
  warnings: string[];
  eol: '\r\n' | '\n';
}

export function parseXpr(text: string): XprFile {
  const s = parseHiwaveScript(text);
  const out: XprFile = { entries: [], warnings: s.errors.map((e) => `line ${e.line}: ${e.message}`), eol: s.eol };
  for (const c of s.commands) {
    if (c.keyword !== 'ADDXPR') {
      out.warnings.push(`line ${c.line}: unexpected command ${c.command}`);
      continue;
    }
    let args = c.args;
    let onlyIfNew = false;
    if (args[0]?.type === 'ident' && args[0].text.toUpperCase() === 'ONLY_ADD_IF_NEW') {
      onlyIfNew = true;
      args = args.slice(1);
    }
    const e = args[0];
    if (!e || e.type !== 'string') {
      out.warnings.push(`line ${c.line}: ADDXPR expects a quoted expression`);
      continue;
    }
    out.entries.push({ expression: e.value, component: c.target ?? 'Data', onlyIfNew, line: c.line });
  }
  return out;
}

/** Write a watch list as CodeWarrior does (UNCERTAIN: escaping of '"' inside expressions is not observed). */
export function writeXpr(expressions: (string | Pick<XprEntry, 'expression' | 'component' | 'onlyIfNew'>)[], eol: '\r\n' | '\n' = '\r\n'): string {
  return expressions
    .map((e) => (typeof e === 'string' ? { expression: e, component: 'Data', onlyIfNew: true } : e))
    .map((e) => `${e.component} < ADDXPR ${e.onlyIfNew ? 'ONLY_ADD_IF_NEW ' : ''}"${e.expression.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"${eol}`)
    .join('');
}
