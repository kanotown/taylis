import Foundation

/// multipart/form-data with a single "file" part (POST /attachments, avatars). Compiled into the Share Extension as
/// well (MOBILE_UI.md §21): a shared file goes up in the same body as one picked in the app.
enum Multipart {
    static func head(boundary: String, filename: String, contentType: String) -> Data {
        let name = filename.replacingOccurrences(of: "\"", with: "_")
        return Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: \(contentType)\r\n\r\n".utf8)
    }

    static func tail(boundary: String) -> Data { Data("\r\n--\(boundary)--\r\n".utf8) }

    /// head + the file + tail in a temporary file, copied 1 MB at a time; the caller removes it. `destination` names
    /// the file instead (a share's body lives in the App Group container, where a background upload reads it).
    static func write(head: Data, file: URL, tail: Data, to destination: URL? = nil) throws -> URL {
        let out = destination ?? FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: out.path, contents: head) else { throw CocoaError(.fileWriteUnknown) }
        do {
            let writer = try FileHandle(forWritingTo: out)
            defer { try? writer.close() }
            try writer.seekToEnd()
            let reader = try FileHandle(forReadingFrom: file)
            defer { try? reader.close() }
            while let chunk = try reader.read(upToCount: 1 << 20), !chunk.isEmpty { try writer.write(contentsOf: chunk) }
            try writer.write(contentsOf: tail)
            return out
        } catch {
            try? FileManager.default.removeItem(at: out)
            throw error
        }
    }
}
