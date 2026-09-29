//! Native print-to-PDF of the calling webview (WKWebView on macOS, WebView2 on Windows),
//! followed by a `lopdf` post-processing pass that adds the document outline (bookmarks),
//! internal/external link annotations and the Title metadata.
//!
//! The export page (ui/export.html) lays the document out with Paged.js; every
//! `.pagedjs_page` is exactly one sheet of the requested paper size, so the native printer is
//! told to use that same paper size with zero margins.

#[cfg(target_os = "macos")]
mod macos;
mod outline;
#[cfg(windows)]
mod windows;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One bookmark. `level` 0 = top level; each deeper level nests below the previous
/// shallower item. `page` is 1-based, `y` is the target's distance from the page top as a
/// fraction of the page height (0 = top).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    pub title: String,
    pub level: u32,
    pub page: u32,
    #[serde(default)]
    pub y: f64,
}

/// A clickable area on a page. Coordinates are fractions (0..1) of the page size measured
/// from the top-left corner. Either `uri` (external) or `dest_page` (+ `dest_y`) is set.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkItem {
    pub page: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub uri: Option<String>,
    #[serde(default)]
    pub dest_page: Option<u32>,
    #[serde(default)]
    pub dest_y: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintResult {
    pub path: String,
    pub pages: u32,
    /// Non-fatal problem during post-processing (the PDF is still written, without extras).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Temporary file next to the destination (same volume → cheap rename).
fn temp_path(out: &Path) -> PathBuf {
    let name = out.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "export.pdf".into());
    out.with_file_name(format!(".{name}.{}.mdr-print.pdf", std::process::id()))
}

/// Prints the calling window's webview to `out_path` using paper of
/// `page_width_mm` × `page_height_mm` with zero margins, then adds bookmarks, links and the
/// Title metadata. Resolves once the file is completely written.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn print_to_pdf(
    window: tauri::WebviewWindow,
    out_path: String,
    page_width_mm: f64,
    page_height_mm: f64,
    title: Option<String>,
    outline: Option<Vec<OutlineItem>>,
    links: Option<Vec<LinkItem>>,
) -> Result<PrintResult, String> {
    if !(page_width_mm > 10.0 && page_height_mm > 10.0 && page_width_mm < 2000.0 && page_height_mm < 2000.0) {
        return Err(format!("invalid page size {page_width_mm}×{page_height_mm} mm"));
    }
    let out = PathBuf::from(&out_path);
    if out.parent().map(|p| !p.as_os_str().is_empty() && !p.is_dir()).unwrap_or(false) {
        return Err(format!("folder does not exist: {}", out.parent().unwrap().display()));
    }
    let tmp = temp_path(&out);
    let _ = std::fs::remove_file(&tmp);

    print_webview(&window, &tmp, page_width_mm, page_height_mm).await.inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;

    let outline = outline.unwrap_or_default();
    let links = links.unwrap_or_default();
    let tmp2 = tmp.clone();
    let out2 = out.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let res = outline::post_process(&tmp2, &out2, title.as_deref(), &outline, &links);
        match res {
            Ok(pages) => {
                let _ = std::fs::remove_file(&tmp2);
                Ok(PrintResult { path: out2.to_string_lossy().into_owned(), pages, warning: None })
            }
            Err(e) => {
                // Keep the printed PDF even if bookmarks couldn't be added.
                let _ = std::fs::remove_file(&out2);
                std::fs::rename(&tmp2, &out2)
                    .or_else(|_| std::fs::copy(&tmp2, &out2).map(|_| ()))
                    .map_err(|io| format!("could not write {}: {io}", out2.display()))?;
                let _ = std::fs::remove_file(&tmp2);
                let pages = lopdf::Document::load(&out2).map(|d| d.get_pages().len() as u32).unwrap_or(0);
                Ok(PrintResult { path: out2.to_string_lossy().into_owned(), pages, warning: Some(e) })
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "macos")]
async fn print_webview(window: &tauri::WebviewWindow, out: &Path, w_mm: f64, h_mm: f64) -> Result<(), String> {
    macos::print(window, out, w_mm, h_mm).await
}

#[cfg(windows)]
async fn print_webview(window: &tauri::WebviewWindow, out: &Path, w_mm: f64, h_mm: f64) -> Result<(), String> {
    windows::print(window, out, w_mm, h_mm).await
}

#[cfg(not(any(target_os = "macos", windows)))]
async fn print_webview(_window: &tauri::WebviewWindow, _out: &Path, _w_mm: f64, _h_mm: f64) -> Result<(), String> {
    Err("PDF export is not supported on this platform yet".into())
}

/// Waits (off the async runtime) for a completion message sent from the UI thread.
pub(crate) async fn wait_for(
    rx: std::sync::mpsc::Receiver<Result<(), String>>,
    timeout: std::time::Duration,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match rx.recv_timeout(timeout) {
        Ok(r) => r,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("printing timed out".into()),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("printing was aborted".into()),
    })
    .await
    .map_err(|e| e.to_string())?
}
