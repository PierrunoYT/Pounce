//! Preview pane content and in-place text editing.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Bytes shown when previewing (not editing) a text file.
const PREVIEW_BYTES: usize = 512 * 1024;
/// Largest file that can be edited inline.
pub const EDIT_MAX_BYTES: u64 = 8 * 1024 * 1024;
const DIR_LIMIT: usize = 1000;
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "bmp", "ico", "webp"];

pub enum Content {
    Text {
        text: String,
        /// Only the first [`PREVIEW_BYTES`] were read.
        truncated: bool,
    },
    Image(String),
    Binary(String),
    Directory { entries: Vec<(bool, String)>, total: usize },
    Message(String),
}

pub enum SaveError {
    /// The file was modified on disk after it was loaded.
    Conflict,
    Io(String),
}

pub struct Preview {
    pub path: PathBuf,
    pub content: Content,
    pub editing: bool,
    /// Edit buffer with `\n` line endings.
    pub buffer: String,
    pub dirty: bool,
    pub conflict: bool,
    /// Why the file cannot be edited inline, if it cannot.
    pub not_editable: Option<String>,
    loaded_mtime: Option<SystemTime>,
    crlf: bool,
    bom: bool,
}

impl Preview {
    pub fn load(path: &Path, is_dir: bool) -> Preview {
        let mut p = Preview {
            path: path.to_path_buf(),
            content: Content::Message(String::new()),
            editing: false,
            buffer: String::new(),
            dirty: false,
            conflict: false,
            not_editable: None,
            loaded_mtime: None,
            crlf: false,
            bom: false,
        };
        p.content = if is_dir { load_dir(path) } else { p.load_file() };
        p
    }

    fn load_file(&mut self) -> Content {
        let meta = match fs::metadata(&self.path) {
            Ok(m) => m,
            Err(e) => {
                self.not_editable = Some("file not readable".into());
                return Content::Message(format!("Cannot read file: {e}"));
            }
        };
        self.loaded_mtime = meta.modified().ok();
        let ext = self.path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
            self.not_editable = Some("image".into());
            return Content::Image(format!("file://{}", self.path.display()));
        }

        let mut buf = Vec::with_capacity(PREVIEW_BYTES.min(meta.len() as usize));
        if let Err(e) = fs::File::open(&self.path).and_then(|f| f.take(PREVIEW_BYTES as u64).read_to_end(&mut buf)) {
            self.not_editable = Some("file not readable".into());
            return Content::Message(format!("Cannot read file: {e}"));
        }
        if buf.iter().take(8192).any(|&b| b == 0) {
            self.not_editable = Some("binary file".into());
            return Content::Binary(hex_dump(&buf[..buf.len().min(4096)]));
        }

        let truncated = (buf.len() as u64) < meta.len();
        if meta.len() > EDIT_MAX_BYTES {
            self.not_editable = Some(format!("larger than {} MB", EDIT_MAX_BYTES / (1024 * 1024)));
        }
        let (text, valid) = self.decode(&buf, truncated);
        if !valid {
            self.not_editable = Some("not UTF-8 text".into());
        }
        Content::Text { text, truncated }
    }

    /// Decodes bytes as UTF-8 (lossy for display); records BOM and line-ending style.
    fn decode(&mut self, bytes: &[u8], truncated: bool) -> (String, bool) {
        let (bom, body) = match bytes.strip_prefix(b"\xEF\xBB\xBF") {
            Some(rest) => (true, rest),
            None => (false, bytes),
        };
        self.bom = bom;
        let (text, valid) = match std::str::from_utf8(body) {
            Ok(s) => (s.to_string(), true),
            // A truncated preview may cut a multi-byte character in half.
            Err(e) if truncated && e.error_len().is_none() => (String::from_utf8_lossy(&body[..e.valid_up_to()]).into_owned(), true),
            Err(_) => (String::from_utf8_lossy(body).into_owned(), false),
        };
        self.crlf = text.contains("\r\n");
        (if self.crlf { text.replace("\r\n", "\n") } else { text }, valid)
    }

    pub fn can_edit(&self) -> bool {
        matches!(self.content, Content::Text { .. }) && self.not_editable.is_none()
    }

    pub fn begin_edit(&mut self) -> Result<(), String> {
        if let Some(reason) = &self.not_editable {
            return Err(format!("Cannot edit inline: {reason}"));
        }
        let Content::Text { text, truncated } = &self.content else {
            return Err("Only text files can be edited inline".into());
        };
        self.buffer = if *truncated {
            let bytes = fs::read(&self.path).map_err(|e| e.to_string())?;
            self.loaded_mtime = fs::metadata(&self.path).and_then(|m| m.modified()).ok();
            let (text, valid) = self.decode(&bytes, false);
            if !valid {
                return Err("Cannot edit inline: not UTF-8 text".into());
            }
            text
        } else {
            text.clone()
        };
        self.editing = true;
        self.dirty = false;
        self.conflict = false;
        Ok(())
    }

    pub fn cancel_edit(&mut self) {
        self.editing = false;
        self.dirty = false;
        self.conflict = false;
        self.buffer.clear();
    }

    /// Writes the edit buffer. Refuses when the file changed on disk unless `force`.
    pub fn save(&mut self, force: bool) -> Result<(), SaveError> {
        let current = fs::metadata(&self.path).and_then(|m| m.modified()).ok();
        if !force && current.is_some() && current != self.loaded_mtime {
            self.conflict = true;
            return Err(SaveError::Conflict);
        }
        let mut out = Vec::with_capacity(self.buffer.len() + 3);
        if self.bom {
            out.extend_from_slice(b"\xEF\xBB\xBF");
        }
        if self.crlf {
            out.extend_from_slice(self.buffer.replace('\n', "\r\n").as_bytes());
        } else {
            out.extend_from_slice(self.buffer.as_bytes());
        }
        fs::write(&self.path, &out).map_err(|e| SaveError::Io(e.to_string()))?;

        self.loaded_mtime = fs::metadata(&self.path).and_then(|m| m.modified()).ok();
        self.dirty = false;
        self.conflict = false;
        let truncated = out.len() > PREVIEW_BYTES;
        let shown = if truncated { truncate_at_char(&self.buffer, PREVIEW_BYTES) } else { self.buffer.clone() };
        self.content = Content::Text { text: shown, truncated };
        Ok(())
    }

    /// Reloads from disk, discarding edits.
    pub fn reload(&mut self, is_dir: bool) {
        *self = Preview::load(&self.path.clone(), is_dir);
    }
}

fn truncate_at_char(s: &str, max: usize) -> String {
    let mut end = max.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

fn load_dir(path: &Path) -> Content {
    match fs::read_dir(path) {
        Ok(rd) => {
            let mut entries: Vec<(bool, String)> = rd
                .flatten()
                .map(|e| (e.file_type().is_ok_and(|t| t.is_dir()), e.file_name().to_string_lossy().into_owned()))
                .collect();
            entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
            let total = entries.len();
            entries.truncate(DIR_LIMIT);
            Content::Directory { entries, total }
        }
        Err(e) => Content::Message(format!("Cannot read folder: {e}")),
    }
}

fn hex_dump(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 4);
    for (row, chunk) in bytes.chunks(16).enumerate() {
        out.push_str(&format!("{:08x}  ", row * 16));
        for b in chunk {
            out.push_str(&format!("{b:02x} "));
        }
        out.push_str(&"   ".repeat(16 - chunk.len()));
        out.push(' ');
        out.extend(chunk.iter().map(|&b| if b.is_ascii_graphic() || b == b' ' { b as char } else { '.' }));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fsc-preview-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        fs::write(&p, bytes).unwrap();
        p
    }

    #[test]
    fn edits_preserve_bom_and_crlf() {
        let path = temp("crlf.txt", b"\xEF\xBB\xBFone\r\ntwo\r\n");
        let mut p = Preview::load(&path, false);
        assert!(matches!(&p.content, Content::Text { text, .. } if text == "one\ntwo\n"));
        p.begin_edit().unwrap();
        p.buffer.push_str("three\n");
        p.dirty = true;
        assert!(p.save(false).is_ok());
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFone\r\ntwo\r\nthree\r\n");
        assert!(!p.dirty);
    }

    #[test]
    fn detects_conflicting_changes_on_disk() {
        let path = temp("conflict.txt", b"a\n");
        let mut p = Preview::load(&path, false);
        p.begin_edit().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&path, b"changed elsewhere\n").unwrap();
        let f = fs::File::options().write(true).open(&path).unwrap();
        f.set_modified(SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
        p.buffer = "mine\n".into();
        assert!(matches!(p.save(false), Err(SaveError::Conflict)));
        assert!(p.save(true).is_ok());
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine\n");
    }

    #[test]
    fn binary_and_images_are_not_editable() {
        let bin = temp("data.bin", &[0, 1, 2, 3, 255]);
        let p = Preview::load(&bin, false);
        assert!(matches!(p.content, Content::Binary(_)));
        assert!(!p.can_edit());
        let img = temp("pic.png", b"not really a png");
        assert!(matches!(Preview::load(&img, false).content, Content::Image(_)));
    }
}
