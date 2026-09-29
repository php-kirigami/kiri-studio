# CLAUDE.md

Entry point for working in this repo. Kept short on purpose — detailed,
evolving material lives in `docs/`:

| File | What's in it |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Goal, the client journey, design choices, phases, phase 0 findings |

## What this is

**Kiri Studio**: an Electron desktop app that lets non-technical site owners
edit and publish their Kirigami site (Markdown, YAML data through forms,
images, documents), then publish with one button. GitHub sign-in through the
org's GitHub App (device flow); sync and publish through the GitHub API, no
local Git.

- **Repo:** `php-kirigami/kiri-studio`, public, GPL-3.0-or-later.
- **Sibling of** the `kirigami` monorepo (`../kirigami/`). The app uses the
  published `@kirigami/*` packages; each site's own `package-lock.json` pins
  the Kirigami version that renders it.
- **Throwaway test repo:** `php-kirigami/kiri-studio-sandbox` (private, a copy
  of `template-demo` with the GitHub App installed; holds the phase 0 spike
  workflow).
- **GitHub App:** "Kiri Studio" on `php-kirigami`, App ID 5118902, client ID
  `Iv23lioowQVMtYGG2LsY` (public), device flow on, token expiration off.

## Layout

- `src/main/` — Electron main process (ESM): `index.js` (window + IPC),
  `auth.js` (device flow, token store), `github.js` (REST client),
  `sites.js`, `sync.js` (tarball sync), `scope.js` (what's editable; mirrors
  Kirigami's page and PHPDOC rules), `lib/tar.js` (copy of core's reader).
- `src/preload/index.cjs` — the only renderer API (`window.studio`).
- `src/renderer/` — plain DOM UI: `app.js`, `i18n.js` (FR/EN), `styles.css`
  (rem/em only).
- `test/` — `node --test`. UI checks: smoke screenshots (see README).

## Non-negotiable conventions

- **The client experience comes first.** Seamless for a non-technical person
  overrides technical elegance. No Git words, no file paths, no decisions the
  client can't make confidently. See "The #1 requirement" in
  [docs/PLAN.md](docs/PLAN.md).
- **English everywhere in the repo** (code, comments, docs, commits); the UI
  itself is French and English. **Conversations with the user are in French.**
- **Stay lite**: minimal dependencies, no native deps beyond Electron; check
  for a `node:` builtin first.
- **Windows, macOS, and Linux** are all first-class. Dev machine is Windows
  (PowerShell primary); watch path separators.
- VS Code's terminal sets `ELECTRON_RUN_AS_NODE=1`: unset it to launch
  Electron from there.

## Before you start non-trivial work

Read [docs/PLAN.md](docs/PLAN.md), and the monorepo's `docs/DECISIONS.md`
("Kiri Studio" entry) so you don't re-litigate a settled choice. Keep this
file under 200 lines; split new material into `docs/` by topic.
