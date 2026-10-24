import Foundation

// M166 (docs/DRIVE.md §5, §26): the drive's shapes the phone reads. §29: uploads and new folders from the phone (the
// uploads themselves: Share/DriveUploads.swift); no names, moves or trash here.

/// A drive: 研究室ドライブ (`workspace`), a channel's (`channel`) or マイドライブ (`user`).
struct DriveLocationOut: Codable, Equatable, Identifiable {
    let id: String
    let kind: String
    var channelId: String? = nil
    var userId: String? = nil
    let rootId: String
    /// The server's name (研究室ドライブ / マイドライブ / the channel's name); the phone names the first two by kind.
    let name: String
    var canWrite = false
    var canManage = false
    var quotaBytes: Int64? = nil
    var usedBytes: Int64 = 0
    var itemCount: Int = 0
}

struct DriveLocationListOut: Codable, Equatable {
    let locations: [DriveLocationOut]
}

/// The current version's attachment: its thumbnail, poster and document preview are served by /attachments/{id}/….
struct DriveFileOut: Codable, Equatable {
    let attachmentId: String
    var versionId: String? = nil
    var width: Int? = nil
    var height: Int? = nil
    var hasThumbnail = false
    var hasPoster = false
    var durationMs: Int? = nil
    var preview: AttachmentPreviewOut? = nil
}

struct DriveItemOut: Codable, Equatable, Identifiable {
    let id: String
    let locationId: String
    var parentId: String? = nil
    let kind: String
    let name: String
    var sizeBytes: Int64? = nil
    var contentType: String? = nil
    var contentModifiedAt: String? = nil
    var createdBy: String? = nil
    var createdAt: String = ""
    var updatedBy: String? = nil
    var updatedAt: String = ""
    var versionCount: Int = 0
    var file: DriveFileOut? = nil
    var linkCount: Int = 0
    var trashedAt: String? = nil

    var isFolder: Bool { kind == "folder" }
    /// What the list shows as its date: the file's own (its upload's lastModified, Nextcloud's mtime), else ours.
    var shownDate: String { contentModifiedAt ?? updatedAt }
}

struct DriveCrumb: Codable, Equatable, Hashable {
    let id: String
    let name: String
}

/// GET /drive/items/{id}: the item and its folders from the location's root down to its parent.
struct DriveItemDetailOut: Codable, Equatable {
    let item: DriveItemOut
    let path: [DriveCrumb]
    var locationKind: String? = nil
}

/// GET /drive/folders/{id}/children: the folder, its path from the root down to itself, a page of its items.
struct DriveChildrenOut: Codable, Equatable {
    let folder: DriveItemOut
    let path: [DriveCrumb]
    let items: [DriveItemOut]
    var nextCursor: String? = nil
    var sharedAbove: Int = 0
}

struct DriveSearchHitOut: Codable, Equatable {
    let item: DriveItemOut
    let path: [DriveCrumb]
    let locationKind: String
    /// §29: what matched (`name`, `content`, `both`); nil from a server before it.
    var match: String? = nil
    /// §29: the text around the match inside the file, in pieces; `hit` pieces are the words found.
    var snippet: [DriveSnippetPart]? = nil
    /// §29: the PDF page the snippet is on (from 1).
    var page: Int? = nil

    /// The snippet as one line (nil for a name match).
    var snippetText: String? {
        guard let snippet, !snippet.isEmpty else { return nil }
        return snippet.map(\.text).joined()
    }
}

/// A piece of a drive search snippet (docs/DRIVE.md §29): plain text, never markup.
struct DriveSnippetPart: Codable, Equatable {
    let text: String
    var hit: Bool? = nil

    var isHit: Bool { hit ?? false }
}

struct DriveSearchOut: Codable, Equatable {
    let items: [DriveSearchHitOut]
    var nextCursor: String? = nil
}

/// A download ticket (§21.2) or a ZIP's (§22): a path without the bearer token, streamed by URLSession to a file.
struct DriveTicketOut: Codable, Equatable {
    let url: String
    var expiresIn: Int = 0
}

struct DriveZipOut: Codable, Equatable {
    let url: String
    var expiresIn: Int = 0
    var entries: Int = 0
    var sizeBytes: Int64 = 0
    var zipBytes: Int64 = 0
    let filename: String
}

/// The listing's order (the server puts folders first in every order).
enum DriveSort: String, CaseIterable {
    case name, modified, size

    var title: String {
        switch self {
        case .name: tr("名前")
        case .modified: tr("更新日時")
        case .size: tr("大きさ")
        }
    }
}

/// The drive's calls (ApiClient and the test fake).
@MainActor
protocol DriveApi: AnyObject {
    func driveLocations() async throws -> [DriveLocationOut]
    func resolveDrive(channelId: String?) async throws -> DriveLocationOut
    func driveChildren(folderId: String, sort: DriveSort, descending: Bool, cursor: String?) async throws -> DriveChildrenOut
    func driveItem(_ id: String) async throws -> DriveItemDetailOut
    func searchDrive(query: String, locationId: String?, cursor: String?) async throws -> DriveSearchOut
    func driveDownloadTicket(_ itemId: String) async throws -> DriveTicketOut
    func driveZip(_ itemIds: [String]) async throws -> DriveZipOut
    /// §27: the current version's preview, queued now when it was never made (imported files); nil: it gets none.
    func requestDrivePreview(_ itemId: String) async throws -> AttachmentPreviewOut?
    /// §29: a folder made from the phone (`client_op_id`: a retry answers the same folder).
    func createDriveFolder(parentId: String, name: String, clientOpId: String) async throws -> DriveItemOut
}

/// POST /drive/items/{id}/preview.
struct DrivePreviewOut: Codable, Equatable {
    var preview: AttachmentPreviewOut?
}

extension ApiClient: DriveApi {
    func driveLocations() async throws -> [DriveLocationOut] {
        let out: DriveLocationListOut = try await requestJSON("GET", "/api/v1/drive/locations")
        return out.locations
    }

    /// The channel's drive (nil: マイドライブ), made on first use (idempotent).
    func resolveDrive(channelId: String?) async throws -> DriveLocationOut {
        let body: JSONValue = channelId.map { .object(["kind": .string("channel"), "channel_id": .string($0)]) } ?? .object(["kind": .string("me")])
        return try await requestJSON("POST", "/api/v1/drive/locations/resolve", body: body)
    }

    func driveChildren(folderId: String, sort: DriveSort, descending: Bool, cursor: String?) async throws -> DriveChildrenOut {
        var items = [URLQueryItem(name: "sort", value: sort.rawValue), URLQueryItem(name: "order", value: descending ? "desc" : "asc"),
                     URLQueryItem(name: "limit", value: "100")]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await requestJSON("GET", Self.pathWithQuery("/api/v1/drive/folders/\(folderId)/children", items))
    }

    func driveItem(_ id: String) async throws -> DriveItemDetailOut { try await requestJSON("GET", "/api/v1/drive/items/\(id)") }

    func searchDrive(query: String, locationId: String?, cursor: String?) async throws -> DriveSearchOut {
        var items = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "limit", value: "50")]
        if let locationId { items.append(URLQueryItem(name: "location_id", value: locationId)) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        // §29: names and the text inside PDF, Office and text files.
        items.append(URLQueryItem(name: "content", value: "true"))
        return try await requestJSON("GET", Self.pathWithQuery("/api/v1/search/drive", items))
    }

    func driveDownloadTicket(_ itemId: String) async throws -> DriveTicketOut {
        try await requestJSON("POST", "/api/v1/drive/items/\(itemId)/download-ticket")
    }

    func driveZip(_ itemIds: [String]) async throws -> DriveZipOut {
        try await requestJSON("POST", "/api/v1/drive/zip", body: .object(["item_ids": .array(itemIds.map(JSONValue.string))]))
    }

    func requestDrivePreview(_ itemId: String) async throws -> AttachmentPreviewOut? {
        let out: DrivePreviewOut = try await requestJSON("POST", "/api/v1/drive/items/\(itemId)/preview")
        return out.preview
    }

    func createDriveFolder(parentId: String, name: String, clientOpId: String) async throws -> DriveItemOut {
        try await requestJSON("POST", "/api/v1/drive/folders",
                              body: .object(["parent_id": .string(parentId), "name": .string(name), "client_op_id": .string(clientOpId)]))
    }
}
