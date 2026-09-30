# MD Reader

A super-fast, native markdown **reader** for macOS and Windows. Open a single file or a whole
folder of notes and documentation and just read — no editor chrome, no Electron.

<!-- TODO: screenshots
![MD Reader — light](docs/screenshots/light.png)
![MD Reader — dark, folder sidebar](docs/screenshots/dark-folder.png)
-->

## Features

- **Fast**: markdown is parsed, highlighted and sanitized in Rust; the UI is a small vanilla-JS
  page in the OS webview (WKWebView / WebView2). Heavy libraries load only when a document
  needs them. Small (about 11 MB per CPU architecture) and quick to start.
- **GitHub-flavoured markdown**: tables, task lists, footnotes, alerts (`> [!NOTE]`), emoji
  shortcodes, heading anchors, front matter, description lists, `==highlight==`, spoilers.
- **Syntax highlighting** for a wide range of languages, **math** (KaTeX, incl. mhchem), **Mermaid**
  diagrams, Obsidian-style callouts, `[TOC]` — via [plugins](docs/PLUGINS.md), which you can
  extend with your own.
- **Folders**: open a folder to get a sidebar with all its markdown files, quick open
  (<kbd>⌘/Ctrl</kbd>+<kbd>P</kbd>), relative links between documents, back/forward.
- **PDF and HTML previews**: PDF and HTML files show up in the folder sidebar and open in the
  reader (also from links in markdown). PDFs use the system's PDF viewer; HTML pages run their
  own JavaScript, like a local file in a browser, but sandboxed — no access to the app, the OS,
  or files outside the page's own folder. Previews are not included in PDF exports.
- **Outline** of the current document, find in page, zoom, light/dark/system theme.
- **Live reload** when a file changes on disk (works with editors that save atomically).
- **Export to PDF** — a markdown document or all markdown in a folder, with paged layout and an outline.
- **OS integration**: registers for `.md .markdown .mdown .mkd .mkdn .mdwn .mdx`, opens files and
  folders dropped on the Dock icon, *Open in MD Reader* in the Finder (Services / Quick Actions)
  and Explorer (right-click) context menus.

## Install

- **macOS 11+** (universal: Apple Silicon & Intel): **[Download MD Reader 0.1.0 for macOS](binaries/MD-Reader-0.1.0-universal.dmg?raw=true)**
  (14 MB, signed and notarized) — open the DMG and drag MD Reader to Applications.
  SHA-256: `17036eff7ce4eccdd49373c3a0c29b3313af7fc68746b063e1767b6096f421e2`
- **Windows 10/11**: `MD Reader_<version>_x64-setup.exe` — per-user install, no admin rights needed.

See **[docs/INSTALL.md](docs/INSTALL.md)** for making it the default markdown app, enabling the
Finder service and the Windows context-menu entries.

## Keyboard shortcuts

<kbd>⌘</kbd> on macOS, <kbd>Ctrl</kbd> on Windows.

| Action | Shortcut |
|---|---|
| Open file / folder | <kbd>⌘</kbd><kbd>O</kbd> / <kbd>⌘</kbd><kbd>⇧</kbd><kbd>O</kbd> |
| Go to file (quick open) | <kbd>⌘</kbd><kbd>P</kbd> |
| New window | <kbd>⌘</kbd><kbd>N</kbd> |
| Find / next / previous | <kbd>⌘</kbd><kbd>F</kbd> / <kbd>⌘</kbd><kbd>G</kbd> (<kbd>F3</kbd>) / <kbd>⌘</kbd><kbd>⇧</kbd><kbd>G</kbd> (<kbd>⇧</kbd><kbd>F3</kbd>) |
| Back / forward | <kbd>⌘</kbd><kbd>[</kbd> / <kbd>⌘</kbd><kbd>]</kbd> (Windows also <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd>) |
| Toggle sidebar / outline | <kbd>⌘</kbd><kbd>\\</kbd> / <kbd>⌘</kbd><kbd>⇧</kbd><kbd>\\</kbd> |
| Zoom in / out / reset | <kbd>⌘</kbd><kbd>=</kbd> / <kbd>⌘</kbd><kbd>-</kbd> / <kbd>⌘</kbd><kbd>0</kbd> |
| Toggle dark mode | <kbd>⌘</kbd><kbd>⇧</kbd><kbd>D</kbd> |
| Reload | <kbd>⌘</kbd><kbd>R</kbd> |
| Export as PDF / folder as PDF | <kbd>⌘</kbd><kbd>E</kbd> / <kbd>⌘</kbd><kbd>⇧</kbd><kbd>E</kbd> |
| Plugins… | <kbd>⌘</kbd><kbd>,</kbd> |
| Close window | <kbd>⌘</kbd><kbd>W</kbd> |

## Plugins

Rendering extras (Mermaid, math, callouts, TOC, diff colouring, Lionsville business cases) are plugins; you can switch them
off or drop your own `.js` plugin into the plugins folder. See **[docs/PLUGINS.md](docs/PLUGINS.md)**.

## Build from source

Prerequisites: [Rust](https://rustup.rs) (stable), Node.js 20+, and the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS
(Xcode Command Line Tools on macOS; MSVC Build Tools + WebView2 on Windows).

```sh
npm ci                 # CLI + vendored libraries (mermaid, katex, pagedjs)
npm run dev            # run in development mode (copies vendor libs, then `tauri dev`)
npm run build          # release build + installers for the current OS
```

Platform scripts (with optional signing — see [docs/SIGNING.md](docs/SIGNING.md)):

```sh
scripts/build-mac.sh              # macOS universal .app + .dmg
scripts/build-mac.sh --native     # only this Mac's architecture (faster)
```
```powershell
.\scripts\build-windows.ps1       # Windows NSIS installer (x64; -Arch arm64 for ARM)
```

Universal macOS builds need both targets: `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
Output lands in `src-tauri/target/[<target>/]release/bundle/`.

Rust checks: `cd src-tauri && cargo test && cargo clippy`. CI runs these on every push
(`.github/workflows/ci.yml`); tagging `v*` builds draft releases (`release.yml`).

Icons are generated from the SVGs in `scripts/icons/` with `scripts/icons/build-icons.sh` (macOS).

## Architecture

Tauri 2 app: Rust core (`src-tauri/src`) + vanilla JS UI (`ui/`, no bundler). See
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the layout, the Rust command API and the
performance rules.

## License

[AGPL-3.0-only](LICENSE) © 2024–2026 Lionsville Group BV
