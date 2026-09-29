//! Folder scanning: builds a tree of the markdown files below a directory.

use std::cmp::Ordering;
use std::path::Path;

use serde::Serialize;

use crate::markdown::is_markdown;

const SKIP_DIRS: &[&str] = &["node_modules", "target", "bower_components", "__pycache__", "venv", ".venv", "dist", "build"];
const MAX_DEPTH: usize = 12;
const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FolderNode>,
}

pub fn scan(root: &Path) -> FolderNode {
    let mut budget = MAX_ENTRIES;
    let children = scan_dir(root, 0, &mut budget);
    FolderNode {
        name: display_name(root),
        path: root.to_string_lossy().into_owned(),
        is_dir: true,
        children,
    }
}

fn display_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string_lossy().into_owned())
}

fn scan_dir(dir: &Path, depth: usize, budget: &mut usize) -> Vec<FolderNode> {
    if depth > MAX_DEPTH || *budget == 0 {
        return Vec::new();
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut nodes = Vec::new();
    for entry in read.flatten() {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        // Follow symlinks for type, but don't recurse into symlinked dirs (avoids cycles).
        let Ok(ft) = entry.file_type() else { continue };
        let is_dir = if ft.is_symlink() { false } else { ft.is_dir() };
        if is_dir {
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            let children = scan_dir(&path, depth + 1, budget);
            if !children.is_empty() {
                nodes.push(FolderNode { name, path: path.to_string_lossy().into_owned(), is_dir: true, children });
            }
        } else if is_markdown(&path) && path.is_file() {
            nodes.push(FolderNode { name, path: path.to_string_lossy().into_owned(), is_dir: false, children: Vec::new() });
        }
    }
    nodes.sort_by(compare_nodes);
    nodes
}

fn rank(n: &FolderNode) -> u8 {
    if n.is_dir {
        return 2;
    }
    let stem = n.name.rsplit_once('.').map(|(s, _)| s).unwrap_or(&n.name).to_ascii_lowercase();
    match stem.as_str() {
        "readme" | "index" | "_index" => 0,
        _ => 1,
    }
}

fn compare_nodes(a: &FolderNode, b: &FolderNode) -> Ordering {
    // README/index first, then files, then folders — each naturally sorted.
    rank(a).cmp(&rank(b)).then_with(|| natural_cmp(&a.name, &b.name))
}

/// Natural ordering: "2-setup" < "10-deploy", case-insensitive.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    bi.next();
                }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                let ord = x.to_lowercase().cmp(y.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::natural_cmp;
    use std::cmp::Ordering;

    #[test]
    fn natural() {
        assert_eq!(natural_cmp("2-a", "10-a"), Ordering::Less);
        assert_eq!(natural_cmp("Alpha", "beta"), Ordering::Less);
        assert_eq!(natural_cmp("file1", "file01b"), Ordering::Less);
    }
}
