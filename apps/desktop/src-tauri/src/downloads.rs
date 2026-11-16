//! A saved download is marked as coming from the internet (2026-11-16, a hostile-server review): the app is used with
//! servers other people run, and a file a server hands out must meet the same checks as one from a browser.
//!
//! - Windows: the mark of the web, the `Zone.Identifier` alternate data stream with `ZoneId=3` (the Internet zone),
//!   as browsers write it: SmartScreen checks a program, Office opens a document in Protected View, and Explorer passes
//!   the mark on to what it unpacks from an archive.
//! - macOS: the quarantine (`NSURLQuarantinePropertiesKey`, which writes `com.apple.quarantine`): Gatekeeper checks a
//!   program or app before it first runs, and Archive Utility quarantines what it unpacks. Not `LSFileQuarantineEnabled`
//!   in Info.plist: that quarantines every file the app writes (its database, caches, the updater's new bundle).
//!
//! The page writes the file (tauri-plugin-fs) and then asks for the mark (src/platform/download.ts markDownloaded).
//! Best effort: a disk without streams or extended attributes (FAT, some network shares) keeps the file unmarked.

use std::path::Path;

/// The source written into the mark: an http(s) URL on one line, else none.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
fn source_url(source: Option<&str>) -> Option<&str> {
    let source = source?.trim();
    let web = source.starts_with("https://") || source.starts_with("http://");
    (web && source.len() <= 2048 && !source.chars().any(char::is_control)).then_some(source)
}

/// The `Zone.Identifier` stream's text, as Chromium and Edge write it.
#[cfg_attr(not(windows), allow(dead_code))]
fn zone_identifier(source: Option<&str>) -> String {
    let mut text = String::from("[ZoneTransfer]\r\nZoneId=3\r\n");
    if let Some(url) = source_url(source) {
        text.push_str(&format!("ReferrerUrl={url}\r\nHostUrl={url}\r\n"));
    }
    text
}

/// Marks the file at `path` (a regular file, not a link) as downloaded from `source` (the server's URL).
#[tauri::command]
pub fn download_mark(path: String, source: Option<String>) -> Result<(), String> {
    let path = Path::new(&path);
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !path.is_absolute() || !meta.file_type().is_file() {
        return Err("not a downloaded file".to_owned());
    }
    mark(path, source.as_deref())
}

#[cfg(windows)]
fn mark(path: &Path, source: Option<&str>) -> Result<(), String> {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    std::fs::write(&stream, zone_identifier(source)).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn mark(path: &Path, source: Option<&str>) -> Result<(), String> {
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSString, NSURLQuarantinePropertiesKey, NSURL};

    let text = path.to_str().ok_or("the path is not UTF-8")?;
    let file = NSURL::fileURLWithPath(&NSString::from_str(text));
    // Launch Services' keys (kLSQuarantineAgentNameKey …), as strings: their constants live in CoreServices.
    let keys = ["LSQuarantineAgentName", "LSQuarantineType", "LSQuarantineOriginURL", "LSQuarantineDataURL"].map(NSString::from_str);
    let agent = NSString::from_str("Taylis");
    let kind = NSString::from_str("LSQuarantineTypeWebDownload");
    let origin = source_url(source).and_then(|url| NSURL::URLWithString(&NSString::from_str(url)));
    let mut key_refs: Vec<&NSString> = vec![&keys[0], &keys[1]];
    let mut values: Vec<&AnyObject> = vec![&agent, &kind];
    if let Some(origin) = origin.as_deref() {
        key_refs.extend([&*keys[2], &*keys[3]]);
        values.extend([origin as &AnyObject, origin as &AnyObject]);
    }
    let properties = NSDictionary::<NSString, AnyObject>::from_slices(&key_refs, &values);
    // SAFETY: NSURLQuarantinePropertiesKey is Foundation's constant; its value is a dictionary of the keys above
    // (strings and URLs), as Apple documents it.
    unsafe { file.setResourceValue_forKey_error(Some(&properties), NSURLQuarantinePropertiesKey) }.map_err(|e| e.localizedDescription().to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn mark(_path: &Path, _source: Option<&str>) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_zone_identifier_names_the_internet_zone_and_the_server() {
        assert_eq!(zone_identifier(None), "[ZoneTransfer]\r\nZoneId=3\r\n");
        assert_eq!(
            zone_identifier(Some("https://chat.example.com")),
            "[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://chat.example.com\r\nHostUrl=https://chat.example.com\r\n"
        );
        // Anything but a URL on one line is left out (no new keys smuggled into the stream).
        assert_eq!(zone_identifier(Some("https://a.example\r\nZoneId=0")), "[ZoneTransfer]\r\nZoneId=3\r\n");
        assert_eq!(zone_identifier(Some("file:///etc/passwd")), "[ZoneTransfer]\r\nZoneId=3\r\n");
    }

    #[test]
    fn only_a_regular_file_is_marked() {
        let dir = std::env::temp_dir().join(format!("taylis-mark-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(download_mark(dir.to_string_lossy().into_owned(), None).is_err());
        assert!(download_mark("relative.pdf".to_owned(), None).is_err());
        let file = dir.join("report.pdf");
        std::fs::write(&file, b"%PDF-1.4").unwrap();
        let marked = download_mark(file.to_string_lossy().into_owned(), Some("https://chat.example.com".to_owned()));
        #[cfg(target_os = "macos")]
        {
            marked.unwrap();
            let out = std::process::Command::new("/usr/bin/xattr").args(["-p", "com.apple.quarantine"]).arg(&file).output().unwrap();
            // "flags;time;agent;event": the system fills it in (the agent is the app bundle's name; a test has none).
            let value = String::from_utf8_lossy(&out.stdout);
            assert!(out.status.success() && value.split(';').count() >= 3, "quarantine: {value}");
        }
        #[cfg(not(target_os = "macos"))]
        let _ = marked;
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
