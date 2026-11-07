// 'prpl' "HC12 Wizard Configuration": plain XML. Spec: mcp-format.md §2.6.
// Only the flat <SelectedWizardElement .../> list matters, so a small attribute scanner suffices.

export interface McpWizardElement {
  name: string;
  term: string;
  id: string;
  idrefs: string[];
  hidden: boolean;
  attributes: Record<string, string>;
}

export interface McpWizard {
  xml: string;
  version?: string;
  elements: McpWizardElement[];
  /** Chip term, e.g. "MC9S12XDP512" */
  chip?: string;
  /** Language term, e.g. "Relocatable assembly" */
  language?: string;
  /** Connection ("Target" element) term, e.g. "P&E USB BDM Multilink" */
  connection?: string;
}

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
  });
}

function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = decodeXmlEntities(m[3] ?? m[4] ?? '');
  return out;
}

export function parseWizardXml(xml: string): McpWizard {
  const root = /<WizardConfiguration\b([^>]*)>/.exec(xml);
  const version = root ? parseAttributes(root[1]).version : undefined;
  const elements: McpWizardElement[] = [];
  const re = /<SelectedWizardElement\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const a = parseAttributes(m[1]);
    elements.push({
      name: a.name ?? '',
      term: a.term ?? '',
      id: a.id ?? '',
      idrefs: (a.idrefs ?? '').split(/\s+/).filter(Boolean),
      hidden: (a.hidden ?? '').toLowerCase() === 'yes',
      attributes: a,
    });
  }
  const term = (n: string) => elements.find((e) => e.name === n)?.term;
  return { xml, version, elements, chip: term('Chip'), language: term('Language'), connection: term('Target') };
}
