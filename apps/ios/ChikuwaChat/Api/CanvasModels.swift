import Foundation

/// Canvases (docs/CANVAS.md; the server in M41 / M42, this client in M45): Markdown documents of a conversation, saved
/// whole with the version they were written on; the server merges what others saved meanwhile (§4.4).

/// A canvas without its body: lists and the canvas.* events (§4.6).
struct CanvasMeta: Codable, Identifiable, Equatable {
    let id: String
    let channelId: String
    var title: String
    var version: Int
    var headRevId: String
    var isChannelTab: Bool
    var editPolicy: String
    var templateKey: String?
    var shareMessageId: String?
    var taskTotal: Int
    var taskDone: Int
    let createdBy: String
    var updatedBy: String
    let createdAt: String
    var updatedAt: String
    /// Only in the trash's list.
    var deletedAt: String? = nil
}

/// A canvas with its body (GET /canvases/{id}, answers to saves and changes).
struct CanvasOut: Codable, Identifiable, Equatable {
    let id: String
    let channelId: String
    var title: String
    var version: Int
    var headRevId: String
    var isChannelTab: Bool
    var editPolicy: String
    var templateKey: String?
    var shareMessageId: String?
    var taskTotal: Int
    var taskDone: Int
    let createdBy: String
    var updatedBy: String
    let createdAt: String
    var updatedAt: String
    var deletedAt: String? = nil
    var body: String

    var meta: CanvasMeta {
        CanvasMeta(id: id, channelId: channelId, title: title, version: version, headRevId: headRevId, isChannelTab: isChannelTab,
                   editPolicy: editPolicy, templateKey: templateKey, shareMessageId: shareMessageId, taskTotal: taskTotal, taskDone: taskDone,
                   createdBy: createdBy, updatedBy: updatedBy, createdAt: createdAt, updatedAt: updatedAt, deletedAt: deletedAt)
    }

    /// The newer metadata (a title or a setting changed) over this body.
    func with(meta: CanvasMeta) -> CanvasOut {
        CanvasOut(id: id, channelId: channelId, title: meta.title, version: meta.version, headRevId: meta.headRevId, isChannelTab: meta.isChannelTab,
                  editPolicy: meta.editPolicy, templateKey: meta.templateKey, shareMessageId: meta.shareMessageId, taskTotal: meta.taskTotal,
                  taskDone: meta.taskDone, createdBy: createdBy, updatedBy: meta.updatedBy, createdAt: createdAt, updatedAt: meta.updatedAt,
                  deletedAt: meta.deletedAt, body: body)
    }
}

/// §4.4: how the overlapping words of a save are settled.
enum CanvasOnConflict: String, Codable, Equatable {
    /// Refused with 409 canvas_conflict (the default).
    case fail
    /// Mine.
    case ours
    /// The other version.
    case theirs
    /// The other version, then mine quoted.
    case both
}

/// PUT /canvases/{id}/content.
struct CanvasSaveIn: Codable, Equatable {
    var baseRevId: String
    var body: String
    var clientSaveId: String
    var onConflict: CanvasOnConflict
}

struct CanvasSaveOut: Codable, Equatable {
    let canvas: CanvasOut
    let submittedRevId: String
    let merged: Bool
}

/// A region both sides changed differently (`oursLine` / `theirsLine`: its first line in the submitted body / the head).
struct CanvasConflict: Codable, Equatable {
    let base: String
    let ours: String
    let theirs: String
    var oursLine: Int = 0
    var theirsLine: Int = 0
}

/// The details of 409 canvas_conflict / canvas_base_expired: the current canvas and (conflict) where both changed.
struct CanvasConflictDetails: Codable, Equatable {
    let head: CanvasOut
    var conflicts: [CanvasConflict]? = nil
    var timedOut: Bool? = nil
}

/// A save the server did not take as it was, with what the client needs to go on (ApiClient.saveCanvas).
enum CanvasSaveFailure: Error, Equatable {
    /// 409 canvas_conflict: someone changed the same words; the choice is sent on the same version.
    case conflict(CanvasConflictDetails)
    /// 409 canvas_base_expired: the version this was written on is gone (long offline); the current canvas.
    case expired(CanvasOut)
    /// 429 with `retry_after_seconds`: sent again (same key) after that long.
    case rateLimited(seconds: Double)
}

struct CanvasTemplateOut: Codable, Identifiable, Equatable {
    let id: String
    let key: String
    let name: String
    let description: String?
    let title: String
    let body: String
    let position: Int
    let builtin: Bool
    let hidden: Bool
    let updatedAt: String
}

/// One version in a canvas's history (without its body).
struct CanvasRevisionMeta: Codable, Identifiable, Equatable {
    let id: String
    let canvasId: String
    let version: Int?
    /// create | save | merge | side | restore | erased
    let kind: String
    let parentRevId: String?
    let authorId: String
    let title: String
    let label: String?
    let linesAdded: Int
    let linesRemoved: Int
    let createdAt: String
}

/// GET /canvases (M78, CANVAS.md §21): the canvases of all my conversations, most recently updated first.
struct CanvasPage: Codable, Equatable {
    let items: [CanvasMeta]
    let nextCursor: String?
}

struct CanvasRevisionPage: Codable, Equatable {
    let items: [CanvasRevisionMeta]
    let nextCursor: String?
}

struct CanvasRevisionOut: Codable, Equatable {
    let id: String
    let kind: String
    let authorId: String
    let title: String
    let label: String?
    let createdAt: String
    let body: String
}

/// M58: one hit of `GET /search/canvases` (§4.8): the canvas and a plain-text excerpt around the words.
struct CanvasSearchHit: Codable, Identifiable, Equatable {
    let canvas: CanvasMeta
    let snippet: String
    var score: Double = 0
    var id: String { canvas.id }
}

struct CanvasSearchOut: Codable {
    let hits: [CanvasSearchHit]
    let keywords: [String]
    var filters: SearchFilters? = nil
    let limit: Int
    let offset: Int
    let hasMore: Bool
    var total: Int? = nil
    var totalCapped: Bool? = nil
}

/// canvas.updated (§4.6): the new metadata and what changed (content / title / settings / restore).
struct CanvasUpdatedEvent: Decodable {
    let canvas: CanvasMeta
    let change: String?
}

struct CanvasDeletedEvent: Decodable {
    let canvasId: String
    let channelId: String
}

/// canvas.mentioned (M72, to me only; CANVAS.md §18.1): a save of the canvas newly mentions me. Only the ids are
/// required: a title or author missing reads as empty (the notice still says something).
struct CanvasMentioned: Decodable, Equatable {
    let canvasId: String
    let channelId: String
    var revId: String?
    var title: String
    var byUserId: String

    init(canvasId: String, channelId: String, revId: String? = nil, title: String, byUserId: String) {
        self.canvasId = canvasId
        self.channelId = channelId
        self.revId = revId
        self.title = title
        self.byUserId = byUserId
    }

    private enum CodingKeys: String, CodingKey { case canvasId, channelId, revId, title, byUserId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        canvasId = try c.decode(String.self, forKey: .canvasId)
        channelId = try c.decode(String.self, forKey: .channelId)
        revId = try? c.decodeIfPresent(String.self, forKey: .revId)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        byUserId = (try? c.decodeIfPresent(String.self, forKey: .byUserId)) ?? ""
    }

    /// The push's words (CANVAS.md §18.1): 「〇〇 が「題名」であなたをメンションしました」.
    func noticeText(nameOf: (String) -> String?) -> String {
        let who = nameOf(byUserId) ?? "メンバー"
        let title = title.isEmpty ? "キャンバス" : title
        return "\(who) が「\(title)」であなたをメンションしました"
    }
}
