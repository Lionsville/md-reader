//! Markdown → sanitized HTML rendering.
//!
//! Parsing is done by comrak with (nearly) every extension enabled, code blocks are
//! highlighted by syntect with class-based output (colors live in ui/css/syntax.css),
//! and the result is sanitized with ammonia so a markdown file can never run script
//! inside the reader. Local media references are rewritten to the `mdr` protocol.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};

use comrak::adapters::SyntaxHighlighterAdapter;
use comrak::nodes::NodeValue;
use comrak::options::Plugins;
use comrak::{format_html_with_plugins, parse_document, Anchorizer, Arena, Options};
use once_cell::sync::Lazy;
use serde::Serialize;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

use crate::protocol::local_url;

pub const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdx", "mdtxt", "mdtext", "text"];

pub fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MARKDOWN_EXTENSIONS.iter().any(|m| m.eq_ignore_ascii_case(e)) && !e.eq_ignore_ascii_case("text"))
        .unwrap_or(false)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedDoc {
    pub path: String,
    pub dir: String,
    pub title: String,
    pub html: String,
    pub headings: Vec<Heading>,
    pub front_matter: Option<Vec<(String, String)>>,
}

pub static SYNTAX_SET: Lazy<SyntaxSet> = Lazy::new(two_face::syntax::extra_newlines);

/// Warm up the (comparatively expensive) syntax set off the main thread.
pub fn preload() {
    std::thread::spawn(|| {
        Lazy::force(&SYNTAX_SET);
        Lazy::force(&SANITIZER);
    });
}

fn options(id_prefix: &str) -> Options<'static> {
    let mut o = Options::default();
    let e = &mut o.extension;
    e.strikethrough = true;
    e.tagfilter = false;
    e.table = true;
    e.autolink = true;
    e.tasklist = true;
    e.superscript = true;
    e.subscript = false; // conflicts with strikethrough's single-tilde form
    e.header_id_prefix = Some(id_prefix.to_string());
    e.footnotes = true;
    e.inline_footnotes = true;
    e.description_lists = true;
    e.front_matter_delimiter = Some("---".into());
    e.multiline_block_quotes = true;
    e.alerts = true;
    e.math_dollars = true;
    e.math_code = true;
    e.shortcodes = true;
    e.wikilinks_title_after_pipe = true;
    e.underline = false;
    e.spoiler = true;
    e.highlight = true;
    let p = &mut o.parse;
    p.smart = true;
    p.relaxed_tasklist_matching = true;
    p.relaxed_autolinks = true;
    let r = &mut o.render;
    r.r#unsafe = true; // raw HTML is allowed through; ammonia sanitizes afterwards
    r.github_pre_lang = false;
    r.tasklist_classes = true;
    r.figure_with_caption = false;
    o
}

/// Render a markdown file from disk.
pub fn render_file(path: &Path, id_prefix: &str) -> std::io::Result<RenderedDoc> {
    let bytes = std::fs::read(path)?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let fallback = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut doc = render_markdown(text, &dir, id_prefix, &fallback);
    doc.path = path.to_string_lossy().into_owned();
    Ok(doc)
}

pub fn render_markdown(md: &str, base_dir: &Path, id_prefix: &str, fallback_title: &str) -> RenderedDoc {
    let opts = options(id_prefix);
    let arena = Arena::new();
    let root = parse_document(&arena, md, &opts);

    let mut headings = Vec::new();
    let mut front_matter = None;
    let mut anchorizer = Anchorizer::new();
    for node in root.descendants() {
        let value = &node.data().value;
        match value {
            NodeValue::Heading(h) => {
                let text = node.collect_text();
                let id = format!("{id_prefix}{}", anchorizer.anchorize(&text));
                headings.push(Heading { level: h.level, text, id });
            }
            NodeValue::FrontMatter(raw) => front_matter = Some(parse_front_matter(raw)),
            _ => {}
        }
    }

    let title = headings
        .iter()
        .find(|h| h.level == 1)
        .map(|h| h.text.clone())
        .or_else(|| {
            front_matter.as_ref().and_then(|fm: &Vec<(String, String)>| {
                fm.iter().find(|(k, _)| k.eq_ignore_ascii_case("title")).map(|(_, v)| v.clone())
            })
        })
        .unwrap_or_else(|| fallback_title.to_string());

    let highlighter = Highlighter;
    let mut plugins = Plugins::default();
    plugins.render.codefence_syntax_highlighter = Some(&highlighter);

    let mut raw = String::with_capacity(md.len() * 2);
    let _ = format_html_with_plugins(root, &opts, &mut raw, &plugins);

    let html = sanitize(&raw, base_dir);

    RenderedDoc {
        path: String::new(),
        dir: base_dir.to_string_lossy().into_owned(),
        title,
        html,
        headings,
        front_matter,
    }
}

/// Very small YAML subset: top-level `key: value` scalars, enough for display and titles.
fn parse_front_matter(raw: &str) -> Vec<(String, String)> {
    raw.lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty() && *l != "---" && !l.starts_with(' ') && !l.starts_with('#'))
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
            Some((k.trim().to_string(), v))
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Syntax highlighting

struct Highlighter;

fn escape_html(out: &mut dyn fmt::Write, s: &str) -> fmt::Result {
    let mut last = 0;
    for (i, c) in s.char_indices() {
        let rep = match c {
            '<' => "&lt;",
            '>' => "&gt;",
            '&' => "&amp;",
            '"' => "&quot;",
            _ => continue,
        };
        out.write_str(&s[last..i])?;
        out.write_str(rep)?;
        last = i + 1;
    }
    out.write_str(&s[last..])
}

fn write_attrs(out: &mut dyn fmt::Write, attrs: &HashMap<&'static str, Cow<'_, str>>) -> fmt::Result {
    let mut keys: Vec<_> = attrs.keys().collect();
    keys.sort();
    for k in keys {
        write!(out, " {k}=\"")?;
        escape_html(out, &attrs[k])?;
        out.write_char('"')?;
    }
    Ok(())
}

impl SyntaxHighlighterAdapter for Highlighter {
    fn write_highlighted(&self, out: &mut dyn fmt::Write, lang: Option<&str>, code: &str) -> fmt::Result {
        let ss = &*SYNTAX_SET;
        let syntax = lang
            .map(|l| l.split(|c: char| c.is_whitespace() || c == ',' || c == '{').next().unwrap_or(l))
            .filter(|l| !l.is_empty())
            .and_then(|l| ss.find_syntax_by_token(l));
        let Some(syntax) = syntax else {
            return escape_html(out, code);
        };
        // Don't burn time on enormous blocks.
        if code.len() > 512 * 1024 {
            return escape_html(out, code);
        }
        let mut gen = ClassedHTMLGenerator::new_with_class_style(syntax, ss, ClassStyle::SpacedPrefixed { prefix: "hl-" });
        for line in LinesWithEndings::from(code) {
            if gen.parse_html_for_line_which_includes_newline(line).is_err() {
                return escape_html(out, code);
            }
        }
        out.write_str(&gen.finalize())
    }

    fn write_pre_tag(&self, out: &mut dyn fmt::Write, attrs: HashMap<&'static str, Cow<'_, str>>) -> fmt::Result {
        out.write_str("<pre")?;
        write_attrs(out, &attrs)?;
        out.write_char('>')
    }

    fn write_code_tag(&self, out: &mut dyn fmt::Write, attrs: HashMap<&'static str, Cow<'_, str>>) -> fmt::Result {
        out.write_str("<code")?;
        write_attrs(out, &attrs)?;
        out.write_char('>')
    }
}

// ---------------------------------------------------------------------------------------------
// Sanitizing

static SANITIZER: Lazy<ammonia::Builder<'static>> = Lazy::new(|| {
    let mut b = ammonia::Builder::default();
    b.add_tags([
        "details", "summary", "input", "figure", "figcaption", "picture", "source", "video", "audio",
        "track", "kbd", "samp", "var", "mark", "ins", "del", "s", "u", "section", "center", "font",
        "dl", "dt", "dd", "abbr", "cite", "q", "small", "big", "wbr", "caption", "colgroup", "col",
    ])
    .add_generic_attributes([
        "class", "id", "title", "align", "valign", "style", "dir", "lang", "width", "height",
        "name", "aria-label", "aria-hidden", "role",
    ])
    .add_generic_attribute_prefixes(["data-"])
    .add_tag_attributes("input", ["type", "checked", "disabled"])
    .add_tag_attributes("img", ["src", "srcset", "alt", "loading", "decoding"])
    .add_tag_attributes("source", ["src", "srcset", "type", "media", "sizes"])
    .add_tag_attributes("video", ["src", "controls", "poster", "autoplay", "loop", "muted", "playsinline", "preload"])
    .add_tag_attributes("audio", ["src", "controls", "loop", "muted", "preload"])
    .add_tag_attributes("track", ["src", "kind", "srclang", "label", "default"])
    .add_tag_attributes("details", ["open"])
    .add_tag_attributes("ol", ["start", "type", "reversed"])
    .add_tag_attributes("li", ["value"])
    .add_tag_attributes("td", ["colspan", "rowspan"])
    .add_tag_attributes("th", ["colspan", "rowspan", "scope"])
    .add_tag_attributes("col", ["span"])
    .add_tag_attributes("font", ["color", "face", "size"])
    .add_url_schemes(["mdr", "file"])
    .attribute_filter(|element, attribute, value| {
        let is_media_src = matches!(
            (element, attribute),
            ("img", "src") | ("source", "src") | ("video", "src") | ("video", "poster") | ("audio", "src") | ("track", "src")
        );
        if is_media_src || attribute == "srcset" {
            return BASE_DIR.with(|b| {
                let base = b.borrow();
                Some(if attribute == "srcset" {
                    rewrite_srcset(value, &base).into()
                } else {
                    rewrite_media_url(value, &base).into()
                })
            });
        }
        Some(value.into())
    });
    b
});

thread_local! {
    static BASE_DIR: std::cell::RefCell<PathBuf> = std::cell::RefCell::new(PathBuf::new());
}

fn sanitize(html: &str, base_dir: &Path) -> String {
    BASE_DIR.with(|b| *b.borrow_mut() = base_dir.to_path_buf());
    SANITIZER.clean(html).to_string()
}

fn rewrite_srcset(value: &str, base: &Path) -> String {
    value
        .split(',')
        .map(|part| {
            let part = part.trim();
            match part.split_once(char::is_whitespace) {
                Some((url, desc)) => format!("{} {}", rewrite_media_url(url, base), desc.trim()),
                None => rewrite_media_url(part, base),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Turn a (relative) media reference from a markdown file into something the webview can load.
pub fn rewrite_media_url(url: &str, base: &Path) -> String {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("data:") || lower.starts_with("mdr:") || lower.starts_with("blob:") {
        return url.to_string();
    }
    let path_part = if let Some(rest) = url.strip_prefix("file://") {
        rest
    } else {
        url
    };
    let path_part = path_part.split(['?', '#']).next().unwrap_or(path_part);
    let decoded = percent_encoding::percent_decode_str(path_part).decode_utf8_lossy();
    let p = Path::new(decoded.as_ref());
    let resolved = if p.is_absolute() && (url.starts_with("file://") || p.exists()) {
        p.to_path_buf()
    } else {
        base.join(decoded.trim_start_matches('/'))
    };
    local_url(&normalize(&resolved))
}

/// Lexically normalize `a/b/../c` → `a/c` without touching the filesystem.
pub fn normalize(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_basics() {
        let md = "---\ntitle: Hello\n---\n# Top\n\n## Sub *x*\n\n```rust\nfn main() {}\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n![img](<pics/a b.png>)\n\n<img src=\"../x.png\" onerror=\"alert(1)\">\n\n<script>alert(1)</script>\n\n- [x] done\n\n> [!NOTE]\n> hi\n\n$a^2$ :smile:\n";
        let d = render_markdown(md, Path::new("/tmp/docs"), "", "fallback");
        assert_eq!(d.title, "Top");
        assert_eq!(d.headings.len(), 2);
        assert_eq!(d.headings[1].id, "sub-x");
        assert!(d.html.contains("hl-"), "{}", d.html);
        assert!(d.html.contains("language-mermaid"));
        assert!(!d.html.contains("<script"));
        assert!(!d.html.contains("onerror"));
        assert!(d.html.contains("/tmp/x.png"), "{}", d.html);
        assert!(d.html.contains("pics/a%20b.png"), "{}", d.html);
        assert!(d.html.contains("markdown-alert"));
        assert!(d.html.contains("data-math-style"));
        assert!(d.html.contains("😄"));
        assert_eq!(d.front_matter.unwrap()[0], ("title".into(), "Hello".into()));
        println!("{}", d.html);
    }
}
