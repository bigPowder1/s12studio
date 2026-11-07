# Releasing S12 Studio

Background and decisions: [DISTRIBUTION.md](DISTRIBUTION.md). Workflows: `.github/workflows/{ci,release,pages}.yml`.

The installers contain S12 Studio and the public demo `examples/blinky` (as `<resources>/examples/blinky`, without
build outputs) and no course content: no ME 305 library or template (decision of 2026-11-06). Students open the
`blank_project` folder their course gives them. No release step checks out the private fixtures repository.

## One-time setup

### 1. Set the GitHub owner (the only placeholder)

The repository is referred to as `OWNER/s12studio` until the owner's GitHub account is known. Configuration points:

| Where | What | When it matters |
|---|---|---|
| `apps/ide/package.json` `"repository"` (and `"homepage"`) | `https://github.com/OWNER/s12studio` | Local `npm run dist:*` builds: where electron-builder publishes and where the app checks for updates. **Release CI overrides it from `GITHUB_REPOSITORY`**, so CI builds are correct even before you edit it. |
| `docs-site/js/site.js` `S12_REPO` | `'OWNER/s12studio'` | Nothing to do on GitHub Pages: `pages.yml` replaces the placeholder in every site file with the deploying repository. Edit only to preview the site locally. |
| `README.md`, `docs-site/*.html`, `.github/release-notes-template.md`, `.github/ISSUE_TEMPLATE/config.yml`, `docs/DISTRIBUTION.md` | links to `OWNER/s12studio` / `OWNER.github.io/s12studio` | Replace once with the command below. (`release.yml` already fills in the release-notes template and `pages.yml` the site at deploy time.) |

Replace the placeholder in exactly these files (set `GH_OWNER` to your GitHub user or organisation name):

```bash
GH_OWNER=your-github-name
GH_OWNER_LC=$(printf '%s' "$GH_OWNER" | tr '[:upper:]' '[:lower:]')
sed -i "s#OWNER/s12studio#$GH_OWNER/s12studio#g; s#OWNER\.github\.io/s12studio#$GH_OWNER_LC.github.io/s12studio#g" \
  README.md docs-site/index.html docs-site/install.html docs-site/js/site.js \
  .github/release-notes-template.md .github/ISSUE_TEMPLATE/config.yml \
  apps/ide/package.json docs/DISTRIBUTION.md
npx vitest run apps/ide   # must still pass
```

Do **not** run a repository-wide replace: tests (`apps/ide/src/main/updates/updates.test.ts`) and the workflows
(`pages.yml`, `release.yml`, `docs-site/js/site.js`'s comparison value) use the literal placeholder on purpose, and
this file and `CLAUDE.md` describe it.

The app treats the `OWNER` placeholder as "no repository": update checks are off in such builds.

**Decide the app id at the same time (before the first tag).** `apps/ide/package.json` `"s12studio": { "appId" }`
is still `edu.calpoly.s12studio`, which reads as if Cal Poly published the app. It becomes the macOS bundle id, the
Windows AppUserModelID and the per-user install identity, so changing it after v0.1.0 breaks update continuity
(installed copies would not update to it). Unless the department has agreed to the Cal Poly id, switch to your
GitHub namespace before tagging:

```bash
sed -i 's#"appId": "edu.calpoly.s12studio"#"appId": "io.github.<lower-case-owner>.s12studio"#' apps/ide/package.json
```

### 2. Create the repositories

**Never create the public repository from this working copy's git history or index.** This checkout's index still
tracks the 129 `fixtures/` files (the `/fixtures/` ignore rule does not untrack them), `git checkout --orphan`
keeps the index (its first commit would contain Lab3, the library and the template), and the repo-local identity
is the owner's real name and e-mail. Copy the public files out into a new directory instead and start a new
repository there:

1. **Private** `<owner>/s12studio-fixtures` first: the contents of today's `fixtures/` (`Lab3/`, `blank_project/`,
   `research/`, and the private tests `tests/` (Vitest) and `e2e/` (Playwright)) at its root, created as a new
   repository from a copy (`cp -a fixtures ../s12studio-fixtures`, then `git init` there). Keep this repository
   private.
2. **Public** `<owner>/s12studio`, as one fresh commit authored with your GitHub noreply address. From the root of
   this checkout (Linux/WSL, `rsync` needed):

   ```bash
   PUB=../s12studio-public && mkdir "$PUB"          # must not exist yet
   # tracked + untracked-but-not-ignored files, minus fixtures/ and files deleted from the working tree
   git ls-files -z --cached --others --exclude-standard | grep -zv '^fixtures/' \
     | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done \
     | rsync -a --from0 --files-from=- ./ "$PUB"/
   cd "$PUB" && git init -b main
   git config user.name  "<your GitHub display name>"
   git config user.email "<id>+<user>@users.noreply.github.com"   # GitHub > Settings > Emails
   git add -A
   git ls-files | wc -l                    # about 585 files
   git ls-files | grep -c '^fixtures/'     # must print 0
   git ls-files | grep -Eci '\.(lib|mcp|abs|s19|o)$'   # must print 0 (examples/ has none of these)
   git grep -nIi -f ~/s12-private-patterns.txt         # must print nothing
   git commit -m "S12 Studio 0.1.0"
   ```

   `~/s12-private-patterns.txt` is a file kept OUTSIDE both repositories, one pattern per line: the owner's and
   the instructors' real names and Windows user names, the lab partner's name, your Linux home directory path and
   the cloud-drive folder name that appears in the lab paths. (Avoid generic patterns such as `C:\Users`: the
   tests use neutral example paths like that on purpose. A surname that also belongs to a binutils author in
   `docs/research/r2/s12x-isa.md`'s credits is a known, unrelated hit.)
   Only after all checks pass: create the empty repository on GitHub (no README/licence), then
   `git remote add origin https://github.com/<owner>/s12studio.git && git push -u origin main`.
3. Clone the private repository into `fixtures/` of the public checkout (or anywhere, with `S12_FIXTURES=<dir>`;
   absolute, or relative to the repository root). Check both modes: `npx vitest run` (golden tests run) and
   `S12_FIXTURES=/nonexistent npx vitest run` (they skip).

### 3. Golden tests in CI (in the private repository)

The public repository's CI (`ci.yml`) never sees the fixtures: its Actions logs are world-readable, and a failing
golden test prints diffs of the fixture sources and listings (a student's graded lab). The golden suite runs in the
**private** repository instead:

1. Copy [`docs/ci/fixtures-golden.yml`](ci/fixtures-golden.yml) into `s12studio-fixtures` as
   `.github/workflows/golden.yml` and push it.
2. If the public repository is not `<same owner>/s12studio`, set the variable `PUBLIC_REPOSITORY` (`owner/name`)
   in `s12studio-fixtures`.

It checks out the public repository (no credentials needed) with the fixtures in `fixtures/`, runs `npx vitest run`
and the Electron E2E specs, on every push to the fixtures, nightly against the public default branch, and on demand
(Actions > Golden > Run workflow, optionally with a branch or tag of the public repository). Private repositories
use the account's Actions minutes (2,000 free per month on GitHub Free; one run is about 10 minutes).

The release workflow's tests also run **without** the fixtures, for the same reason; check the Golden workflow
before tagging.

### 4. GitHub Pages

`s12studio` > Settings > Pages > Source: **GitHub Actions**. `pages.yml` deploys `docs-site/` on every push to
`main` that touches it (or run it by hand: Actions > Pages > Run workflow). Site: `https://<owner>.github.io/s12studio/`.
The screenshots `docs-site/img/{ide,debugger}.png` (also used by `README.md`; `new-project.png` is still written but
no page uses it) show the public demo `examples/blinky` only, never a lab solution or course content. Regenerate
them after UI changes with
`npm run build -w @s12/ide`, then
`S12_DOCS_SCREENSHOTS=$PWD/docs-site/img npm run e2e:nobuild -w @s12/ide -- docs-screenshots.spec.ts`
(`apps/ide/e2e/docs-screenshots.spec.ts`; the demo is copied to `<tmp>/demo/blinky` so no personal path shows), and
look at each picture before committing it.

## Cutting a release

1. Make sure `main` is green in CI and the private repository's Golden workflow passes against it
   (Actions > Golden > Run workflow in `s12studio-fixtures`).
2. Bump the version in `apps/ide/package.json` (`0.1.0` -> `0.1.1`; betas may use `0.2.0-beta.1`), commit:
   `npm version 0.1.1 -w @s12/ide --no-git-tag-version`, then commit `apps/ide/package.json` and `package-lock.json`.
3. Tag and push: `git tag v0.1.1 && git push origin main v0.1.1`. The tag **must** equal `v` + that version (the
   workflow checks).
4. `release.yml` then:
   - creates a **draft** GitHub Release for the tag (notes from `.github/release-notes-template.md`; tags with a `-`
     such as `v0.2.0-beta.1` become pre-releases);
   - on Windows, macOS and Linux runners: `npm ci`, the test suite (without fixtures), `npm run build -w @s12/ide`,
     then `npm run licenses -w @s12/ide` (writes
     `apps/ide/resources/licenses/`: `LICENSE`, `NOTICE`, `THIRD_PARTY_NOTICES.md` and the licence texts of every
     bundled npm package; shipped as `<resources>/licenses`), then
     `electron-builder --config electron-builder.config.cjs --win|--mac|--linux --publish always` in `apps/ide`, which
     uploads into the draft: `S12Studio-<v>-win-x64-setup.exe`, `S12Studio-<v>-mac-arm64.dmg` / `-mac-x64.dmg` (+ `.zip`,
     ad-hoc signed), `S12Studio-<v>-linux-x86_64.AppImage`, plus the `latest*.yml` update metadata and `.blockmap`
     files that electron-updater needs. The installers are also kept as workflow artifacts for 14 days.
5. Review the draft (Releases page): all files present (`latest.yml`, `latest-mac.yml`, `latest-linux.yml` too),
   edit the notes, download and smoke-test at least the Windows installer and one Mac build (install guide steps,
   open the demo, F7, F5, board), then **Publish release**.
   - Publish betas as a normal release, not "pre-release", if the download page should offer them: GitHub's
     `releases/latest` (used by the site, the README links and the update check) skips pre-releases and drafts.
6. Windows/Linux installs pick the update up on their next start; Macs show "new version available".

Re-running: Actions > Release > Run workflow with the existing tag rebuilds and re-uploads into the same release.

### Building locally

```bash
npm ci
npm run dist:win      # or dist:mac / dist:linux / dist (current OS) / dist:dir (unpacked); output in apps/ide/dist/
                      # (never published: the scripts pass --publish never)
```

Every `dist*` script runs `electron-vite build`, `licenses`, then electron-builder. `dist:linux` writes
`S12Studio-<v>-linux-x86_64.AppImage` and `latest-linux.yml` (update metadata) into `apps/ide/dist/`, and the
unpacked app (`dist/linux-unpacked/`, with `resources/app-update.yml`, `licenses/` and `examples/blinky/`; never a
`templates/` folder). Smoke-test a packaged build with the packaged E2E (`apps/ide/e2e/packaged.spec.ts`; it also
checks that the demo is bundled and no course content is):

```bash
S12_PACKAGED_APP=$PWD/apps/ide/dist/linux-unpacked/s12studio npm run e2e:packaged -w @s12/ide
# or the AppImage itself (without FUSE: APPIMAGE_EXTRACT_AND_RUN=1)
```

Cross-building: on Linux, `dist:linux` (AppImage) needs nothing extra; Windows installers need Wine; macOS builds
need a Mac. CI is the normal path (`ci.yml` also packages an unpacked app on Linux and Windows and runs the packaged
E2E on it).

### Things testers should know

- **`.mcp` file association (Windows):** the installer registers S12 Studio for `.mcp` files for the current user.
  On a PC that also has CodeWarrior (lab image) or MPLAB 8 (same extension), double-clicking a `.mcp` then opens
  S12 Studio; use "Open with" to pick the other program. An installer checkbox to opt out is an open item
  (`apps/ide/build/installer.nsh`, needs a Windows build to test). macOS associates `.mcp` too; the Linux AppImage
  associates nothing (open projects with File > Open).
- **Update checks** are off in builds whose `repository` is still the `OWNER/s12studio` placeholder (local builds
  before step 1 of the setup); `S12_NO_UPDATE=1` turns them off in any build.

## Enabling code signing later

Nothing in the code changes: `apps/ide/electron-builder.config.cjs` switches on environment variables. Add the
secrets/variables and uncomment the marked blocks in `.github/workflows/release.yml`.

**Windows, Azure Artifact Signing** (about $10/month; individuals in the US are eligible; SmartScreen reputation still
builds up over a few weeks of downloads):

1. Create an Artifact Signing account + certificate profile in Azure; create an app registration (service principal)
   with the "Artifact Signing Certificate Profile Signer" role on the profile.
2. Secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`; repository variables
   `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE`, `S12_WIN_PUBLISHER_NAME` (the
   certificate subject CN).
3. Uncomment the Windows block (`S12_WIN_SIGN: azure`). electron-builder signs through `win.azureSignOptions`.

**macOS, Developer ID + notarization** (Apple Developer Program $99/year; fee waiver only for institution accounts):

1. Create a "Developer ID Application" certificate, export it as `.p12`; base64 it into secret `MAC_CERT_P12_BASE64`
   with `MAC_CERT_PASSWORD`.
2. Create an App Store Connect API key (Users and Access > Integrations): secrets `APPLE_API_KEY_P8` (file contents),
   `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
3. Uncomment the macOS block (`S12_MAC_SIGN: developer-id`) and the "Write the App Store Connect API key" step. The
   config switches from ad-hoc (`identity: "-"`) to Developer ID with hardened runtime + notarization
   (`build/entitlements.mac.plist`). Mac auto-update also needs the update policy in
   `apps/ide/src/main/updates/policy.ts` to treat signed Mac builds as `auto` (today macOS is always `notify`).

## Transferring to a department organisation

1. Check Cal Poly's IP policy first (student-owned unless paid or extraordinary university resources were used).
2. GitHub: Settings > Danger zone > Transfer, for both `s12studio` and `s12studio-fixtures`. GitHub redirects the old
   URLs (including release downloads and the update check), but update the configuration anyway:
   - `apps/ide/package.json` `"repository"` and every `<owner>/s12studio` link (step 1 of the one-time setup);
   - set `PUBLIC_REPOSITORY` (in the fixtures repo) if a name changes; re-enable Pages (Source: GitHub Actions). The Pages URL changes to `<org>.github.io/s12studio`
     and is **not** redirected: link the new site from the old README for a while.
3. Cut a release after the transfer so installed apps check the new repository directly.
