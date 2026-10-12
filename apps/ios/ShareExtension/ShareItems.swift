import QuickLookThumbnailing
import UIKit
import UniformTypeIdentifiers

/// A shared file, copied into the share's folder in the App Group (never read whole into memory).
struct StagedFile: Identifiable, Equatable {
    var id: String { file }
    /// Its name in the share's `files/` folder.
    var file: String
    var url: URL
    var filename: String
    var contentType: String
    var size: Int64
    var isImage: Bool { contentType.hasPrefix("image/") }
    var isVideo: Bool { contentType.hasPrefix("video/") }
}

/// What the other app shared: files to attach, and texts and links for the message.
struct SharedInput {
    var files: [StagedFile] = []
    var texts: [String] = []
    /// Items that could not be read (an app that offers a type it then fails to give).
    var unreadable = 0
}

/// Reads the NSItemProviders of a share (MOBILE_UI.md §20.1).
enum ShareItems {
    /// Each provider in turn: a web link or a text becomes part of the message, anything else (a file, a picture, a
    /// video, a PDF from GoodNotes or Files) is copied into `folder` by its file representation, streamed by the
    /// system; a picture that exists only in memory (a screenshot's markup) is written as JPEG.
    static func load(_ providers: [NSItemProvider], into folder: URL) async -> SharedInput {
        var input = SharedInput()
        for (index, provider) in providers.enumerated() {
            if let text = await webLink(provider) {
                input.texts.append(text)
                continue
            }
            if let typeId = fileType(provider) {
                if let file = await copyFile(provider, typeId: typeId, index: index, into: folder) {
                    input.files.append(file)
                } else {
                    input.unreadable += 1
                }
                continue
            }
            if let text = await plainText(provider) {
                input.texts.append(text)
                continue
            }
            input.unreadable += 1
        }
        return input
    }

    /// A link that is not a file (Safari's page, a URL from another app).
    private static func webLink(_ provider: NSItemProvider) async -> String? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
              !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) else { return nil }
        let item = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier)
        if let url = item as? URL, !url.isFileURL { return url.absoluteString }
        if let data = item as? Data, let url = URL(dataRepresentation: data, relativeTo: nil), !url.isFileURL { return url.absoluteString }
        return nil
    }

    private static func plainText(_ provider: NSItemProvider) async -> String? {
        guard provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) else { return nil }
        let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
        if let text = item as? String { return text }
        if let data = item as? Data { return String(data: data, encoding: .utf8) }
        if let text = item as? NSAttributedString { return text.string }
        return nil
    }

    /// The type to read a file by: the first one offered that is data and not just text (a .txt file is a file).
    static func fileType(_ provider: NSItemProvider) -> String? {
        let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
        let isOnlyText = types.allSatisfy { $0.conforms(to: .text) && !$0.conforms(to: .sourceCode) } && provider.suggestedName == nil
            && !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
        if isOnlyText { return nil }
        if let type = types.first(where: { ($0.conforms(to: .data) || $0.conforms(to: .package)) && $0 != .url && $0 != .fileURL }) {
            return type.identifier
        }
        return provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) ? UTType.data.identifier : nil
    }

    private static func copyFile(_ provider: NSItemProvider, typeId: String, index: Int, into folder: URL) async -> StagedFile? {
        let type = UTType(typeId)
        let suggested = provider.suggestedName
        let copied: (URL, String)? = await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: typeId) { url, _ in
                guard let url else { return continuation.resume(returning: nil) }
                // The file is ours only inside this callback: copy it now (the system streams the copy).
                let name = displayName(url.lastPathComponent, suggested: suggested, type: type)
                let destination = folder.appendingPathComponent("\(index)-\(name)")
                do {
                    try? FileManager.default.removeItem(at: destination)
                    try FileManager.default.copyItem(at: url, to: destination)
                    continuation.resume(returning: (destination, name))
                } catch {
                    continuation.resume(returning: nil)
                }
            }
        }
        var result = copied
        if result == nil, type?.conforms(to: .image) == true {
            // A picture handed over only as an object (some apps' screenshots and edited photos).
            let image: UIImage? = await withCheckedContinuation { continuation in
                guard provider.canLoadObject(ofClass: UIImage.self) else { return continuation.resume(returning: nil) }
                _ = provider.loadObject(ofClass: UIImage.self) { object, _ in continuation.resume(returning: object as? UIImage) }
            }
            if let data = image?.jpegData(compressionQuality: 0.9) {
                let name = displayName("image.jpg", suggested: provider.suggestedName, type: .jpeg)
                let destination = folder.appendingPathComponent("\(index)-\(name)")
                if (try? data.write(to: destination)) != nil { result = (destination, name) }
            }
        }
        guard let (url, name) = result else { return nil }
        let size = Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? type?.preferredMIMEType ?? "application/octet-stream"
        return StagedFile(file: url.lastPathComponent, url: url, filename: name, contentType: mime, size: size)
    }

    /// The name to send: the provider's suggested name (the document's or photo's own) with the file's extension, else
    /// the file's name; the type's extension when neither has one.
    static func displayName(_ fileName: String, suggested: String?, type: UTType?) -> String {
        let fileExtension = (fileName as NSString).pathExtension
        var name = fileName
        if let suggested = suggested?.trimmingCharacters(in: .whitespacesAndNewlines), !suggested.isEmpty {
            name = suggested
            if !fileExtension.isEmpty, (name as NSString).pathExtension.lowercased() != fileExtension.lowercased() { name += ".\(fileExtension)" }
        }
        if (name as NSString).pathExtension.isEmpty, let ext = type?.preferredFilenameExtension { name += ".\(ext)" }
        let cleaned = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        return cleaned.isEmpty ? "file" : cleaned
    }

    /// A small preview of a staged file (QuickLook draws it from the file on disk).
    static func thumbnail(_ url: URL, side: CGFloat, scale: CGFloat) async -> UIImage? {
        let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: side, height: side), scale: scale, representationTypes: .all)
        return try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request).uiImage
    }
}
