/**
 * Projects opened from inside a zip file. Windows Explorer lets students double-click a .mcp inside a zip: it extracts
 * only that one file to a temp folder (%TEMP%\Temp1_<name>.zip\...) and opens it there, so every source file, the
 * .prm and the library are missing and the build fails with confusing "Could not find file" errors. Both open paths
 * (File > Open in the renderer, command line / double-click in main) refuse such a path with ZIP_PROJECT_MESSAGE.
 */

export const ZIP_PROJECT_MESSAGE =
  'This project is inside a zip file. Extract the whole folder first (right-click the zip > Extract All...), then open the .mcp from the extracted folder.';

/**
 * Folder names that mean "opened from inside an archive":
 *   Temp<n>_<x>.zip  Explorer's temp copy (a real folder that happens to be named "<x>.zip" is fine)
 *   7zO<hex>       7-Zip's temp folder for a file opened from its window
 *   Rar$DI<x>      WinRAR's temp folder (Rar$DIa1234.5678)
 * UNCERTAIN: the 7-Zip / WinRAR temp folder names are from their observed behaviour, not from documentation.
 */
const ARCHIVE_DIR = [/^Temp\d+_.+\.zip$/i, /^7zO[0-9A-F]+$/i, /^Rar\$DI/i];

/** True when a file path lies inside a zip (or a zip tool's temp extraction folder). The file name itself is not checked. */
export function isInsideZip(path: string): boolean {
  const dirs = path.split(/[\\/]+/).filter(Boolean).slice(0, -1);
  return dirs.some((d) => ARCHIVE_DIR.some((re) => re.test(d)));
}
