<div align="center">

<img src="https://zmotrin.github.io/assets/kirigami/kirigami-logo-universal.svg" alt="Kirigami" width="400" />

---

# Kiri Studio

**The desktop app that lets site owners edit and publish their [Kirigami](https://github.com/php-kirigami/kirigami) site — no Git, no code, one Publish button.**

[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](./LICENSE)
[![Website](https://img.shields.io/badge/website-php--kirigami.github.io-1f6b4a)](https://php-kirigami.github.io)

</div>

---

## Overview

Kiri Studio is for the people a Kirigami site is built *for*: the owner of a
small business site, a blog, a portfolio. They sign in with GitHub once, open
their site, change text, fill in forms, drop in pictures and documents, see the
real page update as they type, and click **Publish**. The site's usual GitHub
Pages workflow does the rest.

The site's maintainer decides what is editable, in the site's own
`kirigami.yaml` (the `studio:` block). Everything else stays out of sight.

Part of the **Kirigami** ecosystem. Windows, macOS, and Linux.

---

## Status

**Early development.** Signing in, finding your sites, keeping them in sync,
and editing text and data files (checked against their JSON Schema, with
changes saved automatically as drafts), and managing images and documents
work; preview and publishing come next. Nothing to install yet. The plan, the design choices, and the
feasibility checks already done (Kirigami running inside Electron, publishing
through the GitHub API, all three platforms) are in [docs/PLAN.md](docs/PLAN.md).

---

## Development

Requires Node.js 24+.

```bash
npm install
npm start      # builds the UI, then launches the app
npm run build  # builds the UI only (build/renderer/)
npm test       # unit tests (node:test)
npm run smoke  # end-to-end: the real app on test/fixtures/site (run npm run build first)
```

npm 12 blocks install scripts unless approved; `package.json` approves
Electron's (it downloads the Electron binary). If `node_modules/electron/dist`
is missing after install, run `node node_modules/electron/install.js`.

`npm start` works from VS Code's terminal: it drops the
`ELECTRON_RUN_AS_NODE` variable that terminal sets.

Environment variables for development and smoke tests:

| Variable | Effect |
|---|---|
| `KIRI_STUDIO_LOCAL_SITE` | Show this local site folder instead of GitHub ones, as a client would see it (no sync). |
| `KIRI_STUDIO_TOKEN` | Use this GitHub token instead of the saved sign-in (never saved). |
| `KIRI_STUDIO_USER_DATA` | Keep settings, sign-in, and synced sites in this folder. |
| `KIRI_STUDIO_LOCALE` | Force the UI language (`fr`, `en`). |
| `KIRI_STUDIO_SCREENSHOT` | Save a PNG of the window once `KIRI_STUDIO_SMOKE_SCREEN` shows, then quit. |
| `KIRI_STUDIO_SMOKE_SCREEN` | Screen to capture: `signin`, `sites`, `workspace` (default), or `entry`. |
| `KIRI_STUDIO_SMOKE_OPEN` | Open this content path, or `media:images` / `media:files`, once the workspace shows (pair with `entry`). |
| `KIRI_STUDIO_SMOKE_ADD` | Local files (separated by `;` on Windows, `:` elsewhere) to add in the opened media manager. |
| `KIRI_STUDIO_SMOKE_VIEW` | Open the first image of the opened media manager in the viewer. |
| `KIRI_STUDIO_SMOKE_TYPE` | Type this text at the end of the opened file and save it as a draft. |

---

## License

[GPL-3.0-or-later](./LICENSE), like the Kirigami core.
