/**
 * Test data in hiwave's own file formats, written for S12 Studio's tests (public; no fixture needed):
 * a 7-window assembly debugging layout (.hwl) and a Full Chip Simulation connection .ini with a TOOLBAR= key.
 * The geometry, attributes and toolbar command ids follow the formats in docs/research/r1/ide.md section 6-7.
 */
const crlf = (lines: string[]) => lines.join('\r\n') + '\r\n';

/**
 * Seven component windows with our own geometry and attribute values (not a copy of any CodeWarrior-generated layout),
 * attributes in hiwave's write order, ivory background, ACTIVATE ending with Data (active).
 */
export const ASM_LAYOUT_HWL = crlf([
  'OPEN source 0 0 58 46',
  'Source < attributes TOOLTIP on,TOOLTIP_FORMAT hex,TOOLTIP_MODE value,FREEZE off,MARKS on',
  'OPEN register 58 0 42 28',
  'Register < attributes FORMAT HEX,COMPLEMENT None',
  'OPEN assembly 58 28 42 32',
  'Assembly < attributes ADR on,CODE on,ABSADR off,SYMB on,FORMAT Auto,FREEZE off,TOPPC 0xC000',
  'OPEN memory 58 60 42 22',
  'Memory < attributes FORMAT hex,COMPLEMENT None,WORD 2,ASC off,ADR on,MODE periodical,UPDATERATE 5,SHOW_ADDRESSSPACE 0,ADDRESS 0x1000',
  'OPEN procedure 58 82 42 18',
  'Procedure < attributes VALUES off,TYPES on',
  'OPEN data 0 46 58 24',
  'Data < attributes SCOPE global,COMPLEMENT None,FORMAT Hex,MODE automatic,SORT NotSort,UPDATERATE 2,NAMEWIDTH 20',
  'OPEN command 0 70 58 30',
  'Command < attributes CACHESIZE 500',
  'bckcolor 49348607',
  "font 'Consolas' 10 BLACK",
  'AUTOSIZE on',
  'ACTIVATE "Procedure" "Memory" "Assembly" "Register" "Command" "Source" "Data"',
]);

/** Full Chip Simulation connection settings (target sim, layout, load options, main frame, toolbar, hook files). */
export const FCS_INI = crlf([
  '[Environment Variables]',
  'GENPATH={Project}Sources;{Compiler}lib\\hc12c\\include',
  'OBJPATH={Project}bin',
  'TEXTPATH={Project}bin',
  'ABSPATH={Project}bin',
  '',
  '[HI-WAVE]',
  'Target=sim',
  'Layout=ASM_layout.hwl',
  'LoadDialogOptions=AUTOERASEANDFLASH NORUNAFTERLOAD',
  'CPU=HC12',
  'MainFrame=2,3,-1,-1,-1,-1,100,100,1100,900',
  'TOOLBAR=57600 57601 32795 0 57635 57634 57637 0 57671 57669 0 32777 32776 32782 32780 32781 32778 0 32806',
  '',
  '[Simulator]',
  'CMDFILE0=CMDFILE STARTUP ON ".\\cmd\\Full_Chip_Simulation_startup.cmd"',
  '',
  '[Simulator HC12]',
  'FCS=MC9S12XDP512',
]);
