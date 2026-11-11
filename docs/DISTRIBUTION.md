# Distribution plan

How S12 Studio gets from this repository to ME 3305 students and faculty. Approved by the owner on 2026-11-05.
How to cut a release: [RELEASING.md](RELEASING.md).

## Goal

Students and faculty download an installer for Windows or macOS that "just works" on their own laptops, updates
itself where possible, and later talks to the lab's real board. The professor wants it shared broadly in the course.

## Releases

### Release 1: "Simulator edition" installers (no hardware)

1. **Public repository, clean history.** Published as a fresh orphan commit (no history; author = GitHub noreply).
   Course fixtures (the owner's graded Lab3, the instructor's blank_project, the ME3305 library) move to a PRIVATE
   repository `s12studio-fixtures`, checked out at `fixtures/` (gitignored) or pointed to by `S12_FIXTURES`. Tests
   skip fixture-dependent cases when it is absent. Own-authored demo projects live in `examples/`. Personal paths and
   names are scrubbed from tests and docs; verbatim NXP manual text in the research notes is trimmed.
2. **Legal files.** Apache-2.0 `LICENSE`; `NOTICE` with the trademark disclaimer (CodeWarrior is a trademark of NXP
   B.V.; not affiliated or endorsed; compatibility only); `THIRD_PARTY_NOTICES.md` (libasm test vectors, register
   symbol provenance, and the statement that S12 Studio contains no ME 3305 course material).
3. **No course content, anywhere** (decision of 2026-11-06). Neither the public repo nor the installers contain the
   ME3305 library, the instructors' template or any other course file. Students open the `blank_project` folder their
   course gives them (File > Open... its `.mcp`); a copy placed in `<userData>/templates` is also listed by File > New
   Project. The installers ship our own demo `examples/blinky` (as `<resources>/examples/blinky`) and File > New's
   generic assembly project.
4. **Packaging** (electron-builder, `apps/ide`): Windows NSIS x64, macOS dmg + zip for arm64 and x64, Linux
   AppImage; `.mcp` file association; app icon; renderer libraries bundled (devDependencies).
5. **Updates.** Windows/Linux: `electron-updater` from GitHub Releases, checked on start, non-modal "Restart to
   update". macOS (unsigned, so Squirrel.Mac cannot update): the same check against the GitHub Releases API shows
   "New version available - Download", which opens the release page.
6. **CI** (GitHub Actions): tests + typechecks on Windows/macOS/Linux; Electron E2E on Linux and Windows (the
   public demo `examples/blinky`; the job fails if no E2E test passed). The golden tests run in the **private**
   fixtures repository (`docs/ci/fixtures-golden.yml`), never in the public one, whose logs are world-readable. The
   release workflow on `v*` tags builds all installers into a draft GitHub Release; it never checks out the private
   fixtures.
7. **Unsigned beta.** Windows NSIS unsigned; macOS ad-hoc signed (identity `-`, required on Apple Silicon and avoids
   the "damaged" error). The download page's install guide explains SmartScreen "More info > Run anyway" (Smart App
   Control may block entirely) and macOS "Privacy & Security > Open Anyway". Signing is pre-wired as commented,
   environment-driven configuration: enabling it later is a CI-secret change.
8. **Download page** (`docs-site/`, GitHub Pages): OS-detecting download buttons, 3-step quickstart, screenshots of
   the public demo, install guide, FAQ, link to Issues.
9. **Windows-native QA.** Full E2E on a `windows-latest` runner; a manual pass on a real Windows laptop and a Mac.

### Release 2: real board on Windows with the lab's P&E pod

- "Hardware via CodeWarrior debugger" connection: detect a CodeWarrior 5.2 Special Edition install (free from NXP;
  brings the P&E drivers); Build in S12 Studio, then launch its `hiwave.exe` with the project's P&E `.ini` and
  `bin/Project.abs`. Guided setup page linking NXP's installer.
- In parallel: ask PEmicro for permission or an SDK to host the P&E GDI DLL natively (see the email below). Build that
  only if permitted.

### Later (not scheduled): integrated debugger on real boards, Windows and Mac

Only if the department adopts USBDM pods: ask the USBDM author for permission or a licence exception, write a
clean-room TypeScript USBDM driver over node-usb implementing `@s12/debug` `Target` (`packages/hw`). The department
builds or buys a batch of pods.

## Decisions (owner, 2026-11-05)

| Topic | Decision |
|---|---|
| macOS | Simulator only. Real-board work happens on Windows (laptops or lab PCs). USBDM revisited later. |
| Signing | Unsigned beta for now: Windows NSIS unsigned, macOS ad-hoc (`-`). No Mac auto-update. |
| Fixtures | Lab3 and course fixtures stay in a private repo; the public repo uses own-authored demos. |
| Hosting | Public repo `bigPowder1/s12studio` under the owner's personal GitHub account, transferred to a department organisation later. |
| Names (2026-11-06) | App "S12 Studio"; debugger window "S12 Studio Debugger" (not hiwave's Freescale product name); app id `io.github.bigpowder1.s12studio`. |
| Library notes (2026-11-06) | Notes on the ME3305 library's internals stay in the private repo (`research/` of `s12studio-fixtures`); the public `elf-lib-formats.md` keeps only the generic `.lib` container format. |
| Course content (2026-11-06) | No course content in installers; students open the course's blank_project. S12 Studio ships only the CodeWarrior-style IDE/debugger, the ME 3305 board simulator and our own demo project. No redistribution permission is needed; a courtesy note to the instructors replaces the permission request. |
| Licence | Apache-2.0 for our code. Course content keeps its own terms and is in neither the public repo nor the installers. |

Facts behind these: the P&E Multilink driver is Windows x64 only (impossible on Apple Silicon); Windows signing via
Azure Artifact Signing costs about $10/month; macOS needs an Apple Developer account ($99/year) plus notarization,
otherwise Sequoia and later require "Open Anyway" and auto-update does not work. A $0 path later: a Cal Poly
code-signing certificate (InCommon) and a university Apple organisation account.

## Asks outside the code

| Ask | Who | Status |
|---|---|---|
| Courtesy note to the ME 3305 instructors: what S12 Studio is, and whether they mind it naming ME 3305 (draft below) | Owner | To send before announcing the release |
| GitHub: `gh auth login` in WSL so the two repos can be created (public `s12studio`, private `s12studio-fixtures`) | Owner | Done 2026-11-06: private `s12studio-fixtures` created; the public repo is pushed only after the owner reviews it |
| Signing accounts (~$220/year, or free via Cal Poly ITS) | Department | Later |
| Multilink model on the lab pods; does the board expose SCI0 / USB-serial? | Lab technician | Open |
| Optional: Cal Poly ITS code-signing certificate, Apple org account with fee waiver, lab-PC image install | Cal Poly ITS | Optional |
| Check Cal Poly IP policy (student work is student-owned unless paid / extraordinary resources) before transferring to a department org | Owner | Before transfer |
| Ask PEmicro about the HCS12 UNIT library / hosting the GDI DLL (template below) | Owner | For Release 2 |

Lab partner consent is not needed while Lab3 stays private.

## Open items before the first public release

| Item | Owner of the fix | Notes |
|---|---|---|
| Courtesy note to the ME 3305 instructors | Owner | Draft below. If they object to naming the course, drop "ME 3305" from the site and README before release. |

### Draft: courtesy note to the ME 3305 instructors

> **Subject:** S12 Studio: a free CodeWarrior-style simulator for ME 3305 (FYI)
>
> Hi Professor ___,
>
> I wanted to let you know about a project of mine before students start finding it.
>
> 1. **What it is.** S12 Studio is a free, open-source (Apache-2.0) desktop app for Windows, macOS and Linux that
>    works like the lab's CodeWarrior and debugger and simulates the MC9S12XDP512 with the ME 3305 benchtop board
>    (LCD, keypad, LEDs, motor). Students open the course's own `blank_project` folder with it. It ships **none** of
>    the course files: no library, no template, no lab material. Download page: https://bigpowder1.github.io/s12studio/
> 2. **How it was built.** I built and tested it against the course project, so builds of `blank_project` match the
>    lab PCs' output. To simulate the board I wrote notes on how the library drives the hardware; they contain none of
>    the library's code and I keep them private. Happy to share them with you if useful.
> 3. **A question.** Do you mind the download page and README naming ME 3305, and telling students to get
>    `blank_project` from the course page? If you would rather it not mention the course, I will change that.
> 4. **Limits.** It is a simulator only: it does not program the real board, so students should still do their final
>    checks on the lab hardware.
> 5. **(Optional)** If you think it would help, you are welcome to mention it to the class.
>
> Thanks!
> ___

### Email template: PEmicro (Release 2)

> **Subject:** HCS12 debugging from an open-source educational IDE: HCS12 UNIT library / GDI DLL
>
> Hello PEmicro team,
>
> I maintain S12 Studio, a free, open-source (Apache-2.0) teaching IDE and simulator for the MC9S12XDP512 used in
> Cal Poly's ME 3305 course. Students use USB Multilink pods in the lab, and we would like S12 Studio to program and
> debug the board through them on Windows.
>
> 1. Is your **HCS12 UNIT library** (or another SDK) available for this purpose, and under what terms for a free,
>    open-source educational project?
> 2. Alternatively, may S12 Studio load the P&E GDI DLL that ships with NXP CodeWarrior for S12(X) 5.2 Special
>    Edition, installed by the user (we would not redistribute it)? Is there documentation for its interface?
> 3. Is there anything we should not do (for example reverse engineering the USB protocol), so that we stay within
>    your terms?
>
> Thank you,
> ___
