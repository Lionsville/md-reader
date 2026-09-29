# MD Reader plugins

MD Reader turns markdown into HTML in Rust (fast, sanitized, no scripts). **Plugins** then
post-process that HTML in the webview: they turn ```` ```mermaid ```` blocks into diagrams,
typeset math, add a table of contents, and so on. You can write your own in plain JavaScript.

- [Built-in plugins](#built-in-plugins)
- [Installing a plugin](#installing-a-plugin)
- [Writing a plugin](#writing-a-plugin) — [API reference](#api-reference), [the `ctx` object](#the-ctx-object), [lifecycle](#lifecycle)
- [What the rendered HTML looks like](#what-the-rendered-html-looks-like)
- [Debugging](#debugging)
- [Security](#security)
- [For app developers: the host API](#for-app-developers-the-host-api)

## Built-in plugins

Every built-in can be switched off in **Plugins…** (toolbar button, or *MD Reader → Plugins…* / <kbd>⌘</kbd><kbd>,</kbd> on macOS).
They cost nothing on documents that don't use them: the plugin's module is only fetched when
its selector finds something, and a heavy library only when there is something to render.

| id | What it does | Markdown |
|---|---|---|
| `mermaid` | Diagrams with [Mermaid](https://mermaid.js.org) 12 (flowchart, sequence, class, state, ER, Gantt, pie, mindmap, timeline, …). Follows the light/dark theme; PDF export always uses the light theme. Syntax errors are shown inline with the source. | ```` ```mermaid ```` (or ```` ```mmd ````) |
| `math` | TeX math with [KaTeX](https://katex.org), including `\ce{}`/`\pu{}` chemistry (mhchem, loaded only when used). Macros defined with `\gdef`/`\newcommand` carry over within a document. Errors are shown in red in place. | `$inline$`, `$$display$$`, `` $`inline`$ ``, ```` ```math ```` |
| `callouts` | Obsidian-style callouts: `> [!info]`, `> [!todo]`, `> [!success]`, `> [!question]`, `> [!failure]`, `> [!danger]`, `> [!bug]`, `> [!example]`, `> [!quote]`, … with an optional title. `-` / `+` after the type makes it foldable (collapsed / expanded) — this also works for the GitHub types. | `> [!faq]- Why?` |
| `toc` | Replaces a paragraph that contains only a TOC marker with a linked, nested table of contents of the document's headings (a single leading `# Title` is left out). | `[TOC]`, `[[_TOC_]]`, `[[TOC]]`, `${toc}` |
| `diff` | GitHub-style full-line colors for diffs: additions, deletions, hunk headers, file headers. | ```` ```diff ````, ```` ```patch ```` |

GitHub alerts (`> [!NOTE]` … `> [!CAUTION]`), footnotes, task lists, emoji shortcodes and
heading anchors are handled by the Rust renderer and need no plugin.

## Installing a plugin

1. Open **Plugins…** and click **Open plugins folder**. The folder is
   - macOS: `~/Library/Application Support/nl.lionsville.mdreader/plugins`
   - Windows: `%APPDATA%\nl.lionsville.mdreader\plugins`
   - Linux: `~/.config/nl.lionsville.mdreader/plugins`
2. Copy the plugin's `.js` (or `.mjs`) file into it. Each `*.js`/`*.mjs` file **directly in that
   folder** is loaded as a plugin; put helper modules, data or CSS in a sub-folder
   (e.g. `plugins/my-plugin/`) and import them relatively.
3. Click **Reload plugins**. The plugin appears under *User plugins*, where you can switch it off.

Two ready-to-use examples live in [`docs/examples/plugins/`](examples/plugins/):

- [`timeline.js`](examples/plugins/timeline.js) — renders ```` ```timeline ```` blocks (`2024-06: Released`
  per line) as a vertical timeline.
- [`reading-time.js`](examples/plugins/reading-time.js) — shows "1,234 words · 6 min read" below
  the title of every document.

## Writing a plugin

A plugin is an **ES module** whose default export is a plugin object:

```js
// shout.js — uppercases ```shout code blocks
export default {
  id: 'shout',
  name: 'Shout',
  description: 'Uppercases ```shout blocks.',
  version: '1.0.0',
  selector: 'pre > code.language-shout',
  styles: `.shout { font-weight: 700; letter-spacing: .05em; }`,

  render(root, ctx) {
    for (const code of root.querySelectorAll(this.selector)) {
      if (!ctx.claim(code)) continue;           // already done on a previous run
      const p = document.createElement('p');
      p.className = 'shout';
      p.textContent = code.textContent.toUpperCase();
      ctx.codeBlock(code).replaceWith(p);       // replace the whole code block
    }
  },
};
```

### API reference

| field | type | |
|---|---|---|
| `id` | string | Identifier, e.g. `'timeline'`. Informational for user plugins: the host identifies a user plugin as `user:<file name without extension>`. |
| `name` | string | Shown in the plugin manager and in error messages. |
| `description` | string? | One line for the plugin manager. |
| `version` | string? | Shown in the plugin manager. |
| `selector` | string? | CSS selector. `render` is only called when `root.querySelector(selector)` matches. **Strongly recommended** — without it the plugin runs on every document. |
| `match` | `(root) => boolean`? | Extra test after `selector` matched, for things CSS can't express (e.g. text content). Must be cheap and synchronous. |
| `styles` | string? | CSS injected once (as a `<style>`), the first time the plugin renders something. Removed when the plugin is disabled. |
| `render` | `(root, ctx) => void \| Promise` | Does the work. May be `async`; the host waits for it (PDF export paginates only after every plugin finished). |

### The `ctx` object

`render` receives `ctx` with the context of the current document plus helpers:

| member | |
|---|---|
| `ctx.mode` | `'reader'` or `'export'` (PDF export window). |
| `ctx.theme` | `'light'` or `'dark'` — the current reader theme. In export mode, prefer light output. |
| `ctx.docPath` | Absolute path of the markdown file (may be empty). |
| `ctx.docDir` | Its directory. |
| `ctx.root` | The element being processed (same as the `root` argument). |
| `ctx.pluginId` | This plugin's id (`user:<file>` for user plugins). |
| `ctx.claim(el)` | Marks `el` as processed by this plugin (`data-mdr-processed` attribute) and returns `true`, or returns `false` if it already was. The way to stay idempotent. |
| `ctx.isClaimed(el)` | Whether `el` was already claimed by this plugin. |
| `ctx.codeBlock(el)` | The outermost element of the code block containing `el`: the reader's `.code-block` wrapper (language label + copy button) when present, else the `<pre>`. Replace *this* when you turn a code block into something else. |
| `ctx.showError(el, error, {title?, source?, replace?})` | Shows a standard inline error box before `el` (or instead of it with `replace: true`), with an optional collapsible source. Returns the box. |
| `ctx.loadScript(url)` | Adds a classic `<script>` once (deduplicated by URL); resolves when it has run. For UMD libraries that define a global. |
| `ctx.loadStyle(url)` | Adds a stylesheet `<link>` once; resolves when loaded. |
| `ctx.vendorUrl(path)` | URL of a library bundled with the app: `ctx.vendorUrl('katex/katex.min.js')` (a leading `vendor/` is optional). Bundled: `mermaid/mermaid.min.js`, `katex/katex.min.js`, `katex/katex.min.css`, `katex/mhchem.min.js`. |
| `ctx.appUrl(path)` | URL of any file shipped with the app UI, e.g. `ctx.appUrl('css/markdown.css')`. |
| `ctx.localUrl(absPath)` | URL through which the webview can load a local media file (image, video, audio, font), e.g. an image next to the document. |
| `ctx.resolvePath(rel)` | Resolves a path relative to `ctx.docDir`. |
| `ctx.yieldToMain()` | Promise that lets the browser paint / handle input. Call it every ~10 ms in long loops. |
| `ctx.escapeHtml(str)` | Escapes `& < > " '` for building HTML strings. |

URLs of files that belong to your own plugin: use `new URL('./my-plugin/lib.js', import.meta.url)`.
ES imports of sibling files work the same way (`import x from './my-plugin/x.js'`).

### Lifecycle

1. **Discovery** — after the reader window is shown, the host asks Rust for the files in the
   plugins folder and imports the enabled ones in the background (disabled plugins are never
   imported, so their code doesn't run at all). Top-level code in your module runs once per window.
2. **Run** — each time a document is displayed, `runPlugins(root, ctx)` runs every enabled plugin
   whose `selector` (and `match`) finds something in the document. Plugins run **concurrently**;
   don't depend on another plugin's output. Built-ins start immediately; user plugins start as
   soon as they're imported.
3. **Re-run** — the reader may run plugins **again on the same, already processed root**, e.g.
   after switching between light and dark theme. So `render` must be **idempotent**: use
   `ctx.claim(el)` (or your own marker) and skip work that's done. Theme-dependent output should
   remember the theme it was made for and redo only that (the mermaid plugin keeps the diagram
   source in `data-mdr-source` and the theme in `data-mdr-theme`).
4. **Reload / toggle** — *Reload plugins* re-imports the plugin files (edits to files that are
   imported by your plugin may need a window reload: <kbd>Cmd/Ctrl</kbd>+<kbd>R</kbd>). Toggling a
   plugin fires a `mdr:plugins-changed` event on `window`; the reader re-renders the document.

Rules of thumb:

- **Performance is the point of this app.** Keep the module tiny and load libraries lazily inside
  `render`, only when needed. Cache the loading promise in a module-level variable.
- Read text with `textContent` (code blocks are either plain escaped text or syntax-highlighted
  `<span class="hl-…">` — `textContent` gives the source in both cases).
- Never put document text into `innerHTML` unescaped — markdown files come from anywhere.
- Throwing is fine: the host catches it, logs it, shows a *Plugin "…" failed* box in the document
  and in the plugin manager, and the document stays readable. For errors that belong to a single
  block (a syntax error in a diagram), prefer `ctx.showError(block, err, {source, replace: true})`.
- A plugin that takes more than 30 seconds is reported as failed (the PDF export continues).
- Use `-webkit-print-color-adjust: exact` for backgrounds that must survive PDF export, and
  `break-inside: avoid` for things that shouldn't be split across pages.

### Theme colors

Use the document's CSS custom properties so your output matches both themes, e.g.
`var(--md-text)`, `var(--md-muted)`, `var(--md-border)`, `var(--md-link)`, `var(--md-code-bg)`,
`var(--md-bg)`, `var(--md-note|tip|important|warning|caution)` (see `ui/css/markdown.css`), or
scope rules with `:root[data-theme="dark"] …`. Always give a fallback: `var(--md-muted, #59636e)`.

## What the rendered HTML looks like

The Rust renderer (comrak + syntect + ammonia) produces:

- Code blocks: `<pre><code class="language-xyz">…</code></pre>` (the language is the first word of
  the info string). In the reader each `<pre>` is wrapped in `<div class="code-block" data-lang>`.
- Math: `<span data-math-style="inline|display">tex</span>`, `<code data-math-style="inline">` for
  `` $`…`$ ``, `<pre><code class="language-math" data-math-style="display">` for ```` ```math ````.
- Headings: `<h2 id="slug">Text<a class="anchor" href="#slug"></a></h2>`.
- GitHub alerts: `<div class="markdown-alert markdown-alert-note"><p class="markdown-alert-title">`.
- Wikilinks: `<a href="Page" data-wikilink="true">`.
- Local images/media point at `mdr://localhost/<abs path>` (macOS/Linux) or
  `http://mdr.localhost/<C:/abs/path>` (Windows).
- The HTML is sanitized: no `<script>`, no `<style>`, no event handlers, `data-*` attributes are
  kept. So raw HTML in markdown like `<div class="my-widget" data-x="1"></div>` survives and can be
  picked up by a plugin selector.

## Debugging

- Errors show inline in the document and in **Plugins…** next to the plugin (with the message).
- The Web Inspector is available in development builds (`npm run tauri dev`, then right-click →
  *Inspect Element*). Host messages are prefixed with `[plugins]`.
- In the console: `(await import('./js/plugins.js')).listPlugins()` shows every plugin, whether it
  is enabled/loaded, and its last error.
- Syntax errors in your module show up as *Failed to load: …*. A file without a default export,
  or without a `render` function, is reported the same way.
- Edit your file, click **Reload plugins** in the plugin manager, and the document re-renders with
  the new code.

## Security

- **User plugins run with the same privileges as the app UI.** They can read any file the app can
  read and call the app's commands. Only install plugins from sources you trust, and read the code
  of plugins you download.
- Only `.js`/`.mjs`/`.css` files **inside the plugins folder** can be loaded as code; a markdown
  document can never inject a script (its HTML is sanitized in Rust, and the Content-Security-Policy
  only allows scripts from the app itself and the plugins folder).
- The CSP also means plugins **can't load scripts from the internet** (no CDNs) and can't use
  `eval`/`new Function`. Bundle what you need next to the plugin (as ES modules or classic scripts
  in a sub-folder of the plugins folder; data as a `.js` module). `fetch` is limited to the app itself
  and the `mdr:` protocol, which serves local media and the plugin folder's `.js`/`.css` only.
- Built-in plugins can be disabled individually; mermaid runs with `securityLevel: 'strict'` and
  KaTeX with `trust: false`.

## For app developers: the host API

`ui/js/plugins.js`:

```js
loadPlugins()                    // registers built-ins, lists + imports enabled user plugins in the background; cheap, idempotent
runPlugins(root, {mode, theme, docPath, docDir?})   // resolves when every plugin finished; errors are isolated
listPlugins()                    // [{id, name, description, version, builtin, enabled, loaded, error, source}]
setPluginEnabled(id, enabled)    // persisted in localStorage 'mdr.plugins.disabled'; fires 'mdr:plugins-changed'
reloadPlugins()                  // re-scan the folder and re-import user plugins; fires 'mdr:plugins-changed'
pluginsReady()                   // resolves when all enabled user plugins are imported
onPluginsChanged(cb)             // subscribe (returns unsubscribe)
```

`ui/js/plugin-manager.js`: `showPluginManager()` opens the modal dialog.

The reader should call `runPlugins` after inserting a document, again after a theme change (only
theme-dependent output is redone), and re-render the document on `mdr:plugins-changed`. Runs on
the same root are serialized. The export window awaits `runPlugins(root, {mode: 'export', …})`
before paginating.
