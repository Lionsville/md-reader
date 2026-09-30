//! Builds the document bundle for PDF export (a single file or a whole folder).
//!
//! Every document is rendered by `markdown::render_file` with a unique id prefix (`d{index}-`)
//! so heading ids stay unique once all documents are concatenated into one paginated document.
//! Folder exports are rendered in parallel; progress is reported to the calling window as the
//! `export-progress` event (`{done, total}`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, WebviewWindow};

use crate::folder::{self, FolderNode};
use crate::markdown::{self, Heading};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportBundle {
    pub title: String,
    pub root_path: String,
    pub mode: String,
    pub docs: Vec<ExportDoc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDoc {
    pub index: usize,
    pub path: String,
    /// Path relative to the export root, always with `/` separators.
    pub rel_path: String,
    pub title: String,
    /// Number of folders between the export root and the file (= `dir_trail.len()`).
    pub depth: usize,
    /// Folder names from the root (exclusive) down to the file's parent folder.
    pub dir_trail: Vec<String>,
    /// Id prefix used for every heading id in `html`.
    pub prefix: String,
    pub html: String,
    pub headings: Vec<Heading>,
    /// Set when the file could not be read; `html` then contains a short error note.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
struct Progress {
    done: usize,
    total: usize,
}

struct Job {
    path: PathBuf,
    dir_trail: Vec<String>,
}

fn collect_jobs(node: &FolderNode, trail: &mut Vec<String>, out: &mut Vec<Job>) {
    for c in &node.children {
        if c.is_dir {
            trail.push(c.name.clone());
            collect_jobs(c, trail, out);
            trail.pop();
        } else {
            out.push(Job { path: PathBuf::from(&c.path), dir_trail: trail.clone() });
        }
    }
}

fn file_stem(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn render_job(index: usize, job: &Job, root: &Path) -> ExportDoc {
    let prefix = format!("d{index}-");
    let rel_path = job
        .path
        .strip_prefix(root)
        .unwrap_or(&job.path)
        .to_string_lossy()
        .replace('\\', "/");
    let path = job.path.to_string_lossy().into_owned();
    let depth = job.dir_trail.len();
    match markdown::render_file(&job.path, &prefix) {
        Ok(doc) => ExportDoc {
            index,
            path,
            rel_path,
            title: doc.title,
            depth,
            dir_trail: job.dir_trail.clone(),
            prefix,
            html: doc.html,
            headings: doc.headings,
            error: None,
        },
        Err(e) => ExportDoc {
            index,
            title: file_stem(&job.path),
            html: format!("<p class=\"export-error\">Could not read {}: {}</p>", escape(&rel_path), escape(&e.to_string())),
            path,
            rel_path,
            depth,
            dir_trail: job.dir_trail.clone(),
            prefix,
            headings: Vec::new(),
            error: Some(e.to_string()),
        },
    }
}

/// Render all jobs, in parallel for bigger folders, keeping the input order.
fn render_all(jobs: &[Job], root: &Path, on_progress: &(dyn Fn(usize, usize) + Sync)) -> Vec<ExportDoc> {
    let total = jobs.len();
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    if total < 8 || threads == 1 {
        return jobs
            .iter()
            .enumerate()
            .map(|(i, j)| {
                let d = render_job(i, j, root);
                on_progress(i + 1, total);
                d
            })
            .collect();
    }
    let done = AtomicUsize::new(0);
    let next = AtomicUsize::new(0);
    let mut slots: Vec<Option<ExportDoc>> = (0..total).map(|_| None).collect();
    let results: Vec<Vec<(usize, ExportDoc)>> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..threads.min(total))
            .map(|_| {
                s.spawn(|| {
                    // Work stealing by index: file sizes vary a lot, fixed chunks balance poorly.
                    let mut out = Vec::new();
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        if i >= total {
                            break;
                        }
                        out.push((i, render_job(i, &jobs[i], root)));
                        let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                        on_progress(n, total);
                    }
                    out
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    });
    for (i, d) in results.into_iter().flatten() {
        slots[i] = Some(d);
    }
    slots
        .into_iter()
        .enumerate()
        .map(|(i, d)| d.unwrap_or_else(|| render_job(i, &jobs[i], root)))
        .collect()
}

pub fn build(path: &Path, mode: &str, on_progress: &(dyn Fn(usize, usize) + Sync)) -> Result<ExportBundle, String> {
    match mode {
        "folder" => {
            if !path.is_dir() {
                return Err(format!("{} is not a folder", path.display()));
            }
            let tree = folder::scan(path, folder::Files::Markdown);
            let mut jobs = Vec::new();
            collect_jobs(&tree, &mut Vec::new(), &mut jobs);
            if jobs.is_empty() {
                return Err(format!("No markdown files found in {}", path.display()));
            }
            let docs = render_all(&jobs, path, on_progress);
            Ok(ExportBundle { title: tree.name, root_path: path.to_string_lossy().into_owned(), mode: "folder".into(), docs })
        }
        "file" => {
            if !path.is_file() {
                return Err(format!("{} is not a file", path.display()));
            }
            let root = path.parent().unwrap_or(Path::new("")).to_path_buf();
            let jobs = [Job { path: path.to_path_buf(), dir_trail: Vec::new() }];
            let docs = render_all(&jobs, &root, on_progress);
            if let Some(err) = &docs[0].error {
                return Err(format!("{}: {err}", path.display()));
            }
            Ok(ExportBundle { title: docs[0].title.clone(), root_path: root.to_string_lossy().into_owned(), mode: "file".into(), docs })
        }
        other => Err(format!("unknown export mode '{other}'")),
    }
}

/// `build_export(path, mode: 'file'|'folder')` → [`ExportBundle`] (camelCase JSON).
/// Emits `export-progress` `{done, total}` to the calling window while rendering.
#[tauri::command(async)]
pub fn build_export(window: WebviewWindow, path: String, mode: String) -> Result<ExportBundle, String> {
    let last = std::sync::Mutex::new(Instant::now() - Duration::from_secs(1));
    let label = window.label().to_string();
    let progress = |done: usize, total: usize| {
        // Throttle: at most ~20 events per second, plus the final one.
        let mut l = last.lock().unwrap();
        if done == total || l.elapsed() >= Duration::from_millis(50) {
            *l = Instant::now();
            let _ = window.emit_to(label.as_str(), "export-progress", Progress { done, total });
        }
    };
    build(Path::new(&path), &mode, &progress)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_folder_bundle_in_order() {
        let dir = std::env::temp_dir().join(format!("mdr-export-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("b-guide/sub")).unwrap();
        std::fs::write(dir.join("README.md"), "# Readme\n\n## Intro\n").unwrap();
        std::fs::write(dir.join("a.md"), "# Alpha\n").unwrap();
        for i in 0..12 {
            std::fs::write(dir.join(format!("b-guide/{i}-page.md")), format!("# Page {i}\n\n## Part\n")).unwrap();
        }
        std::fs::write(dir.join("b-guide/sub/deep.md"), "no heading").unwrap();
        let b = build(&dir, "folder", &|_, _| {}).unwrap();
        assert_eq!(b.docs.len(), 15);
        assert_eq!(b.docs[0].title, "Readme");
        assert_eq!(b.docs[0].headings[1].id, "d0-intro");
        assert_eq!(b.docs[1].title, "Alpha");
        assert_eq!(b.docs[2].title, "Page 0");
        assert_eq!(b.docs[3].title, "Page 1");
        assert_eq!(b.docs[11].title, "Page 9");
        assert_eq!(b.docs[12].title, "Page 10");
        assert_eq!(b.docs[2].dir_trail, vec!["b-guide".to_string()]);
        let last = b.docs.last().unwrap();
        assert_eq!(last.title, "deep");
        assert_eq!(last.rel_path, "b-guide/sub/deep.md");
        assert_eq!(last.depth, 2);
        for (i, d) in b.docs.iter().enumerate() {
            assert_eq!(d.index, i);
            assert_eq!(d.prefix, format!("d{i}-"));
        }
        let f = build(&dir.join("a.md"), "file", &|_, _| {}).unwrap();
        assert_eq!(f.title, "Alpha");
        assert_eq!(f.docs.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
