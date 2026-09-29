//! PDF post-processing with lopdf: outline (bookmarks), link annotations, Title metadata.

use std::path::Path;

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, StringFormat};

use super::{LinkItem, OutlineItem};

/// PDF text string: PDFDocEncoding-compatible ASCII as-is, anything else as UTF-16BE with BOM.
fn text_string(s: &str) -> Object {
    let clean: String = s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if clean.is_ascii() {
        Object::String(clean.into_bytes(), StringFormat::Literal)
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        bytes.extend(clean.encode_utf16().flat_map(u16::to_be_bytes));
        Object::String(bytes, StringFormat::Hexadecimal)
    }
}

/// Resolve an inheritable page attribute (MediaBox / CropBox).
fn page_box(doc: &Document, page: ObjectId) -> Option<[f64; 4]> {
    let mut id = page;
    for _ in 0..32 {
        let dict = doc.get_dictionary(id).ok()?;
        for key in [b"CropBox".as_slice(), b"MediaBox".as_slice()] {
            if let Ok(obj) = dict.get(key) {
                let obj = match obj {
                    Object::Reference(r) => doc.get_object(*r).ok()?,
                    o => o,
                };
                if let Ok(arr) = obj.as_array() {
                    let nums: Vec<f64> = arr
                        .iter()
                        .filter_map(|o| match o {
                            Object::Reference(r) => doc.get_object(*r).ok().and_then(|o| o.as_float().ok()),
                            o => o.as_float().ok(),
                        })
                        .map(f64::from)
                        .collect();
                    if nums.len() == 4 {
                        return Some([nums[0].min(nums[2]), nums[1].min(nums[3]), nums[0].max(nums[2]), nums[1].max(nums[3])]);
                    }
                }
            }
        }
        id = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

struct Pages {
    ids: Vec<ObjectId>,
    boxes: Vec<[f64; 4]>,
}

impl Pages {
    fn get(&self, page: u32) -> Option<(ObjectId, [f64; 4])> {
        let i = (page as usize).checked_sub(1)?;
        Some((*self.ids.get(i)?, *self.boxes.get(i)?))
    }

    /// `[page /XYZ left top null]` for a fractional y (0 = top).
    fn dest(&self, page: u32, y: f64) -> Option<Object> {
        let (id, b) = self.get(page)?;
        let top = b[3] - y.clamp(0.0, 1.0) * (b[3] - b[1]);
        Some(Object::Array(vec![
            Object::Reference(id),
            Object::Name(b"XYZ".to_vec()),
            Object::Null,
            Object::Real(top as f32),
            Object::Null,
        ]))
    }
}

fn add_outline(doc: &mut Document, pages: &Pages, items: &[OutlineItem]) -> Option<ObjectId> {
    // Build a tree from the flat (level-annotated) list.
    struct Node {
        title: String,
        dest: Object,
        children: Vec<usize>,
    }
    let mut nodes: Vec<Node> = Vec::new();
    let mut roots: Vec<usize> = Vec::new();
    let mut stack: Vec<(u32, usize)> = Vec::new(); // (level, node index)
    for it in items {
        let Some(dest) = pages.dest(it.page, it.y) else { continue };
        let idx = nodes.len();
        nodes.push(Node { title: it.title.clone(), dest, children: Vec::new() });
        while stack.last().is_some_and(|(l, _)| *l >= it.level) {
            stack.pop();
        }
        match stack.last() {
            Some((_, parent)) => nodes[*parent].children.push(idx),
            None => roots.push(idx),
        }
        stack.push((it.level, idx));
    }
    if roots.is_empty() {
        return None;
    }
    let ids: Vec<ObjectId> = nodes.iter().map(|_| doc.new_object_id()).collect();
    let outlines_id = doc.new_object_id();

    // Top-level items are open, deeper ones closed, so an item's visible descendants (or,
    // when closed, the ones shown after opening it) are exactly its direct children.
    fn visible(nodes: &[Node], i: usize) -> i64 {
        nodes[i].children.len() as i64
    }

    fn write_level(doc: &mut Document, nodes: &[Node], ids: &[ObjectId], siblings: &[usize], parent: ObjectId, depth: usize) {
        for (k, &i) in siblings.iter().enumerate() {
            let n = &nodes[i];
            let mut d = Dictionary::new();
            d.set("Title", text_string(&n.title));
            d.set("Parent", parent);
            d.set("Dest", n.dest.clone());
            if k > 0 {
                d.set("Prev", ids[siblings[k - 1]]);
            }
            if k + 1 < siblings.len() {
                d.set("Next", ids[siblings[k + 1]]);
            }
            if let (Some(f), Some(l)) = (n.children.first(), n.children.last()) {
                d.set("First", ids[*f]);
                d.set("Last", ids[*l]);
                let count = visible(nodes, i);
                // Positive = open. Keep the first level expanded, the rest collapsed.
                d.set("Count", if depth == 0 { count } else { -count });
                write_level(doc, nodes, ids, &n.children, ids[i], depth + 1);
            }
            doc.objects.insert(ids[i], Object::Dictionary(d));
        }
    }
    write_level(doc, &nodes, &ids, &roots, outlines_id, 0);

    let total_open: i64 = roots.len() as i64 + roots.iter().map(|r| visible(&nodes, *r)).sum::<i64>();
    let outlines = dictionary! {
        "Type" => "Outlines",
        "First" => ids[roots[0]],
        "Last" => ids[*roots.last().unwrap()],
        "Count" => total_open,
    };
    doc.objects.insert(outlines_id, Object::Dictionary(outlines));
    Some(outlines_id)
}

fn add_links(doc: &mut Document, pages: &Pages, links: &[LinkItem]) {
    for l in links {
        let Some((page_id, b)) = pages.get(l.page) else { continue };
        let (pw, ph) = (b[2] - b[0], b[3] - b[1]);
        let x0 = b[0] + l.x.clamp(0.0, 1.0) * pw;
        let x1 = b[0] + (l.x + l.w).clamp(0.0, 1.0) * pw;
        let y_top = b[3] - l.y.clamp(0.0, 1.0) * ph;
        let y_bot = b[3] - (l.y + l.h).clamp(0.0, 1.0) * ph;
        if x1 - x0 < 0.5 || y_top - y_bot < 0.5 {
            continue;
        }
        let mut annot = dictionary! {
            "Type" => "Annot",
            "Subtype" => "Link",
            "Rect" => vec![Object::Real(x0 as f32), Object::Real(y_bot as f32), Object::Real(x1 as f32), Object::Real(y_top as f32)],
            "Border" => vec![0.into(), 0.into(), 0.into()],
        };
        if let Some(uri) = l.uri.as_deref().filter(|u| !u.is_empty()) {
            annot.set(
                "A",
                dictionary! { "S" => "URI", "URI" => Object::String(uri.as_bytes().to_vec(), StringFormat::Literal) },
            );
        } else if let Some(dest) = l.dest_page.and_then(|p| pages.dest(p, l.dest_y.unwrap_or(0.0))) {
            annot.set("Dest", dest);
        } else {
            continue;
        }
        annot.set("P", page_id);
        let annot_id = doc.add_object(Object::Dictionary(annot));

        // Append to the page's /Annots (inline array or reference to an array).
        let existing = doc.get_dictionary(page_id).ok().and_then(|d| d.get(b"Annots").ok().cloned());
        match existing {
            Some(Object::Reference(arr_id)) => {
                if let Ok(Object::Array(arr)) = doc.get_object_mut(arr_id) {
                    arr.push(Object::Reference(annot_id));
                }
            }
            Some(Object::Array(mut arr)) => {
                arr.push(Object::Reference(annot_id));
                if let Ok(d) = doc.get_dictionary_mut(page_id) {
                    d.set("Annots", Object::Array(arr));
                }
            }
            _ => {
                if let Ok(d) = doc.get_dictionary_mut(page_id) {
                    d.set("Annots", Object::Array(vec![Object::Reference(annot_id)]));
                }
            }
        }
    }
}

fn set_title(doc: &mut Document, title: &str) {
    let info_id = match doc.trailer.get(b"Info").and_then(Object::as_reference) {
        Ok(id) => id,
        Err(_) => {
            let id = doc.add_object(Object::Dictionary(Dictionary::new()));
            doc.trailer.set("Info", id);
            id
        }
    };
    if let Ok(info) = doc.get_dictionary_mut(info_id) {
        info.set("Title", text_string(title));
        info.set("Creator", text_string("MD Reader"));
    }
    // Ask viewers to show the title rather than the file name.
    if let Ok(cat) = doc.catalog_mut() {
        let mut prefs = match cat.get(b"ViewerPreferences") {
            Ok(Object::Dictionary(d)) => d.clone(),
            _ => Dictionary::new(),
        };
        prefs.set("DisplayDocTitle", true);
        cat.set("ViewerPreferences", Object::Dictionary(prefs));
    }
}

/// Loads `src`, adds title/outline/links and writes the result to `dst`. Returns the page count.
pub fn post_process(src: &Path, dst: &Path, title: Option<&str>, outline: &[OutlineItem], links: &[LinkItem]) -> Result<u32, String> {
    let mut doc = Document::load(src).map_err(|e| format!("could not read printed PDF: {e}"))?;
    let page_map = doc.get_pages();
    let ids: Vec<ObjectId> = page_map.values().copied().collect();
    let boxes: Vec<[f64; 4]> = ids.iter().map(|id| page_box(&doc, *id).unwrap_or([0.0, 0.0, 595.0, 842.0])).collect();
    let pages = Pages { ids, boxes };

    if let Some(t) = title.filter(|t| !t.trim().is_empty()) {
        set_title(&mut doc, t.trim());
    }
    if !links.is_empty() {
        add_links(&mut doc, &pages, links);
    }
    if let Some(outlines_id) = add_outline(&mut doc, &pages, outline) {
        let cat = doc.catalog_mut().map_err(|e| e.to_string())?;
        cat.set("Outlines", outlines_id);
        cat.set("PageMode", "UseOutlines");
    }
    doc.compress();
    let tmp = dst.with_extension("mdr-tmp");
    doc.save(&tmp).map_err(|e| format!("could not write PDF: {e}"))?;
    std::fs::rename(&tmp, dst).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("could not write {}: {e}", dst.display())
    })?;
    Ok(pages.ids.len() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::{Content, Operation};

    fn sample_pdf(path: &Path, n: usize) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut kids = Vec::new();
        for _ in 0..n {
            let content = Content { operations: vec![Operation::new("BT", vec![]), Operation::new("ET", vec![])] };
            let cid = doc.add_object(lopdf::Stream::new(dictionary! {}, content.encode().unwrap()));
            let pid = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => cid });
            kids.push(Object::Reference(pid));
        }
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => kids, "Count" => n as i64,
                "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            }),
        );
        let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        doc.trailer.set("Root", cat);
        doc.save(path).unwrap();
    }

    #[test]
    fn adds_outline_links_and_title() {
        let dir = std::env::temp_dir();
        let src = dir.join(format!("mdr-outline-src-{}.pdf", std::process::id()));
        let dst = dir.join(format!("mdr-outline-dst-{}.pdf", std::process::id()));
        sample_pdf(&src, 3);
        let item = |t: &str, level, page| OutlineItem { title: t.into(), level, page, y: 0.1 };
        let outline = vec![item("Guide", 0, 1), item("Intro ✓", 1, 1), item("Deep", 2, 2), item("Next", 1, 3), item("Appendix", 0, 3), item("bad", 0, 99)];
        let links = vec![LinkItem { page: 1, x: 0.1, y: 0.1, w: 0.5, h: 0.02, uri: None, dest_page: Some(3), dest_y: Some(0.2) }];
        let n = post_process(&src, &dst, Some("Tïtle"), &outline, &links).unwrap();
        assert_eq!(n, 3);
        let doc = Document::load(&dst).unwrap();
        let cat = doc.catalog().unwrap();
        let outlines = doc.get_dictionary(cat.get(b"Outlines").unwrap().as_reference().unwrap()).unwrap();
        assert_eq!(outlines.get(b"Count").unwrap().as_i64().unwrap(), 4);
        let first = doc.get_dictionary(outlines.get(b"First").unwrap().as_reference().unwrap()).unwrap();
        assert_eq!(first.get(b"Title").unwrap().as_str().unwrap(), b"Guide");
        assert_eq!(first.get(b"Count").unwrap().as_i64().unwrap(), 2);
        let pages = doc.get_pages();
        let p1 = doc.get_dictionary(pages[&1]).unwrap();
        assert_eq!(p1.get(b"Annots").unwrap().as_array().unwrap().len(), 1);
        let _ = std::fs::remove_file(&src);
        let _ = std::fs::remove_file(&dst);
    }
}
