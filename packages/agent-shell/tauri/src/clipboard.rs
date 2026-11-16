//! OS pasteboard reads for the chat composer.
//!
//! WKWebView does not deliver copied files or screenshots to the page.
//! File lists are read on macOS and Windows. Image data is encoded as PNG
//! on every desktop.

use base64::{engine::general_purpose::STANDARD, Engine};
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder};
use serde::Serialize;

const MAX_CLIPBOARD_IMAGE_BYTES: usize = 32 * 1024 * 1024;
const MAX_CLIPBOARD_FILES: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFile {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardContents {
    pub text: String,
    pub files: Vec<ClipboardFile>,
}

/// Files win over text, and text wins over a bare image.
///
/// The file manager copies a path string next to the file list. Returning
/// that string would also paste the path into the composer. A screenshot
/// has no text.
pub fn read_clipboard() -> ClipboardContents {
    let files = clipboard_file_paths()
        .into_iter()
        .take(MAX_CLIPBOARD_FILES)
        .map(|path| ClipboardFile {
            name: file_name(&path),
            path: Some(path),
            data_base64: None,
            mime: None,
        })
        .collect::<Vec<_>>();
    if !files.is_empty() {
        return ClipboardContents {
            text: String::new(),
            files,
        };
    }
    let text = read_clipboard_text();
    if !text.is_empty() {
        return ClipboardContents {
            text,
            files: Vec::new(),
        };
    }
    ClipboardContents {
        text: String::new(),
        files: clipboard_image().into_iter().collect(),
    }
}

pub fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| path.to_string())
}

pub fn read_clipboard_text() -> String {
    let Ok(mut clipboard) = arboard::Clipboard::new() else {
        return String::new();
    };
    clipboard.get_text().unwrap_or_default()
}

fn clipboard_image() -> Option<ClipboardFile> {
    clipboard_image_from(pasteboard_png(), encoded_png)
}

/// Builds the pasted image from the pasteboard PNG when there is one, and only
/// falls back to decoding when the pasteboard holds another format.
fn clipboard_image_from(
    pasteboard_png: Option<Vec<u8>>,
    encoded: impl FnOnce() -> Option<Vec<u8>>,
) -> Option<ClipboardFile> {
    let png = pasteboard_png.or_else(encoded)?;
    Some(ClipboardFile {
        name: "image.png".to_string(),
        path: None,
        data_base64: Some(STANDARD.encode(png)),
        mime: Some("image/png".to_string()),
    })
}

/// Pasteboard images that are already PNG.
///
/// Screenshot tools publish `public.png`, so the bytes are copied as they are.
/// Decoding to RGBA and re-encoding cost ~1s per 2560x1440 screenshot, which
/// ran inside the Cmd+V menu callback and dropped the next paste.
#[cfg(target_os = "macos")]
fn pasteboard_png() -> Option<Vec<u8>> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::ns_string;

    let pasteboard = NSPasteboard::generalPasteboard();
    let data = pasteboard.dataForType(ns_string!("public.png"))?;
    let bytes = data.to_vec();
    if bytes.is_empty() || bytes.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return None;
    }
    Some(bytes)
}

#[cfg(not(target_os = "macos"))]
fn pasteboard_png() -> Option<Vec<u8>> {
    None
}

/// Formats that need decoding first. Only reached when the pasteboard holds
/// no PNG, for example a TIFF-only image copy from an older application.
fn encoded_png() -> Option<Vec<u8>> {
    let mut clipboard = arboard::Clipboard::new().ok()?;
    let image = clipboard.get_image().ok()?;
    png_from_rgba(image.width, image.height, image.bytes.as_ref())
}

pub fn png_from_rgba(width: usize, height: usize, bytes: &[u8]) -> Option<Vec<u8>> {
    let width = u32::try_from(width).ok()?;
    let height = u32::try_from(height).ok()?;
    let expected = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    if bytes.len() != expected || expected > MAX_CLIPBOARD_IMAGE_BYTES {
        return None;
    }
    let mut png = std::io::Cursor::new(Vec::new());
    PngEncoder::new(&mut png)
        .write_image(bytes, width, height, ExtendedColorType::Rgba8)
        .ok()?;
    let encoded = png.into_inner();
    if encoded.len() > MAX_CLIPBOARD_IMAGE_BYTES {
        return None;
    }
    Some(encoded)
}

fn clipboard_file_paths() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        macos_file_paths()
    }
    #[cfg(target_os = "windows")]
    {
        windows_file_paths()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

/// Explorer stores a copied selection as `CF_HDROP`.
#[cfg(target_os = "windows")]
fn windows_file_paths() -> Vec<String> {
    let files: Vec<String> =
        clipboard_win::get_clipboard(clipboard_win::formats::FileList).unwrap_or_default();
    files.into_iter().filter(|path| !path.is_empty()).collect()
}

#[cfg(target_os = "macos")]
fn macos_file_paths() -> Vec<String> {
    use objc2::ClassType;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSURL};

    let pasteboard = NSPasteboard::generalPasteboard();
    let classes = NSArray::from_slice(&[NSURL::class()]);
    // `class_array` is `NSURL`. `options` is nil, then non-file URLs are dropped.
    let from_urls = unsafe { pasteboard.readObjectsForClasses_options(&classes, None) }
        .map(|items| {
            items
                .to_vec()
                .into_iter()
                .filter_map(|item| item.downcast::<NSURL>().ok())
                .filter(|url| url.isFileURL())
                .filter_map(|url| url.path())
                .map(|path| path.to_string())
                .filter(|path| !path.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !from_urls.is_empty() {
        return from_urls;
    }
    legacy_filename_paths(&pasteboard)
}

/// Finder still writes this deprecated list on some copies.
#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn legacy_filename_paths(pasteboard: &objc2_app_kit::NSPasteboard) -> Vec<String> {
    use objc2_app_kit::NSFilenamesPboardType;
    use objc2_foundation::{NSArray, NSString};

    let Some(list) = pasteboard.propertyListForType(unsafe { NSFilenamesPboardType }) else {
        return Vec::new();
    };
    let Ok(array) = list.downcast::<NSArray>() else {
        return Vec::new();
    };
    array
        .to_vec()
        .into_iter()
        .filter_map(|item| item.downcast::<NSString>().ok())
        .map(|path| path.to_string())
        .filter(|path| !path.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_name_uses_the_last_path_segment() {
        assert_eq!(file_name("/tmp/纪要.docx"), "纪要.docx");
        assert_eq!(file_name("notes.txt"), "notes.txt");
    }

    #[test]
    fn png_from_rgba_encodes_one_pixel_and_rejects_a_bad_buffer() {
        let png = png_from_rgba(1, 1, &[255, 0, 0, 255]).expect("1x1 rgba encodes");
        assert_eq!(&png[..4], &[0x89, b'P', b'N', b'G']);
        assert!(png_from_rgba(2, 2, &[0, 0, 0, 0]).is_none());
        assert!(png_from_rgba(usize::MAX, usize::MAX, &[]).is_none());
    }

    /// A pasteboard PNG is passed through, so a screenshot never pays for a
    /// decode plus re-encode inside the Cmd+V callback.
    #[test]
    fn a_pasteboard_png_skips_the_decode_and_re_encode() {
        let calls = std::cell::Cell::new(0);
        let file = clipboard_image_from(Some(vec![0x89, b'P', b'N', b'G']), || {
            calls.set(calls.get() + 1);
            None
        })
        .expect("a PNG pasteboard yields one file");
        assert_eq!(calls.get(), 0);
        assert_eq!(file.mime.as_deref(), Some("image/png"));
        assert_eq!(
            STANDARD
                .decode(file.data_base64.expect("bytes are attached"))
                .expect("base64 decodes"),
            vec![0x89, b'P', b'N', b'G']
        );
    }

    /// A TIFF-only copy still reaches the composer through the decoder.
    #[test]
    fn an_image_without_a_pasteboard_png_is_encoded() {
        let file = clipboard_image_from(None, || Some(vec![0x89, b'P', b'N', b'G']))
            .expect("the encoded image yields one file");
        assert_eq!(file.mime.as_deref(), Some("image/png"));
    }

    /// Nothing on the pasteboard yields no file rather than an empty one.
    #[test]
    fn an_empty_pasteboard_yields_no_image() {
        assert!(clipboard_image_from(None, || None).is_none());
    }
}
