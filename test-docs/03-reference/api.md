---
title: API reference
status: draft
updated: 2026-09-29
---

# API reference

## Commands

### `render_file(path, idPrefix?)`

Returns the rendered document:

```ts
interface RenderedDoc {
  path: string;
  dir: string;
  title: string;
  html: string;
  headings: { level: number; text: string; id: string }[];
  frontMatter: [string, string][] | null;
}
```

### `scan_folder(path)`

Returns a `FolderNode` tree with only markdown files.

## Plugins

A plugin is an ES module:

```js
export default {
  id: 'hello',
  name: 'Hello',
  selector: 'pre > code.language-hello',
  render(root, ctx) {
    for (const el of root.querySelectorAll(this.selector)) {
      el.parentElement.replaceWith(Object.assign(document.createElement('p'), { textContent: 'Hello!' }));
    }
  },
};
```

Back to [the README](../README.md).
