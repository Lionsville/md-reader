# FAQ

## Why is it so fast?

Parsing, highlighting and sanitizing all happen in Rust. The window is only shown once the
document has been painted.

## Can I run scripts from a markdown file?

No. All HTML is sanitized — `<script>` tags and event handlers are removed:

<img src="../assets/small-icon.png" onerror="alert('nope')" alt="icon"> ← this image had an `onerror` handler.

<script>alert('this never runs')</script>

## Does it support dark mode?

Yes — press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>D</kbd>, or follow the system setting.

## Where do plugins live?

In the app's config folder, under `plugins/`. See the [API reference](api.md#plugins).
