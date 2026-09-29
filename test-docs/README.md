---
title: MD Reader Demo Docs
author: The MD Reader team
version: 1.0
tags: demo, fixtures, markdown
---

# MD Reader Demo Docs

![MD Reader logo](assets/logo.svg)

Welcome! This folder is both the **test fixture** and the **demo** for MD Reader. Open it as a folder
(`md-reader test-docs`) to try the sidebar, outline, quick open (<kbd>⌘</kbd> <kbd>P</kbd>), find
(<kbd>⌘</kbd> <kbd>F</kbd>) and live reload.

> [!TIP]
> Edit any file in this folder while it is open — the reader refreshes instantly and keeps your scroll position.

## Contents

1. [Installation](01-getting-started/01-installation.md)
2. [First steps](01-getting-started/02-first-steps.md#opening-a-folder)
3. [Every markdown feature](02-guides/01-markdown-features.md)
4. [Code samples](02-guides/02-code-samples.md)
5. [A very long document](02-guides/03-long-document.md) — for the outline and scroll-spy
6. [Math & diagrams](02-guides/advanced/math-and-diagrams.md)
7. [Wikilinks](02-guides/advanced/wikilinks.md)
8. [API reference](03-reference/api.md) and the [FAQ](03-reference/faq.md)
9. [A file with spaces in its name](notes%20with%20spaces.md)

## Links of other kinds

- External: [tauri.app](https://tauri.app) and <https://github.com>
- Email: [hello@example.com](mailto:hello@example.com)
- A local non-markdown file: [the photo](assets/photo.png)
- An anchor in this document: [jump to the table](#status-table)
- A missing file: [does-not-exist.md](does-not-exist.md)

## Status table

| Feature        | Status | Notes                          |
| -------------- | :----: | ------------------------------ |
| Folder mode    |   ✅   | Tree, filter, keyboard nav     |
| Outline        |   ✅   | Scroll-spy                     |
| Find in page   |   ✅   | Highlights all matches         |
| PDF export     |   🚧   | Separate window                |
| Plugins        |   🚧   | Mermaid, math                  |
