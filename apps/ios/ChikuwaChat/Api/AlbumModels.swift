import Foundation

// AL3 (docs/ALBUMS.md §5, §12, §18.4): the photo albums the phone reads. An album is a drive folder with a little
// metadata (description, cover, dates, order); its photos are the folder's images and videos. Who sees and who adds
// is the folder's place (DRIVE.md §3), so nothing here decides access.

/// The album's chosen (or first) photo.
struct AlbumCoverOut: Codable, Equatable, Hashable {
    let itemId: String
    let attachmentId: String
}

/// AL1 `AlbumOut`: the title is the folder's name (not here).
struct AlbumOut: Codable, Equatable, Hashable {
    let folderId: String
    var description: String = ""
    var cover: AlbumCoverOut? = nil
    var coverItemId: String? = nil
    /// `taken` (capture date), `name`, `added`.
    var sort: String = "taken"
    var sortOrder: String = "asc"
    /// The event's own dates (yyyy-MM-dd), set by hand; else the photos' range shows.
    var startsOn: String? = nil
    var endsOn: String? = nil
    var takenFrom: String? = nil
    var takenTo: String? = nil
    var photoCount: Int = 0
    var videoCount: Int = 0
    var sizeBytes: Int64 = 0
    /// Up to four with a thumbnail, the cover first (a card's 2 × 2).
    var previewAttachmentIds: [String] = []
    var createdBy: String? = nil
    var createdAt: String = ""
    var updatedAt: String = ""
}

/// GET /drive/albums: one album of a place I can read.
struct AlbumListEntryOut: Codable, Equatable, Identifiable {
    let folder: DriveItemOut
    let album: AlbumOut
    let path: [DriveCrumb]
    let locationKind: String

    var id: String { folder.id }
}

struct AlbumListOut: Codable, Equatable {
    let items: [AlbumListEntryOut]
    var nextCursor: String? = nil
}

/// GET /drive/albums/{folder_id}: the album, where it is, whether I may add, a page of its photos and videos in its
/// order, and how many subfolders and other files it holds (listed by the folder's children).
struct AlbumDetailOut: Codable, Equatable {
    let folder: DriveItemOut
    let album: AlbumOut
    let path: [DriveCrumb]
    let locationKind: String
    let canWrite: Bool
    let items: [DriveItemOut]
    var nextCursor: String? = nil
    var folderCount: Int = 0
    var otherCount: Int = 0
    var sharedAbove: Int = 0
}

/// POST /drive/albums.
struct AlbumCreatedOut: Codable, Equatable {
    let folder: DriveItemOut
    let album: AlbumOut
}

/// POST /drive/albums/{id}/add: one result per source (an attachment or an item).
struct AlbumAddResult: Codable, Equatable {
    let sourceId: String
    let ok: Bool
    var error: String? = nil
    var itemId: String? = nil
    /// `moved` (a posted file already in the album's channel drive: the message is unchanged) or `copied`.
    var action: String? = nil
}

struct AlbumAddOut: Codable, Equatable {
    let results: [AlbumAddResult]
}

/// The album's order (the album's own, or one chosen on this screen).
enum AlbumSort: String, CaseIterable {
    case taken, name, added

    var title: String {
        switch self {
        case .taken: tr("撮影日")
        case .name: tr("名前")
        case .added: tr("追加した順")
        }
    }
}

/// What a new album is made from.
struct AlbumDraft: Equatable {
    var name: String
    /// The place's 「アルバム」 folder (made when missing, ALBUMS.md §17 Q2), or a folder of my choice.
    var locationId: String?
    var parentId: String?
    var description = ""
    var startsOn: String?
    var endsOn: String?
}

/// The album calls (ApiClient and the tests' fake).
@MainActor
protocol AlbumApi: AnyObject {
    func albums(locationId: String?, cursor: String?) async throws -> AlbumListOut
    func album(_ folderId: String, sort: AlbumSort?, descending: Bool?, cursor: String?) async throws -> AlbumDetailOut
    func createAlbum(_ draft: AlbumDraft, clientOpId: String) async throws -> AlbumCreatedOut
    func addToAlbum(_ folderId: String, attachmentIds: [String], itemIds: [String], clientOpId: String) async throws -> AlbumAddOut
}

extension ApiClient: AlbumApi {
    func albums(locationId: String?, cursor: String?) async throws -> AlbumListOut {
        var items = [URLQueryItem(name: "limit", value: "50")]
        if let locationId { items.append(URLQueryItem(name: "location_id", value: locationId)) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await requestJSON("GET", Self.pathWithQuery("/api/v1/drive/albums", items))
    }

    func album(_ folderId: String, sort: AlbumSort?, descending: Bool?, cursor: String?) async throws -> AlbumDetailOut {
        var items = [URLQueryItem(name: "limit", value: "120")]
        if let sort { items.append(URLQueryItem(name: "sort", value: sort.rawValue)) }
        if let descending { items.append(URLQueryItem(name: "order", value: descending ? "desc" : "asc")) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await requestJSON("GET", Self.pathWithQuery("/api/v1/drive/albums/\(folderId)", items))
    }

    func createAlbum(_ draft: AlbumDraft, clientOpId: String) async throws -> AlbumCreatedOut {
        var body: [String: JSONValue] = ["name": .string(draft.name), "client_op_id": .string(clientOpId)]
        if let parentId = draft.parentId { body["parent_id"] = .string(parentId) } else if let locationId = draft.locationId {
            body["location_id"] = .string(locationId)
        }
        let description = draft.description.trimmingCharacters(in: .whitespacesAndNewlines)
        if !description.isEmpty { body["description"] = .string(description) }
        if let startsOn = draft.startsOn { body["starts_on"] = .string(startsOn) }
        if let endsOn = draft.endsOn { body["ends_on"] = .string(endsOn) }
        return try await requestJSON("POST", "/api/v1/drive/albums", body: .object(body))
    }

    func addToAlbum(_ folderId: String, attachmentIds: [String], itemIds: [String], clientOpId: String) async throws -> AlbumAddOut {
        var body: [String: JSONValue] = ["mode": .string("auto"), "client_op_id": .string(clientOpId)]
        if !attachmentIds.isEmpty { body["attachment_ids"] = .array(attachmentIds.map(JSONValue.string)) }
        if !itemIds.isEmpty { body["item_ids"] = .array(itemIds.map(JSONValue.string)) }
        return try await requestJSON("POST", "/api/v1/drive/albums/\(folderId)/add", body: .object(body))
    }
}
