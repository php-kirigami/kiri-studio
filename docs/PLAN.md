# Kiri Studio — plan

## Where we are (handoff, 2026-09-29)

Read this first when resuming. Phases 0–3 are done; phase 5 (live preview)
works; phase 4 (publish) is deliberately not started (maintainer's call: do
everything that doesn't need publishing first, publish when it blocks).

**Done** (see the phase sections below for detail): sign-in,
site list, tarball sync, discovery grouped by page, Markdown editor, YAML/JSON
editor with JSON Schema help and smart indentation, autosaved drafts (text,
binary, deletions), image/document managers (subfolders, downscale, viewer,
`{% img-asset %}` copy/insert), collections, live preview, multi-editor
awareness, unsigned installers + self-updates, CI on 3 OSes (unit + `npm
run smoke`, 7 scenarios on `test/fixtures/site`).

**Multi-editor awareness** (last session): the renderer calls `site:sync`
every 3 minutes and on window focus (if the last check is older than 30 s).
When the branch moved, the main process drops drafts the synced copy caught
up with (`drafts.tidy()`), rebuilds the scope, clears the schemas, and
restarts a running preview (`preview.resync()`, new URL sent through
`preview:status`). The renderer rebuilds the sidebar (keeping the
selection), reloads an untouched open file, and shows "Someone else
published this page since you started…" on a changed file whose `base` no
longer matches (`drafts.outdated()`, also returned by `site:read`). Unit
tests and the smoke `outdated` scenario cover the drafts side and the
notice; **the real GitHub path is untested**: try it once on the sandbox
(edit a file on github.com while the app is open, refocus the window).

**Phase 6 without certificates** (last session): `electron-builder.yml`
(NSIS per-user one-click x64, dmg arm64+x64 ad-hoc signed, AppImage + deb),
`npm run dist`, `src/main/updates.js` (electron-updater: check at start and
every 4 h, download in background, install on quit; Windows and AppImage
only), and `.github/workflows/release.yml` (tag `v*` → draft release, the
smoke tests run on each packaged app first via `SMOKE_APP`). Verified
locally on Windows: the installer builds and all 7 smoke scenarios pass on
`dist/win-unpacked` (preview included: the worker runs fine from the asar).
**v0.1.0** went through the release workflow on all 3 OSes (macOS ad-hoc
signing and the `.deb` work; the Windows smoke `viewer` scenario flaked
once on a fixed delay, fixed in `f2d6d3c`, job re-run). It sits as a
**draft** release until the maintainer publishes it. Not yet tried: running
the installers on real machines, and an update from one release to the next.

**Next, in order:**
1. Publish the v0.1.0 draft, install it (Windows, and a Linux AppImage if at
   hand), then release `v0.1.1` and watch the installed app update itself on
   quit.
2. Polish: loading indicator on first site list, offline fallback test, clicking through the real sign-in once, the sandbox sync check
   above.
3. Phase 4 (publish) when needed. After a publish, a sync + `drafts.tidy()`
   clears what was published.
4. Signing (Apple Developer ID, a Windows signing service) when clients
   arrive: then add the mac `zip` target and turn macOS updates on in
   `updates.js`.

**Known gaps / gotchas:**
- The preview runs the site's own Kirigami (e.g. published 3.0.2), which
  rejects `studio:` (the preview copy strips it) and still re-renders a
  changed data file's *directory* instead of the pages that load it: fixed in
  the monorepo (`f486d3e`, unreleased). Until a core release, preview of
  sites with data under `src/_data/` (humainhumain) won't refresh on data
  edits.
- Unreleased core commits the app relies on (monorepo `main`, not pushed):
  `studio:` block + `schemas` + `imageWidth`, `internal/tar` with file modes,
  watch data→pages map. humainhumain testing waits for that release.
- Shell quoting: backslashes and quotes in `node -e`/`sed` one-liners got
  mangled repeatedly; use the Edit tool for code with regexes or `\n`.

Status: **phase 0 done, phase 1 mostly done, nothing of the app built yet.**
Expands the "Desktop UI" entry of the monorepo's
[ROADMAP.md](https://github.com/php-kirigami/kirigami/blob/main/docs/ROADMAP.md).
Started 2026-09-29 from a brainstorm on a generic "Electron CMS for GitHub
Pages"; this plan adapts it to Kirigami. Moved here from the monorepo's
`docs/DESKTOP-APP.md` once this repo existed.

Name: **Kiri Studio** (keeps the `kiri` brand link). It lives in its own
repo, `php-kirigami/kiri-studio` (`../kiri-studio/`, next to the `kirigami`
monorepo), not in the monorepo's `packages/`. It consumes the published
`@kirigami/*` packages like any other embedder.

## Goal

A desktop app that lets a **non-technical client** edit their own Kirigami
site: text (Markdown), structured data (YAML), and images. The client signs in
with GitHub, picks one of *their* sites, edits only what the site's maintainer
opened for editing, previews the real rendered page, and clicks **Publish**.
They never see Git, PHP, a terminal, or the site's source code.

Publishing only pushes source files. The site's existing kiribuild workflow
builds and deploys to GitHub Pages as it does today.

## The #1 requirement: seamless for the client

This overrides every other choice in this document. When a design choice trades
client simplicity for technical elegance, client simplicity wins; complexity
goes to the app, the maintainer, or the site repo, never to the client.

The whole client journey, and nothing more:

1. **Install** — a signed installer, double-click, done. Updates install
   themselves silently.
2. **Sign in once** — one "Sign in with GitHub" button. The app opens the
   browser with the code already copied; the client approves and never sees
   that screen again.
3. **Open** — the app shows the site directly (the site picker only appears if
   the client has more than one). The site updates itself in the background
   while the client reads.
4. **Edit** — click a page or section by its plain name ("Team", "Blog
   posts"), change text in a form or a text editor, drop pictures in. Changes
   are saved automatically; there is no Save button and nothing to lose.
5. **See** — the preview beside the editor shows the real page as it will look.
6. **Publish** — one button. Then "Publishing…" and "Your site is online",
   with a link.

What the client must never face: Git words (commit, push, pull, branch,
conflict, merge), file paths, YAML/Markdown syntax errors, technical error
messages, choices they can't make with confidence, or setup steps (no Node, no
npm, no Git to install). When something goes wrong that the client can't fix,
the message says so in plain words and offers a "Send to support" button that
bundles the technical details for the maintainer.

## Principles

- **Plain language.** "Publish", "Up to date", "Your site is online" — not
  "commit", "pull", "deploy". French and English UI from day one.
- **The maintainer decides what is editable, in the site repo.** It's declared
  in `kirigami.yaml` and versioned with the site, not configured in the app.
- **Same engine as every other surface.** Preview goes through the `Project`
  API in a dedicated worker process, like the VS Code extension
  ([EXTENSION-VSCODE.md](https://github.com/php-kirigami/kirigami/blob/main/docs/EXTENSION-VSCODE.md)).
- **Stay lite.** No `git` binary, no native deps beyond Electron itself.

## Key design choices (proposed)

### 1. No local Git: GitHub API only

Instead of cloning with `isomorphic-git` (what the brainstorm suggested), the
app talks to the GitHub API directly:

- **Sync** = download the repo tarball at the branch head (core already has
  `bin/libs/github.js` and `bin/libs/tar.js` for `kiri create`) into a cache
  folder, remembering the head commit SHA.
- **Edits** = a local *draft overlay*: changed/added/deleted files kept apart
  from the synced tree, persisted so a crash or restart loses nothing.
- **Publish** = the Git Data REST API: one blob per changed file, one tree on
  top of the synced commit's tree, one commit whose parent is the synced SHA,
  then `PATCH` the branch ref with `force: false`. Only that last step changes
  the branch, so a publish is all-or-nothing. It needs no Git objects locally,
  and it **detects concurrent changes for free**: the ref update is refused
  ("not a fast forward") if someone pushed in between. Validated in phase 0
  (spike 3), including a 20 MB file.
- GraphQL `createCommitOnBranch` was the first idea (a single call), but it
  rejects any request over ~5 MB of files *in total*, which a few photos
  exceed. One publish path for every size beats two.

Why: no Git binary to ship, no repo history on the client's disk, no merge
machinery. The client edits a handful of files; a full Git client is overkill.

**No Git LFS (decided 2026-09-29).** The images Kiri Studio commits are
already downscaled (design choice 5), so they stay small and plain Git holds
them fine. LFS would cost more than it saves:

- The GitHub Pages build checks out the LFS files on **every** deploy, which
  counts against the LFS bandwidth quota; a busy site would exhaust a free plan.
- The site workflow must opt in (`lfs: true` on checkout), a trap for every
  maintainer.
- The app would need the LFS batch upload API next to the Git Data one: a
  second publish path, and one more thing to go wrong for the client.

LFS only pays off for large binaries (video, raw files), which a client-editable
site shouldn't hold anyway; video goes to YouTube/Vimeo and is embedded. If a
repo already tracks editable paths with LFS (`.gitattributes`), Kiri Studio
refuses them with a clear maintainer-facing message rather than writing raw
files where pointers are expected.

### 2. Auth: one "Kiri Studio" GitHub App, owned by `php-kirigami`

A GitHub App is registered **once**, by the `php-kirigami` org (a settings
form, no server to run). Then:

- **Maintainer, once per client site:** installs the App on the site's repo
  (one "Install" page, pick repos) and adds the client as a collaborator with
  write access. That's all the setup there is, and the client does none of it.
- **Client:** clicks "Sign in with GitHub" in Kiri Studio. The token the app gets
  is the *intersection* of the client's own rights and the App's installation:
  only repos where the App is installed **and** the client can write, and only
  what the App's permissions allow (`contents: write`, `actions: read`). The
  token can't touch the client's other repos, unlike an OAuth `repo` scope.
- **Device flow** sign-in: it needs only the App's public client ID, so there
  is no secret in the app to leak. To keep it one click, the app copies the
  code to the clipboard and opens the browser itself; the client pastes and
  approves.
- **Non-expiring user tokens** (App setting "Expire user authorization tokens"
  off): refreshing an expiring token needs the App's client secret, which a
  desktop app can't hold. The token is stored with Electron `safeStorage`
  (DPAPI/Keychain/libsecret) and the client signs in once.
- Owned by the org, the App works for any Kirigami maintainer's clients, not
  only one. A maintainer who wants their own branding can register their own
  App and point Kiri Studio at its client ID (later).
- The project list = repos the App is installed on, that the client can write
  to, **and** whose `kirigami.yaml` has a `studio:` block.

Registering the App (org settings → Developer settings → GitHub Apps → New):
name, homepage, *Enable Device Flow* on, no webhook, the two permissions above,
"Any account" can install. The resulting client ID is compiled into Kiri Studio.

### 3. Editable scope: a `studio:` block in `kirigami.yaml`

Settled 2026-09-29 and in core's schema (see the core README's `studio:`
section for the reference). The maintainer writes almost nothing:

```yaml
studio:
  files: src/documents                    # file manager (PDF, …); omit to hide
  exclude: [src/features/data/_stats.json]
  labels:
    src/features/data/_articles.yaml: Articles
  schemas:                                # same format as VS Code's yaml.schemas
    assets/schemas/articles.schema.json: _articles.yaml
```

- **Automatic discovery.** `studio: {}` is enough: every `.md`/`.yaml`/
  `.yml`/`.json` file a page loads through a PHPDOC annotation (`@content
  _about.md`, `@articles _articles.yaml`) is editable, grouped under the
  page's `@title` in the sidebar (home page first, files in annotation
  order). This fits how Kirigami sites already work: content lives in data
  files next to the PHP templates. `exclude` hides some, `include` adds files
  no page references (with `create: true` on a glob, the client can add and
  delete files, e.g. blog posts), `labels` renames.
- **YAML/JSON edited as text, with a JSON Schema's help** (decided
  2026-09-29, replacing the first idea of generated forms). The maintainer
  already writes schemas for VS Code (e.g. humainhumain's
  `assets/schemas/*.schema.json`); the client gets the same help in a
  simpler editor: smart indentation (Enter indents after `key:`, aligns
  under the key after `- key: value`, continues `- text` lists, ends a list
  on an empty `- `; Tab/Shift+Tab by two spaces, never a tab), mistakes
  underlined in plain words using the schema's own descriptions, a "3 things
  to fix" summary that opens the list, field names suggested (Ctrl+Space or
  as they type), and each field's description on hover. Forms may come back
  later for simple files; they're not needed to ship.
- **Schema association, like VS Code's YAML extension** so a site set up for
  VS Code needs nothing more: a `# yaml-language-server: $schema=` line in
  the file, else `studio.schemas`, else `yaml.schemas` in
  `.vscode/settings.json` (JSONC). Schemas are paths in the repo or HTTPS
  URLs. Validation runs in the main process (Ajv compiles schemas to
  functions, which the renderer's CSP forbids); a broken or unreachable
  schema only disables the help, with a warning in the app's log.
- **Image manager** on `images` (default: `image.source`) and **file manager**
  on `files` (documents the site links to, published as is from under
  `kirigami.root`). In both, the client can create, rename, and delete
  **subfolders** to organize their media.
- Everything else in the repo is invisible in the app.
- Discovery (reading PHPDOC headers) happens in the app, in `src/main/scope.js`.
  Running it through the site's PHP runtime was the first idea, but that needs
  the site's dependencies installed before the file list can even show. The
  rules are small, so they are ported to JS instead, each one pointing at its
  source: core's `isPage()` (a `_*.php` with no `_`-prefixed folder under
  `kirigami.root`), php-prepros's `FS::parseDocBlock()` (first doc comment,
  `@tag value`, indented continuations), and its `page_info` hook (a
  `.md`/`.yaml`/`.yml`/`.json` value that isn't a URL, resolved against the
  page's folder). Tests pin the behavior; if php-prepros changes these rules,
  `scope.js` must follow. Layout files are not pages, so data they load (a
  menu) needs an `include` entry.
- Core gotcha found while adding the block: `kirigami.yaml` is loaded by
  `struct-walker`, which replaces any value naming an existing `.yaml`/`.json`
  file with that file's content. The core now re-reads `studio:` with a plain
  YAML parse so its paths stay paths.

**Limit:** the scope is enforced by the app, not by GitHub. The App token can
write anywhere in the repo. Server-side enforcement is an optional later phase
(see phase 7).

### 4. Preview: the real render, in a worker

- Electron's `utilityProcess.fork()` runs the `Project` API with the synced +
  draft tree as its cwd. That's the same model as the VS Code extension worker:
  one project per process, cwd set before core is imported.
- The preview pane shows the page being edited, served by `project.serve()`,
  reloading on each save.
- The site's own `node_modules` (canva, plugins, sass/esbuild) are installed by
  the app itself from the repo's `package-lock.json`: fetch each registry
  tarball listed there, check its integrity, extract it. No npm on the client's
  machine. Validated in phase 0; re-run only when the lockfile changes, with
  tarballs cached by integrity hash.
- No external Node either: Electron's bundled Node runs Kirigami directly
  (validated in phase 0), unlike the VS Code extension.

### 5. Images and files

- Both managers show a folder tree: create, rename, move, and delete
  subfolders; drag files between folders. Moving or renaming updates nothing
  automatically in content files, so it warns when something references the
  old path (and later could offer to fix the references).
- Files (documents): any type the site can serve; cap the size per file (same
  cap as publish, e.g. 25 MB) and suggest a video host for video.
- Drag and drop into the image manager; **downscale only oversized originals**
  (e.g. > 3000 px wide) with the browser's canvas, before the file enters the
  draft. Responsive variants and formats are already produced at build time by
  the `image:` block, so the app doesn't duplicate that work.
- Filename normalization (lowercase, ASCII, dashes); rename/delete warn when a
  draft or content file references the image.

### 6. After publish: follow the deploy

Poll the Actions run triggered by the commit (`actions: read`) and show
"Publishing… → Online" with a link to the live page, or a plain-language
failure with a "send to support" button that copies the run URL.

### 7. UI stack

Vanilla ES modules + **`@kirigami/canva`** for styling (dogfooding; anything
generic found along the way gets lifted into canva). CodeMirror 6 for the
Markdown/YAML editors. Reconsider a small framework only if the UI outgrows
this. Layout follows the brainstorm mockup: filtered tree on the left, editor
+ live preview in the center, media grid on the right, **Publish** button top
right, sync status bottom left.

### 8. App updates install themselves

The client never downloads a new version by hand, and never sees an "Update
now?" prompt they could get wrong.

- **`electron-updater`, fed by GitHub Releases** on `php-kirigami/kiri-studio`
  (public repo, so no token and no update server). The release workflow
  publishes the installers plus the `latest*.yml` manifests the updater reads.
- **Silent cycle:** check at startup and every few hours, download in the
  background, install **when the app quits** (`autoInstallOnAppQuit`). The next
  launch is the new version. A small "Updated to x.y — what's new" note on
  first launch, dismissable, is the only visible trace.
- **Never interrupt work:** no install while there are unpublished drafts
  and the client is active. Drafts are persisted anyway, so an update can never
  lose them.
- **Per platform:** Windows NSIS updates in place (per-user install, no admin
  prompt); macOS needs the app signed and notarized, or the update is rejected;
  Linux AppImage replaces itself (`.deb` users update through their package
  manager).
- **Channels:** `latest` for clients; a `beta` channel (GitHub pre-releases)
  that the maintainer opts into from a hidden setting, to try a version on
  their own machine before clients get it.
- **Staged rollout** (`stagingPercentage` in the manifest) lets a release reach
  e.g. 20% of installs first; pulling a bad release = deleting it, the updater
  then stays on the previous version.
- **Safety net for the updater itself:** if an update breaks startup, the
  client can reinstall from a plain download link, and drafts survive because
  they live in `userData`, not in the app folder.

Two update flows are independent, and the client sees neither:

- **The app** (Electron, UI, installer logic): updated by the above.
- **Kirigami itself** (core, plugins, canva): not bundled in the app. Each site
  pins its own versions in its `package-lock.json`, and the app installs what
  the lockfile says (design choice 4). A site gets a newer Kirigami when its
  maintainer bumps and pushes the lockfile; the app picks it up on next sync.
  So an app update can't break a site's rendering, and a site upgrade needs no
  app release.

## Phases

### Phase 0 — Spikes (validate the risky parts before building)

1. ✅ PHP-WASM (JSPI) under Electron's bundled Node in a `utilityProcess`.
2. ✅ GitHub App + device flow (sign-in part; the installation/repo listing
   still needs the App installed on a test repo).
3. ✅ Publishing through the API: size limits and concurrent-change detection.
4. ✅ Dependency install without npm, on `template-demo` (Windows only so far).
5. ✅ Spikes 1 and 4 re-run on macOS (arm64 + x64) and Linux (x64 + arm64) in
   a GitHub Actions matrix.

Spikes 2 and 3 need the GitHub App registered and a throwaway test repo.

#### Findings (2026-09-29, Windows x64)

**Spike 1 — Kirigami inside Electron: works as is.** Electron 44.4.5 (Node
24.21.0, V8 15.2): JSPI is on by default and `node:sqlite` loads, so no flags
and no external Node. A `utilityProcess.fork()` worker with the site as `cwd`
imports the site's own `@kirigami/kirigami`, then `load()` + `build()` on
a copy of `template-demo` succeeds: prepros render (13 files, real PHP output),
esbuild, and sass. About 5–7 s for a full build including the PHP boot.
`project.serve()` works too: after an edit to `src/about/_about.md` (a
Markdown file of the kind a client would edit), the watcher rebuilt it and
the served page showed the change 0.6 s later. `@parcel/watcher`'s native
binary loads fine in the utility process.

Dev gotcha: VS Code's integrated terminal sets `ELECTRON_RUN_AS_NODE=1`, which
makes `electron .` run as plain Node (`electron --version` then prints the Node
version). Unset it when launching Electron from there.

**Spike 2 — sign-in: works.** The org's App is registered (App ID 5118902,
client ID `Iv23lioowQVMtYGG2LsY`, device flow on, token expiration off). A
~30-line Node script: `POST /login/device/code` with only the client ID, show
the user code, poll `/login/oauth/access_token`. The user approves on
github.com/login/device, then the script gets a `bearer` token with **no expiry
and no refresh token**, as intended, and `GET /user` works. `GET
/user/installations` returns the installations the user can see (empty until
the App is installed somewhere). No secret anywhere in the client.

**Spike 3 — publish: works, through the Git Data API.** Run on the private
throwaway repo `php-kirigami/kiri-studio-sandbox` (a copy of `template-demo`,
with the App installed on it only), using the device-flow user token:

- `GET /user/installations` + `/user/installations/{id}/repositories` lists
  exactly the sandbox, with `push: true`: the project list works.
- `createCommitOnBranch`: a text edit + an image in one commit works (1.3 s).
  A stale `expectedHeadOid` returns a clean `STALE_DATA` error. But **5 MB of
  file content passes and 5.5 MB fails** (HTTP 499 after ~5 s, repeatable),
  whether it's one file or several. Too low for photos.
- Git Data API (blobs → tree → commit → `PATCH` ref, `force: false`): a 20 MB
  file publishes in 25 s. A commit built on an old head is refused at the ref
  update with `422 Update is not a fast forward`, the conflict signal Kiri
  Studio needs. Deleting files in the same call works (`sha: null` tree
  entries). A 60 MB blob upload failed with a spurious 401 after 59 s; the
  image downscaling makes that size irrelevant, but the publish step should
  cap single files (e.g. 25 MB) and retry uploads.
- Commits are authored by the signed-in user, so the history shows who
  published what.
- Actions: `GET /actions/runs?head_sha=` finds the deploy run of a publish.
  Its run showed `cancelled` because later test commits superseded it (the
  workflow cancels in-progress runs). Deploy tracking must therefore follow
  the latest run on the branch, and say "Online" once a run that includes
  the publish succeeds.

**Spike 4 — install without npm: works.** About 50 lines (Node builtins + core's
`bin/libs/tar.js`): read `package-lock.json` v3, skip entries whose `os`/`cpu`
don't match the machine (36 of 105), fetch the 69 others from their `resolved`
URL, check the `integrity` SHA-512, extract with the `package/` prefix
stripped. 22 MB downloaded in 11 s (8 parallel fetches); 78 MB on disk. The
Electron build and serve spikes above then pass on that tree.

- Install scripts are **not** run, and don't need to be: the two packages that
  have one (`esbuild`, `@parcel/watcher`) find their prebuilt binary in the
  platform-specific optional package the lockfile already lists.
- macOS/Linux: core's `parseTar()` doesn't return file modes, so extracted
  binaries (esbuild's) wouldn't be executable. Fixed in the spike by reading the
  mode from the tar header (`readOctal(100, 8)`) and writing files with the
  exec bit kept (5 executables in `template-demo`'s tree).
- Linux: the lockfile's `libc` field must be honored too (glibc vs musl
  variants), detected from `process.report`.
- Requires the site repo to commit its `package-lock.json` (templates already
  do). A repo without one gets a clear maintainer-facing error.
- Guard every extracted path against escaping its package folder.

**Spike 5 — all client platforms: works.** The `Spike (cross-platform)`
workflow in `php-kirigami/kiri-studio-sandbox` runs, on each OS, the npm-less
install (with Electron itself as the Node, `ELECTRON_RUN_AS_NODE=1`), then a
build and a serve + live-edit in a `utilityProcess`. All green on
`windows-latest` (x64), `macos-latest` (arm64), `macos-15-intel` (x64),
`ubuntu-latest` (x64), and `ubuntu-24.04-arm` (arm64): 69 packages installed
(~22 MB) in 1–5 s, esbuild binary executable, full build in 1.4–4 s, live
edit visible 0.3–0.45 s after saving. Linux runs Electron under `xvfb-run`
with `--no-sandbox` (CI only).

**Phase 0 outcome: no blocker.** Every risky part works on every client
platform. Known follow-ups carried into phase 1: tar file modes in core, the
`studio:` schema block, single-file size cap + upload retries on publish.

### Phase 1 — Foundations

- ✅ Register the Kiri Studio GitHub App on `php-kirigami`; create the
  `php-kirigami/kiri-studio` repo and move this plan there.
- Release the core with `studio:` and `internal/tar` (next `@kirigami/kirigami`
  version) so sites and Kiri Studio can use them.
- Kiri Studio starts with its own worker, adapted from the VS Code extension's
  (process spawn, message protocol, runtime staging). If both stay alike,
  extract a published shared package later, not up front.
- ✅ In this monorepo: `parseTar()` returns each entry's `mode` and is exported
  as `@kirigami/kirigami/internal/tar`, so Kiri Studio reuses it.
- ✅ In this monorepo: the `studio:` block in `kirigami.schema.json`, with
  tests, documented in the core README. Ships with the next core release.
- After that release: add a `studio:` block to `template-demo` (validated
  locally on a copy: the build ignores it) and, where useful, move page
  content into `.yaml`/`.md` files so clients can edit it.

### Phase 2 — App skeleton

- ✅ Electron with `contextIsolation`, `sandbox`, no `nodeIntegration`, a
  narrow preload API (`src/preload/index.cjs`), a strict CSP, no navigation.
- ✅ Sign in (device flow; code copied and GitHub opened for the client;
  token in `safeStorage`), site list (App installations × push access ×
  `studio:` block), reopening the last site directly (or the only one),
  tarball sync on open (skipped when the branch head hasn't moved; falls back
  to the last copy when offline), and the filtered tree: discovered content,
  collections, image and document folders.
- ✅ French/English UI, following the OS language.
- ✅ Verified against `kiri-studio-sandbox` (screenshots of the sign-in,
  workspace, and an open file), with unit tests for discovery and archive
  extraction. Content is shown read-only until phase 3.
- Not yet: the sign-in round trip was only tested through the spike script,
  not by clicking through the app; offline fallback untested; a first launch
  shows no progress while the site list loads.

### Phase 3 — Editing

- ✅ Markdown editor: CodeMirror 6, Markdown styled in place (bigger
  headings, bold, colored links; syntax marks kept but muted), a toolbar
  (title, subtitle, bold, italic, link, lists, quote) with Ctrl/⌘+B/I/K,
  spellcheck. The source is saved as typed: no reformatting, clean diffs.
- ✅ Persisted drafts (`src/main/drafts.js`): autosave half a second after
  typing stops, and on leaving a file, switching site, signing out, or
  closing the window (the main process waits for the renderer's flush, up to
  3 s). Drafts live apart from the synced copy, survive restarts and syncs,
  and record the sha-256 of the file they started from for phase 4's
  conflict check. Typing the original back drops the draft. Changed files get
  a dot in the sidebar, the status bar counts them, and "Undo my changes"
  discards one file's draft after a confirmation.
- The renderer is now bundled with esbuild (`npm run build`, run by
  `npm start`) into `build/renderer/`: CodeMirror's packages import each other
  by name, which a `file://` page with a strict CSP can't resolve.
- ✅ YAML/JSON editor (`src/renderer/data-editor.js`, `yaml-indent.js`;
  checks in `src/main/validate.js`) with schema help, as described in design
  choice 3. Line endings are kept as found (both editors), so saving a CRLF
  file doesn't rewrite every line. Checked on humainhumain (first test
  client) through `KIRI_STUDIO_LOCAL_SITE`: its `.vscode/settings.json`
  schemas are picked up with no extra config; it needs
  `exclude: [src/_data/*/schema.json]` (JSON-LD files, not content).
- The CSP allows inline styles and `data:` images: CodeMirror sets style
  attributes and draws lint markers as data-URI SVGs. Scripts stay `'self'`.
- ✅ Image and document managers (`src/main/media.js`,
  `src/renderer/media-view.js`): one sidebar entry each, folders browsed in
  the main area (breadcrumb, folder tiles, thumbnails). Add by drag and drop
  or a button; photos over 2560 px on their long side are downscaled in the
  renderer (canvas, EXIF orientation applied, same format), smaller files
  keep their bytes; 25 MB cap per file. Names are made safe
  (`Été 2026 (1).JPG` → `ete-2026-1.jpg`) and never overwrite
  (`-2`, `-3`…). Create, rename, and delete files and folders; renaming or
  deleting warns when a content file mentions the name. Everything is a
  draft: drafts now hold binary files and deletions, a rename is a delete
  plus an add, and a new folder holds a hidden `.gitkeep` (Git keeps no
  empty folders). Thumbnails come from a `studio-media:` protocol serving
  the client's current version of media files only (SVGs sandboxed by
  their own CSP). `exclude` also hides media subfolders (e.g. a plugin's
  cache).
- ✅ Images: a click opens a full-size viewer (dimensions, size, ←/→ through
  the folder, Esc); "Copy code for a page" (viewer and tile menu) copies
  `{% img-asset <path> <width> %}`, php-prepros's Markdown image tag, with the
  path relative to `image.source` and `studio.imageWidth` (default 800); the
  Markdown toolbar's Image button opens a picker and inserts that code as
  its own paragraph.
- ✅ CI (`.github/workflows/test.yml`): unit tests and `npm run smoke` on
  Windows, macOS, and Linux; smoke runs the real app on the fixture site in
  several scenarios and fails on a missing screen or any renderer error.
- ✅ Collections (`src/main/collections.js`): files listed live with drafts
  laid over the synced copy, labeled by their first Markdown heading. With
  `create: true` and a `<folder>/*.<ext>` pattern, "+" creates a file from a
  title (safe, unique name; a Markdown file starts with that title as its
  heading) and opens it; "Delete this page" removes one (a never-published
  file just goes away). New files get their schema like any data file.
- ✅ `test/fixtures/site`: a small Kirigami site (Markdown, YAML with a
  schema, a creatable blog, images, documents) for tests and local runs;
  `KIRI_STUDIO_LOCAL_SITE` opens it without a GitHub account.

### Phase 4 — Publish

- `createCommitOnBranch`, message generated from the changed labels.
- Concurrent change: re-sync, re-apply the drafts, and retry silently. If the
  remote change touched a file the client also edited, **the client's version
  wins** and the app never asks. The overwritten version stays in the Git
  history, so the maintainer can always recover it, and the maintainer is
  notified (commit message note). A "which version do you keep?" dialog is
  exactly the kind of decision a client shouldn't have to make.
- Deploy tracking (design choice 6).

### Phase 5 — Live preview

- Worker running `Project` on the draft tree, preview pane, dependency
  strategy chosen in phase 0.

### Phase 6 — Distribution

Unsigned part done (see the handoff at the top); signing waits for clients.
Windows ships x64 only: an arm64 entry makes electron-builder put both
architectures in one installer, and Windows on Arm runs x64 emulated.

- Clients are on **Windows, macOS, and Linux**, so all three are first-class
  targets from v1: Windows x64 (+ arm64), macOS arm64 + x64, Linux x64.
- electron-builder installers (NSIS `.exe`, `.dmg`, AppImage + `.deb`),
  auto-update from GitHub Releases (`electron-updater`), a release workflow
  building each target on its own runner, like the VSIX one.
- Code signing, required for "seamless" (otherwise: SmartScreen warnings on
  Windows, and on macOS Gatekeeper blocks the app outright):
  - **macOS:** Apple Developer Program (USD 99/year), Developer ID certificate,
    notarization in the release workflow. Not optional; also required for
    auto-update on macOS.
  - **Windows:** a signing service (e.g. Azure Trusted Signing) or an OV/EV
    certificate.
  - **Linux:** no signing needed; AppImage auto-updates through
    `electron-updater`.
- The UI must be tried on all three (fonts, title bar, file drop, keychain
  prompts for `safeStorage` on Linux).
- Crash-safe first run, FR/EN strings, a short client-facing guide.

### Phase 7 — Later

- Server-side scope enforcement: publish to a branch, and a check action
  (kiribuild-like) that rejects paths outside `studio:` before auto-merge.
- History / "undo a publish" from the commit list.
- LFS support, multiple editors per site, per-client branding.

## Settled (2026-09-29)

- **Every client has their own GitHub account.** Publishing is done as the
  client (their name on the commit), which needs an account. No invite-link
  backend; the maintainer helps the client create the account when onboarding
  them.
- **Public app, GPL-3.0** like the core: public releases on
  `php-kirigami/kiri-studio`, usable by any Kirigami maintainer for their own
  clients through the org's GitHub App.
