//! Native print-to-PDF of a webview (WKWebView / WebView2).
//! STUB — implemented by the export work package.

#[tauri::command]
pub async fn print_to_pdf(window: tauri::WebviewWindow, out_path: String) -> Result<(), String> {
    let _ = (window, out_path);
    Err("not implemented yet".into())
}
