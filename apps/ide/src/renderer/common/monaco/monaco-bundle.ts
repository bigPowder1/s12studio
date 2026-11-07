/**
 * The locally bundled Monaco build used by S12 Studio (no CDN, no network): the core editor API plus only the
 * editor features a CodeWarrior-style editor needs (find/replace widget, clipboard, context menu, line and
 * word operations, multi-cursor, bracket matching). Left out on purpose: comment (assembly comments are column-1 ';',
 * done by the editor itself) and cursorUndo (it binds Ctrl+U = Project > Bring Up To Date). No language services (TypeScript/JSON/CSS workers) are loaded;
 * the only worker is the base editor worker (loader.ts).
 *
 * Loaded lazily through loader.ts so jsdom tests and the debugger window only pay for it when an editor is shown.
 */
import 'monaco-editor/features/codeEditor/register';
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/contextmenu/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/caretOperations/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/lineSelection/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/wordPartOperations/register';
import 'monaco-editor/features/indentation/register';

export * from 'monaco-editor/editor/editor.api';
