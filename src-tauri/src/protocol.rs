//! The `mdr` URI scheme: serves local media referenced by markdown files, PDFs shown in the
//! reader, plus user plugins.
//!
//! macOS/Linux: `mdr://localhost/<abs path>`; Windows: `http://mdr.localhost/<C:/abs/path>`.
//! Only media/font/PDF types are served from arbitrary locations; scripts are only served from the
//! user plugin directory, so a document can't smuggle code into the reader. (Interactive HTML is
//! served by the separate, sandboxed `mdrhtml` scheme — see `preview.rs`.)

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS};
use tauri::http::{header, Request, Response, StatusCode};

const PATH_SET: &AsciiSet = &CONTROLS
    .add(b' ').add(b'"').add(b'#').add(b'%').add(b'<').add(b'>').add(b'?')
    .add(b'`').add(b'{').add(b'}').add(b'[').add(b']').add(b'^').add(b'|').add(b'\'');

pub static PLUGINS_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn url_prefix() -> &'static str {
    if cfg!(windows) {
        "http://mdr.localhost/"
    } else {
        "mdr://localhost/"
    }
}

pub fn local_url(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let s = s.trim_start_matches('/');
    format!("{}{}", url_prefix(), utf8_percent_encode(s, PATH_SET))
}

fn path_from_uri(uri_path: &str) -> PathBuf {
    let decoded = percent_decode_str(uri_path).decode_utf8_lossy();
    let trimmed = decoded.trim_start_matches('/');
    if cfg!(windows) {
        PathBuf::from(trimmed.replace('/', "\\"))
    } else {
        PathBuf::from(format!("/{trimmed}"))
    }
}

pub fn mime_for(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" | "pjpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "apng" => "image/apng",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "vtt" => "text/vtt",
        "pdf" => "application/pdf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        _ => return None,
    })
}

fn allowed(path: &Path, mime: &str) -> bool {
    if mime == "text/javascript" || mime == "text/css" {
        // Scripts & styles only from the plugin directory.
        return PLUGINS_DIR
            .get()
            .and_then(|dir| Some(path.canonicalize().ok()?.starts_with(dir.canonicalize().ok()?)))
            .unwrap_or(false);
    }
    true
}

pub fn error(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .unwrap()
}

pub fn handle(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = path_from_uri(request.uri().path());
    let Some(mime) = mime_for(&path) else {
        return error(StatusCode::FORBIDDEN);
    };
    if !allowed(&path, mime) {
        return error(StatusCode::FORBIDDEN);
    }
    serve_file(&path, mime, request, &[])
}

/// Serve a local file (with `Range` support so audio/video/PDF can seek).
pub fn serve_file(
    path: &Path,
    mime: &str,
    request: &Request<Vec<u8>>,
    extra_headers: &[(&str, &str)],
) -> Response<Vec<u8>> {
    let Ok(mut file) = std::fs::File::open(path) else {
        return error(StatusCode::NOT_FOUND);
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-cache");
    for (k, v) in extra_headers {
        builder = builder.header(*k, *v);
    }

    // Range support so audio/video can seek.
    if let Some(range) = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
    {
        let (start, end) = range.split_once('-').unwrap_or((range, ""));
        let start: u64 = start.trim().parse().unwrap_or(0);
        let end: u64 = end.trim().parse().unwrap_or(len.saturating_sub(1)).min(len.saturating_sub(1));
        // Cap chunks so a huge video isn't read into memory at once.
        let end = end.min(start + 4 * 1024 * 1024 - 1);
        if start >= len || start > end {
            return error(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        let mut buf = vec![0; (end - start + 1) as usize];
        if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut buf).is_err() {
            return error(StatusCode::INTERNAL_SERVER_ERROR);
        }
        return builder
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
            .body(buf)
            .unwrap();
    }

    let mut buf = Vec::with_capacity(len as usize);
    if file.read_to_end(&mut buf).is_err() {
        return error(StatusCode::INTERNAL_SERVER_ERROR);
    }
    builder.status(StatusCode::OK).body(buf).unwrap()
}
