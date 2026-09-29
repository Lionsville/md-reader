---
title: Markdown feature tour
description: Every construct the renderer supports, in one page
category: guide
---

# Markdown feature tour

This page exercises every construct MD Reader renders. Paragraphs can contain **bold**, *italic*,
***both***, ~~strikethrough~~, `inline code`, ==highlighted text==, super^script^, a [link](https://example.com),
and "smart quotes" -- with dashes... and ellipses. Here is a ||spoiler you can reveal|| by hovering.

## Headings

### Third level

#### Fourth level

##### Fifth level

###### Sixth level

## Emphasis and inline elements

Press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Del</kbd>. Use <abbr title="HyperText Markup Language">HTML</abbr>
when needed. H<sub>2</sub>O and E = mc<sup>2</sup>. Emoji shortcodes: :tada: :rocket: :+1: :heart: :smile:.

## Lists

- Unordered item
- Another item
  - Nested item
    - Deeply nested item
- Back to the top level

1. First
2. Second
   1. Second-a
   2. Second-b
3. Third

### Task list

- [x] Render markdown in Rust
- [x] Highlight code with syntect
- [ ] Take over the world
  - [x] Nested done task
  - [ ] Nested open task

### Description list

Markdown
: A lightweight markup language.

Tauri
: A toolkit for building small, fast desktop apps
: with a web frontend.

## Blockquotes

> Simplicity is prerequisite for reliability.
>
> — Edsger W. Dijkstra

> Nested quotes:
>
> > are also supported.

>>>
A multi-line blockquote,
written with three angle brackets.
>>>

## Alerts

> [!NOTE]
> Useful information that users should know, even when skimming content.

> [!TIP]
> Helpful advice for doing things better or more easily.

> [!IMPORTANT]
> Key information users need to know to achieve their goal.

> [!WARNING]
> Urgent info that needs immediate user attention to avoid problems.

> [!CAUTION]
> Advises about risks or negative outcomes of certain actions.

## Tables

| Left aligned | Centered | Right aligned |
| :----------- | :------: | ------------: |
| apples       |    3     |         $1.20 |
| oranges      |    12    |        $10.00 |
| a much longer cell with `code` | **bold** | 1,000,000 |
| pears        |    0     |         $0.00 |

A very wide table scrolls horizontally:

| Column 1 | Column 2 | Column 3 | Column 4 | Column 5 | Column 6 | Column 7 | Column 8 | Column 9 | Column 10 | Column 11 | Column 12 |
| -------- | -------- | -------- | -------- | -------- | -------- | -------- | -------- | -------- | --------- | --------- | --------- |
| lorem ipsum dolor | sit amet consectetur | adipiscing elit | sed do eiusmod | tempor incididunt | ut labore | et dolore | magna aliqua | ut enim | ad minim veniam | quis nostrud | exercitation |

## Code

Inline `let x = 42;` and a fenced block:

```rust
use std::collections::HashMap;

/// Count words in a string.
fn word_count(text: &str) -> HashMap<&str, usize> {
    let mut counts = HashMap::new();
    for word in text.split_whitespace() {
        *counts.entry(word).or_insert(0) += 1;
    }
    counts
}
```

A block without a language:

```
plain text block
    with indentation preserved
```

An indented code block:

    $ echo "indented code"
    indented code

## Images

![A generated gradient photo](../assets/photo.png)

Inline icon ![icon](../assets/small-icon.png) inside a sentence, and a linked image:

[![logo](../assets/logo.svg)](https://example.com)

## Footnotes

Here is a sentence with a footnote.[^1] And another one with a named note.[^note] Inline footnotes work too.^[This is an inline footnote.]

[^1]: The first footnote, with `code`.
[^note]: A named footnote.
    It can span multiple lines.

## Details

<details>
<summary>Click to expand</summary>

Hidden content with **markdown** inside, and a list:

- one
- two

</details>

<details open>
<summary>Open by default</summary>

This one starts expanded.

</details>

## Math

Inline math $E = mc^2$ and display math:

$$
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
$$

## Horizontal rule

---

## Raw HTML

<p align="center"><mark>Centered, highlighted HTML paragraph.</mark></p>

<figure>
  <img src="../01-getting-started/images/diagram.svg" alt="diagram">
  <figcaption>A figure with a caption.</figcaption>
</figure>

## Links

- [Relative link to the long document](03-long-document.md)
- [Relative link with an anchor](03-long-document.md#chapter-5-the-middle)
- [Link to a heading on this page](#footnotes)
- Autolink: https://www.rust-lang.org
