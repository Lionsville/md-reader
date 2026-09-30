mod export;
mod folder;
mod markdown;
mod pdf;
mod preview;
mod protocol;
#[cfg(target_os = "macos")]
mod services;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

static WINDOW_COUNTER: AtomicUsize = AtomicUsize::new(1);
static READY: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct Watchers(Mutex<HashMap<String, notify::RecommendedWatcher>>);

/// Paths requested (via Finder/Explorer) before the app finished launching.
#[derive(Default)]
struct PendingOpens(Mutex<Vec<PathBuf>>);

// ---------------------------------------------------------------------------------------------
// Windows

fn encode(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}

pub fn open_reader_window(app: &AppHandle, target: Option<&Path>) -> tauri::Result<WebviewWindow> {
    let n = WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
    let url = match target {
        Some(p) => format!("index.html?path={}", encode(&p.to_string_lossy())),
        None => "index.html".to_string(),
    };
    let title = target
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "MD Reader".into());
    let builder = WebviewWindowBuilder::new(app, format!("reader-{n}"), WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(1180.0, 820.0)
        .min_inner_size(420.0, 320.0)
        // The page shows the window itself after the first paint (no white flash).
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder.tabbing_identifier("md-reader").title_bar_style(tauri::TitleBarStyle::Visible);
    let window = builder.build()?;
    show_later(&window);
    Ok(window)
}

pub fn open_export_window(app: &AppHandle, path: &Path, mode: &str) -> tauri::Result<WebviewWindow> {
    let n = WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed);
    let url = format!("export.html?path={}&mode={}", encode(&path.to_string_lossy()), encode(mode));
    let window = WebviewWindowBuilder::new(app, format!("export-{n}"), WebviewUrl::App(url.into()))
        .title("Export to PDF")
        .inner_size(1240.0, 880.0)
        .min_inner_size(760.0, 520.0)
        .visible(false)
        .build()?;
    show_later(&window);
    Ok(window)
}

/// Safety net: if the page failed to show itself quickly, show the window anyway.
fn show_later(window: &WebviewWindow) {
    let w = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1200));
        if !w.is_visible().unwrap_or(true) {
            let _ = w.show();
            let _ = w.set_focus();
        }
    });
}

fn open_paths(app: &AppHandle, paths: Vec<PathBuf>) {
    for p in paths {
        let _ = open_reader_window(app, Some(&p));
    }
}

fn paths_from_args(args: &[String], cwd: Option<&Path>) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(a);
            match (p.is_absolute(), cwd) {
                (false, Some(c)) => c.join(p),
                _ => p,
            }
        })
        .filter(|p| p.exists())
        .collect()
}

fn focused_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows().into_values().find(|w| w.is_focused().unwrap_or(false))
}

// ---------------------------------------------------------------------------------------------
// Commands

#[tauri::command(async)]
fn render_file(path: String, id_prefix: Option<String>) -> Result<markdown::RenderedDoc, String> {
    markdown::render_file(Path::new(&path), id_prefix.as_deref().unwrap_or("")).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command(async)]
fn scan_folder(path: String) -> Result<folder::FolderNode, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    Ok(folder::scan(p, folder::Files::Viewable))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PathInfo {
    exists: bool,
    is_dir: bool,
    is_file: bool,
    is_markdown: bool,
    /// PDF or HTML, shown in the reader as a preview.
    is_preview: bool,
}

#[tauri::command]
fn path_info(path: String) -> PathInfo {
    let p = Path::new(&path);
    PathInfo {
        exists: p.exists(),
        is_dir: p.is_dir(),
        is_file: p.is_file(),
        is_markdown: markdown::is_markdown(p),
        is_preview: preview::is_previewable(p),
    }
}

/// URL for showing an HTML file in the reader's sandboxed preview frame.
#[tauri::command]
fn html_preview_url(path: String) -> Result<String, String> {
    preview::preview_url(Path::new(&path))
}

#[tauri::command]
fn open_window(app: AppHandle, path: Option<String>) -> Result<(), String> {
    open_reader_window(&app, path.as_deref().map(Path::new)).map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_export(app: AppHandle, path: String, mode: String) -> Result<(), String> {
    open_export_window(&app, Path::new(&path), &mode).map(|_| ()).map_err(|e| e.to_string())
}

/// Watch a file or folder; changes are emitted to the calling window as `fs-changed`.
#[tauri::command]
fn watch_path(window: WebviewWindow, watchers: tauri::State<Watchers>, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let label = window.label().to_string();
    let w = window.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if matches!(ev.kind, notify::EventKind::Access(_)) {
            return;
        }
        let paths: Vec<String> = ev.paths.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let _ = w.emit_to(w.label(), "fs-changed", paths);
    })
    .map_err(|e| e.to_string())?;
    // Watch a single file through its directory: editors often save by atomic rename.
    let (dir, mode) = if target.is_dir() {
        (target.as_path(), RecursiveMode::Recursive)
    } else {
        (target.parent().unwrap_or(&target), RecursiveMode::NonRecursive)
    };
    watcher.watch(dir, mode).map_err(|e| e.to_string())?;
    watchers.0.lock().unwrap().insert(label, watcher);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    platform: &'static str,
    version: String,
    url_prefix: &'static str,
    plugins_dir: String,
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        platform: std::env::consts::OS,
        version: app.package_info().version.to_string(),
        url_prefix: protocol::url_prefix(),
        plugins_dir: protocol::PLUGINS_DIR.get().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginFile {
    id: String,
    file: String,
    url: String,
}

/// User plugins: `*.js` / `*.mjs` files in the plugins directory.
#[tauri::command(async)]
fn plugin_list() -> Vec<PluginFile> {
    let Some(dir) = protocol::PLUGINS_DIR.get() else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PluginFile> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| matches!(p.extension().and_then(|e| e.to_str()), Some("js" | "mjs")))
        .map(|p| PluginFile {
            id: p.file_stem().unwrap_or_default().to_string_lossy().into_owned(),
            file: p.to_string_lossy().into_owned(),
            url: protocol::local_url(&p),
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

// ---------------------------------------------------------------------------------------------
// Menu (macOS only — on Windows the in-window toolbar and shortcuts cover the same actions)

#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
    let item = |id: &str, text: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, text);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };
    let app_menu = SubmenuBuilder::new(app, "MD Reader")
        .item(&PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?)
        .separator()
        .item(&item("manage-plugins", "Plugins…", Some("Cmd+,"))?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new-window", "New Window", Some("Cmd+N"))?)
        .item(&item("open-file", "Open File…", Some("Cmd+O"))?)
        .item(&item("open-folder", "Open Folder…", Some("Cmd+Shift+O"))?)
        .item(&item("quick-open", "Go to File…", Some("Cmd+P"))?)
        .separator()
        .item(&item("export-pdf", "Export as PDF…", Some("Cmd+E"))?)
        .item(&item("export-folder-pdf", "Export Folder as PDF…", Some("Cmd+Shift+E"))?)
        .separator()
        .item(&item("reveal", "Show in Finder", None)?)
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&item("find", "Find…", Some("Cmd+F"))?)
        .item(&item("find-next", "Find Next", Some("Cmd+G"))?)
        .item(&item("find-prev", "Find Previous", Some("Cmd+Shift+G"))?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("toggle-sidebar", "Toggle Sidebar", Some("Cmd+\\"))?)
        .item(&item("toggle-outline", "Toggle Outline", Some("Cmd+Shift+\\"))?)
        .separator()
        .item(&item("zoom-in", "Zoom In", Some("Cmd+="))?)
        .item(&item("zoom-out", "Zoom Out", Some("Cmd+-"))?)
        .item(&item("zoom-reset", "Actual Size", Some("Cmd+0"))?)
        .separator()
        .item(&item("toggle-theme", "Toggle Dark Mode", Some("Cmd+Shift+D"))?)
        .item(&item("reload", "Reload", Some("Cmd+R"))?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;
    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &window]).build()
}

fn handle_menu(app: &AppHandle, id: &str) {
    match (id, focused_window(app)) {
        ("new-window", _) => {
            let _ = open_reader_window(app, None);
        }
        (_, Some(w)) => {
            let _ = w.emit_to(w.label(), "menu", id);
        }
        ("open-file" | "open-folder", None) => {
            use tauri_plugin_dialog::DialogExt;
            let handle = app.clone();
            let mut d = app.dialog().file();
            if id == "open-file" {
                let all: Vec<&str> = [markdown::MARKDOWN_EXTENSIONS, preview::PDF_EXTENSIONS, preview::HTML_EXTENSIONS].concat();
                d = d
                    .add_filter("Markdown, PDF & HTML", &all)
                    .add_filter("Markdown", markdown::MARKDOWN_EXTENSIONS)
                    .add_filter("PDF", preview::PDF_EXTENSIONS)
                    .add_filter("HTML", preview::HTML_EXTENSIONS);
                d.pick_file(move |p| {
                    if let Some(p) = p.and_then(|p| p.into_path().ok()) {
                        let _ = open_reader_window(&handle, Some(&p));
                    }
                });
            } else {
                d.pick_folder(move |p| {
                    if let Some(p) = p.and_then(|p| p.into_path().ok()) {
                        let _ = open_reader_window(&handle, Some(&p));
                    }
                });
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    markdown::preload();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths = paths_from_args(&args, Some(Path::new(&cwd)));
            if paths.is_empty() {
                let _ = open_reader_window(app, None);
            } else {
                open_paths(app, paths);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Watchers::default())
        .manage(PendingOpens::default())
        .register_asynchronous_uri_scheme_protocol("mdr", |_ctx, request, responder| {
            std::thread::spawn(move || responder.respond(protocol::handle(&request)));
        })
        .register_asynchronous_uri_scheme_protocol(preview::SCHEME, |_ctx, request, responder| {
            std::thread::spawn(move || responder.respond(preview::handle(&request)));
        })
        .invoke_handler(tauri::generate_handler![
            render_file,
            scan_folder,
            path_info,
            html_preview_url,
            open_window,
            open_export,
            watch_path,
            app_info,
            plugin_list,
            export::build_export,
            pdf::print_to_pdf,
        ])
        .setup(|app| {
            if let Ok(dir) = app.path().app_config_dir() {
                let plugins = dir.join("plugins");
                let _ = std::fs::create_dir_all(&plugins);
                let _ = protocol::PLUGINS_DIR.set(plugins);
            }
            #[cfg(target_os = "macos")]
            {
                let menu = build_menu(app.handle())?;
                app.set_menu(menu)?;
                services::register(app.handle());
            }
            app.on_menu_event(|app, event| handle_menu(app, event.id().as_ref()));

            let args: Vec<String> = std::env::args().collect();
            let paths = paths_from_args(&args, std::env::current_dir().ok().as_deref());
            app.state::<PendingOpens>().0.lock().unwrap().extend(paths);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building MD Reader");

    app.run(|app, event| match event {
        RunEvent::Ready => {
            READY.store(true, Ordering::SeqCst);
            let pending: Vec<PathBuf> = std::mem::take(&mut *app.state::<PendingOpens>().0.lock().unwrap());
            if !pending.is_empty() {
                open_paths(app, pending);
            } else {
                // On macOS a Finder "open" arrives as an event right after launch; give it a
                // moment before falling back to the welcome window.
                let handle = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(if cfg!(target_os = "macos") { 120 } else { 0 }));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        if h.webview_windows().is_empty() {
                            let _ = open_reader_window(&h, None);
                        }
                    });
                });
            }
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        RunEvent::Opened { urls } => {
            let paths: Vec<PathBuf> = urls.into_iter().filter_map(|u| u.to_file_path().ok()).collect();
            if READY.load(Ordering::SeqCst) {
                open_paths(app, paths);
            } else {
                app.state::<PendingOpens>().0.lock().unwrap().extend(paths);
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows, .. } => {
            if !has_visible_windows && app.webview_windows().is_empty() {
                let _ = open_reader_window(app, None);
            }
        }
        RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } => {
            app.state::<Watchers>().0.lock().unwrap().remove(&label);
        }
        // Stay resident on macOS after the last window closes, like other document apps.
        #[cfg(target_os = "macos")]
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        _ => {}
    });
}
