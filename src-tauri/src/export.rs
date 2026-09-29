//! Builds the document bundle for PDF export (single file or whole folder).
//! STUB — implemented by the export work package.

#[tauri::command(async)]
pub fn build_export(path: String, mode: String) -> Result<serde_json::Value, String> {
    let _ = (path, mode);
    Err("not implemented yet".into())
}
