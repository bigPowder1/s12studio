/**
 * electron-builder configuration of S12 Studio (Release 1 "Simulator edition"; docs/RELEASING.md).
 *
 *   npm run dist          (repo root) build + licence texts + installer for the current OS
 *   npm run dist:linux | dist:win | dist:mac
 *   npx electron-builder --config electron-builder.config.cjs --dir    (unpacked app only, in apps/ide)
 *
 * ONE configuration point for identity and the update feed: apps/ide/package.json
 *   "s12studio": { "appId": ... }   also the Windows AppUserModelID (src/main/app-package.ts)
 *   "repository"                    GitHub repository of the releases; CI overrides it with $GITHUB_REPOSITORY
 *                                   (written into the packaged package.json through extraMetadata so the
 *                                   runtime update check sees the same repository as electron-updater)
 *
 * Signing: Release 1 is an UNSIGNED beta. Windows: no signature. macOS: ad-hoc signature (identity "-": required
 * to run on Apple Silicon at all, avoids the "app is damaged" error; users still need System Settings > Privacy &
 * Security > Open Anyway). The env-driven blocks below switch real signing on later without code changes.
 */
'use strict';
const pkg = require('./package.json');

/** UNCERTAIN: reverse-DNS id until the department decides (edit apps/ide/package.json "s12studio.appId"). */
const APP_ID = (pkg.s12studio && pkg.s12studio.appId) || 'edu.calpoly.s12studio';

/** owner/repo from $GITHUB_REPOSITORY (CI) or package.json "repository" (same rules as src/main/updates/policy.ts). */
function githubRepo() {
  const field = process.env.GITHUB_REPOSITORY || (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository && pkg.repository.url) || '';
  const m =
    /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(field) ||
    /^(?:git\+)?(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(field) ||
    /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(field);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : { owner: 'OWNER', repo: 's12studio' };
}
const gh = githubRepo();

const env = process.env;

/** The installed (hoisted) Electron: package.json has a range, electron-builder needs the exact version. */
const electronVersion = require('electron/package.json').version;

/** Windows code signing, off until S12_WIN_SIGN=azure (Azure Artifact Signing, formerly Trusted Signing). */
const winSign =
  env.S12_WIN_SIGN === 'azure'
    ? {
        azureSignOptions: {
          // electron-builder >= 25.1; auth from AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
          publisherName: env.S12_WIN_PUBLISHER_NAME, // must equal the certificate subject CN
          endpoint: env.AZURE_SIGNING_ENDPOINT, // e.g. https://wus2.codesigning.azure.net
          codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT,
          certificateProfileName: env.AZURE_SIGNING_PROFILE,
        },
      }
    : {};

/**
 * macOS: ad-hoc unless S12_MAC_SIGN=developer-id. Then CSC_LINK / CSC_KEY_PASSWORD (or CSC_NAME) give the
 * "Developer ID Application" identity, the hardened runtime is enabled and the app is notarized with APPLE_ID /
 * APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID (or APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER).
 */
const macSigned = env.S12_MAC_SIGN === 'developer-id';
const macSign = macSigned
  ? {
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      notarize: true,
    }
  : { identity: '-', hardenedRuntime: false, gatekeeperAssess: false, notarize: false };

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: APP_ID,
  electronVersion,
  productName: 'S12 Studio',
  copyright: `Copyright © ${new Date().getFullYear()} S12 Studio contributors`,
  // no spaces in file names (GitHub release assets, curl, shell scripts)
  artifactName: 'S12Studio-${version}-${os}-${arch}.${ext}',
  directories: { output: 'dist', buildResources: 'build' },
  // electron-vite output only (sourcemaps excluded); package.json is always included ("type": "module")
  // (production dependencies, i.e. electron-updater, are added by electron-builder; their maps, typings and readmes
  // are dropped, their licence files - some are LICENSE.md / license.md - are kept)
  files: [
    'out/**/*',
    '!out/**/*.map',
    'package.json',
    '!**/node_modules/**/*.{map,ts}',
    '!**/node_modules/**/{README,Readme,readme,CHANGELOG,Changelog,changelog,HISTORY,History,history}*.md',
  ],
  // the packaged package.json carries the same repository/homepage as the update feed
  extraMetadata: {
    repository: `https://github.com/${gh.owner}/${gh.repo}.git`,
    homepage: `https://github.com/${gh.owner}/${gh.repo}`,
  },
  extraResources: [
    // The public demo project (our own code; no course content is ever bundled). The app opens it from
    // path.join(process.resourcesPath, 'examples', 'blinky', 'blinky.s12studio.json') when packaged (Help > Open Demo
    // Project, startup dialog); Make output (bin/, blinky_Data/) is excluded.
    { from: '../../examples/blinky', to: 'examples/blinky', filter: ['**/*', '!bin/**', '!*_Data/**'] },
    // BrowserWindow icon on Windows/Linux (src/main/windows.ts)
    { from: 'build/icon.png', to: 'icon.png' },
    // LICENSE / NOTICE (Apache-2.0 section 4), THIRD_PARTY_NOTICES.md and the licence texts of every bundled npm
    // package; written by scripts/collect-licenses.mjs (part of every dist script) after electron-vite build
    { from: 'resources/licenses', to: 'licenses' },
  ],
  asar: true,
  // The debug engine worker (out/main/debug-worker.js, ESM) loads from app.asar (verified by e2e/packaged.spec.ts).
  // If a future Electron cannot, unpack it: asarUnpack: ['out/main/**'].
  npmRebuild: false, // no native modules
  electronLanguages: ['en-US'], // the UI is English-only; drops ~40 MB of Chromium locales
  compression: 'normal',
  fileAssociations: [
    {
      ext: 'mcp',
      name: 'CodeWarrior-format project',
      description: 'CodeWarrior-format project (opened with S12 Studio)',
      role: 'Editor',
      icon: 'icon', // build/icon.ico (Windows) / build/icon.icns (macOS), written by scripts/make-icon.mjs
    },
    // Side effect: on Windows the per-user registration takes over .mcp from a machine-wide CodeWarrior install (and
    // MPLAB 8, which uses the same extension). An installer opt-out (build/installer.nsh) is an open item.
    // Not associated: *.s12studio.json (S12 Studio's standalone project). File associations work on the LAST
    // extension, so it would take over every .json file on Windows.
  ],
  publish: [{ provider: 'github', owner: gh.owner, repo: gh.repo, releaseType: 'draft' }],

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    executableName: 'S12Studio',
    icon: 'build/icon.ico',
    ...winSign,
  },
  nsis: {
    oneClick: false, // assisted installer: the user can pick the folder
    perMachine: false, // per-user install, no admin rights needed (lab PCs, student laptops)
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'S12 Studio',
    deleteAppDataOnUninstall: false,
    artifactName: 'S12Studio-${version}-win-${arch}-setup.${ext}',
  },

  mac: {
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    darkModeSupport: false,
    ...macSign,
  },
  dmg: { artifactName: 'S12Studio-${version}-mac-${arch}.${ext}' },

  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Development',
    executableName: 's12studio',
    syncDesktopName: true, // desktopName = the .desktop entry: window association (WM_CLASS) in desktop environments
    icon: 'build/icon.png',
    synopsis: 'CodeWarrior S12(X)-style IDE and simulator for the MC9S12XDP512',
    maintainer: 'S12 Studio contributors',
    // No MimeType for *.mcp: an AppImage cannot install a shared-mime-info definition (electron-builder writes one
    // for deb/rpm only), so a MimeType= line would associate nothing. Users open .mcp files from File > Open.
  },
};
