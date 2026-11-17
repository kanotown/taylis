import CryptoKit
import Foundation

/// Server strings that reach a file path on this device (2026-11-16, a hostile-server review): an attachment id `..` or
/// `../../Library/…` put the app's files wherever the server liked. An id is used as it is only when it has a UUID's
/// shape (else its hash is), a name loses its separators, and every path is checked to stay under its root.
enum SafePaths {
    private static let uuidShape = try! NSRegularExpression(pattern: "^[0-9a-f-]{36}$", options: [.caseInsensitive])

    /// Whether `id` has a UUID's shape (36 hex digits and dashes): only those name a file or a folder as they are.
    static func isUUIDShaped(_ id: String) -> Bool {
        uuidShape.firstMatch(in: id, range: NSRange(location: 0, length: (id as NSString).length)) != nil
    }

    /// An id from a server as one path component: a UUID-shaped one as it is, anything else (`..`, `a/b`, empty, very
    /// long) as `h-` and its SHA-256 (no two ids share a component; none climbs out).
    static func idComponent(_ id: String) -> String {
        if isUUIDShaped(id) { return id }
        return "h-" + digest(id)
    }

    /// A name from a server (a file's) as one path component: `/`, `\`, `:` and control characters become `_`;
    /// empty, `.` and `..` become `fallback`; at most 200 characters (the extension kept).
    static func nameComponent(_ name: String, fallback: String = "file") -> String {
        var cleaned = String(String.UnicodeScalarView(name.unicodeScalars.map { scalar -> Unicode.Scalar in
            scalar == "/" || scalar == "\\" || scalar == ":" || scalar.properties.generalCategory == .control ? "_" : scalar
        })).trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty || cleaned == "." || cleaned == ".." { return fallback }
        if cleaned.count > 200 {
            let ext = (cleaned as NSString).pathExtension
            let keep = ext.isEmpty || ext.count > 20 ? "" : "." + ext
            cleaned = String(cleaned.prefix(200 - keep.count)) + keep
        }
        return cleaned
    }

    /// `root` with `components` appended, or nil when the result is not strictly inside `root` (a component with a
    /// separator, `..`, or one that resolves to the root itself).
    static func file(under root: URL, _ components: [String], isDirectory: Bool = false) -> URL? {
        guard !components.isEmpty else { return nil }
        var url = root
        for (index, component) in components.enumerated() {
            let last = index == components.count - 1
            url = url.appendingPathComponent(component, isDirectory: last ? isDirectory : true)
        }
        return isInside(url, root: root) ? url : nil
    }

    /// Whether `url` lies strictly inside `root`, compared as spelled (LexicalPath: `standardizedFileURL` refused every
    /// file not yet written on a phone, 2026-11-17).
    static func isInside(_ url: URL, root: URL) -> Bool {
        LexicalPath.isInside(url, root: root)
    }

    /// A short key for a server URL in a path (its normalized spelling hashed): its caches never share a folder.
    static func serverKey(_ serverUrl: String) -> String {
        digest(Workspaces.normalize(serverUrl) ?? serverUrl)
    }

    private static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }
}
