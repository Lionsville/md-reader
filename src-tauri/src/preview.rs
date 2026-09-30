//! Previews of non-markdown files: PDF (served by `mdr`, shown by the webview's own PDF viewer)
//! and interactive HTML, served by the `mdrhtml` scheme defined here.
//!
//! HTML runs its own JavaScript, like a page opened from disk in a browser, but without any
//! access to the app or the OS:
//! - It lives on its own scheme/origin (`mdrhtml://localhost/<token>/…`, Windows
//!   `http://mdrhtml.localhost/<token>/…`), never the app's, and the reader's CSP never allows
//!   scripts from it.
//! - Every response carries a CSP `sandbox` (no `allow-same-origin`, no popups, no top
//!   navigation), so the page gets an opaque origin even if it is loaded outside the reader's
//!   sandboxed iframe. It can't reach the parent document, and it never receives Tauri's
//!   per-launch invoke key, which the IPC layer requires on every call.
//! - `connect-src`/`form-action` exclude the IPC endpoints (`ipc:`, `http://ipc.localhost`).
//! - Files are only served from the directory of the previewed HTML file (and below), through
//!   a random token that `html_preview_url` hands out — never from arbitrary paths.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use tauri::http::{Request, Response, StatusCode};

use crate::protocol;

pub const SCHEME: &str = "mdrhtml";

const SEGMENT: &AsciiSet = &CONTROLS
    .add(b' ').add(b'"').add(b'#').add(b'%').add(b'<').add(b'>').add(b'?').add(b'/').add(b'\\')
    .add(b'`').add(b'{').add(b'}').add(b'[').add(b']').add(b'^').add(b'|').add(b'\'');

pub const PDF_EXTENSIONS: &[&str] = &["pdf"];
pub const HTML_EXTENSIONS: &[&str] = &["html", "htm", "xhtml"];

fn has_ext(path: &Path, exts: &[&str]) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| exts.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// PDF or HTML: shown in the reader, listed in the folder tree, never exported.
pub fn is_previewable(path: &Path) -> bool {
    has_ext(path, PDF_EXTENSIONS) || has_ext(path, HTML_EXTENSIONS)
}

/// Both the macOS and the Windows form of the scheme, so one policy fits every platform.
const SELF_SRC: &str = "mdrhtml: http://mdrhtml.localhost";

static CSP: Lazy<String> = Lazy::new(|| {
    let s = SELF_SRC;
    [
        "sandbox allow-scripts allow-forms allow-modals allow-pointer-lock".to_string(),
        "default-src 'none'".into(),
        format!("script-src {s} https: data: blob: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"),
        format!("style-src {s} https: http: data: blob: 'unsafe-inline'"),
        format!("img-src {s} https: http: data: blob:"),
        format!("media-src {s} https: http: data: blob:"),
        format!("font-src {s} https: data:"),
        // No `http:` here: on Windows the IPC endpoint is http://ipc.localhost.
        format!("connect-src {s} https: wss: data: blob:"),
        format!("frame-src {s} https: data: blob:"),
        format!("worker-src {s} data: blob:"),
        format!("manifest-src {s}"),
        "object-src 'none'".into(),
        "form-action 'none'".into(),
        format!("base-uri {s} https:"),
    ]
    .join("; ")
});

/// token -> canonical root directory the page may load files from.
static ROOTS: Lazy<Mutex<HashMap<String, PathBuf>>> = Lazy::new(Default::default);

fn origin() -> &'static str {
    if cfg!(windows) {
        "http://mdrhtml.localhost/"
    } else {
        "mdrhtml://localhost/"
    }
}

fn new_token(root: &Path) -> String {
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write(root.as_os_str().as_encoded_bytes());
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    let a = h.finish();
    let mut h2 = std::collections::hash_map::RandomState::new().build_hasher();
    h2.write_u64(a);
    format!("{a:016x}{:016x}", h2.finish())
}

/// The URL that shows `path` (an .html file) in a sandboxed preview frame.
pub fn preview_url(path: &Path) -> Result<String, String> {
    let file = path.canonicalize().map_err(|e| format!("{}: {e}", path.display()))?;
    if !file.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    let root = file.parent().ok_or("file has no parent directory")?.to_path_buf();
    let token = {
        let mut roots = ROOTS.lock().unwrap();
        match roots.iter().find(|(_, r)| **r == root) {
            Some((t, _)) => t.clone(),
            None => {
                let t = new_token(&root);
                roots.insert(t.clone(), root.clone());
                t
            }
        }
    };
    let rel = file.strip_prefix(&root).map_err(|_| "file outside its own folder")?;
    let rel: Vec<String> = rel
        .components()
        .map(|c| utf8_percent_encode(&c.as_os_str().to_string_lossy(), SEGMENT).to_string())
        .collect();
    Ok(format!("{}{token}/{}", origin(), rel.join("/")))
}

fn mime_for(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "xhtml" => "application/xhtml+xml",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "geojson" => "application/geo+json",
        "wasm" => "application/wasm",
        "xml" => "application/xml",
        "txt" | "md" | "markdown" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "tsv" => "text/tab-separated-values; charset=utf-8",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        _ => protocol::mime_for(path).unwrap_or("application/octet-stream"),
    }
}

pub fn handle(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri_path = request.uri().path().trim_start_matches('/');
    let (token, rest) = uri_path.split_once('/').unwrap_or((uri_path, ""));
    let Some(root) = ROOTS.lock().unwrap().get(token).cloned() else {
        return protocol::error(StatusCode::FORBIDDEN);
    };
    let mut path = root.clone();
    for seg in rest.split('/') {
        let seg = percent_decode_str(seg).decode_utf8_lossy();
        match seg.as_ref() {
            "" | "." => {}
            ".." => return protocol::error(StatusCode::FORBIDDEN),
            s if s.contains(['/', '\\']) || (cfg!(windows) && s.contains(':')) => {
                return protocol::error(StatusCode::FORBIDDEN)
            }
            s => path.push(s),
        }
    }
    if path.is_dir() {
        path.push("index.html");
    }
    // Symlinks must not lead outside the folder either.
    let Ok(real) = path.canonicalize() else {
        return protocol::error(StatusCode::NOT_FOUND);
    };
    if !real.starts_with(&root) {
        return protocol::error(StatusCode::FORBIDDEN);
    }
    protocol::serve_file(
        &real,
        mime_for(&real),
        request,
        &[("Content-Security-Policy", CSP.as_str()), ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer")],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_only_inside_the_html_folder() {
        let dir = std::env::temp_dir().join(format!("mdr-preview-test-{}", std::process::id()));
        let sub = dir.join("site");
        std::fs::create_dir_all(sub.join("js")).unwrap();
        std::fs::write(sub.join("index.html"), "<p>hi</p>").unwrap();
        std::fs::write(sub.join("js/app.js"), "1").unwrap();
        std::fs::write(dir.join("secret.txt"), "no").unwrap();

        let url = preview_url(&sub.join("index.html")).unwrap();
        assert!(url.starts_with(origin()) && url.ends_with("/index.html"));
        let base = url.trim_end_matches("index.html");
        let get = |u: String| {
            let path = u.splitn(4, '/').nth(3).map(|p| format!("/{p}")).unwrap_or_default();
            handle(&Request::builder().uri(format!("mdrhtml://localhost{path}")).body(Vec::new()).unwrap())
        };

        let ok = get(url.clone());
        assert_eq!(ok.status(), StatusCode::OK);
        assert!(ok.headers()["Content-Security-Policy"].to_str().unwrap().starts_with("sandbox allow-scripts"));
        assert!(ok.headers()["Content-Type"].to_str().unwrap().starts_with("text/html"));
        assert_eq!(get(format!("{base}js/app.js")).status(), StatusCode::OK);
        assert_eq!(get(format!("{base}../secret.txt")).status(), StatusCode::FORBIDDEN);
        assert_eq!(get(format!("{base}%2E%2E/secret.txt")).status(), StatusCode::FORBIDDEN);
        assert_eq!(get(format!("{base}..%2Fsecret.txt")).status(), StatusCode::FORBIDDEN);
        assert_eq!(get("mdrhtml://localhost/not-a-token/index.html".into()).status(), StatusCode::FORBIDDEN);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn csp_never_allows_ipc() {
        let connect = CSP.split("; ").find(|d| d.starts_with("connect-src")).unwrap();
        let sources: Vec<&str> = connect.split_whitespace().skip(1).collect();
        assert!(!sources.iter().any(|s| s.contains("ipc") || *s == "http:" || s.contains('*')), "{connect}");
        assert!(!CSP.contains("allow-same-origin") && !CSP.contains("allow-popups") && !CSP.contains("allow-top-navigation"));
    }
}
