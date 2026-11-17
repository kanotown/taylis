import Foundation

/// Names for files that reach an upload without a real one (docs/CHANNEL_FILES.md §4.4, apps/shared/upload-names.json):
/// library photos lose their name on the way (they were all 「photo.jpg」), so they piled up in a channel's drive as
/// photo.jpg, photo (1).jpg … They are named by the time they were added instead: 「photo_20261117_090503.jpg」, with
/// _2, _3 … for the 2nd, 3rd … unnamed file in the same second. Compiled into the share extension too.
enum UploadNames {
    private static let imageExts: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "avif"]
    private static let videoExts: Set<String> = ["mov", "mp4", "m4v", "webm"]

    /// Empty, a client's placeholder (「file」, 「photo.jpg」, 「video.mov」) or a clipboard's 「image.png」.
    static func isUnnamed(_ name: String) -> Bool {
        let lower = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lower.isEmpty || lower == "file" { return true }
        guard let dot = lower.lastIndex(of: ".") else { return false }
        let stem = lower[..<dot]
        let ext = String(lower[lower.index(after: dot)...])
        if stem == "image" || stem == "photo" { return imageExts.contains(ext) }
        if stem == "video" { return videoExts.contains(ext) }
        return false
    }

    /// image/* → image, video/* → video, anything else → file.
    static func kind(mime: String) -> String {
        let lower = mime.lowercased()
        if lower.hasPrefix("image/") { return "image" }
        if lower.hasPrefix("video/") { return "video" }
        return "file"
    }

    /// 「20261117_090503」 in the device's time zone; Gregorian with ASCII digits whatever the phone's calendar.
    static func stamp(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let p = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return String(format: "%04d%02d%02d_%02d%02d%02d", p.year ?? 0, p.month ?? 0, p.day ?? 0, p.hour ?? 0, p.minute ?? 0, p.second ?? 0)
    }

    /// 「photo_20261117_090503_2.jpg」: `index` 1 has no suffix; no dot without an extension.
    static func name(kind: String, ext: String, at date: Date, index: Int) -> String {
        let suffix = index > 1 ? "_\(index)" : ""
        let lower = ext.lowercased()
        return "\(kind)_\(stamp(date))\(suffix)" + (lower.isEmpty ? "" : ".\(lower)")
    }

    /// The next name of this process's unnamed files (`UploadNamer.shared`).
    static func next(kind: String, ext: String, at date: Date = Date()) -> String {
        UploadNamer.shared.next(kind: kind, ext: ext, at: date)
    }
}

/// Counts the unnamed files of one second (any kind), so two added in the same second get different names.
final class UploadNamer {
    static let shared = UploadNamer()

    private let lock = NSLock()
    private var stamp = ""
    private var count = 0

    func next(kind: String, ext: String, at date: Date = Date()) -> String {
        let stamp = UploadNames.stamp(date)
        lock.lock()
        count = stamp == self.stamp ? count + 1 : 1
        self.stamp = stamp
        let index = count
        lock.unlock()
        return UploadNames.name(kind: kind, ext: ext, at: date, index: index)
    }
}
