import Foundation

/// Who may do what with a conversation's canvases (CANVAS.md §4.7), as the server decides it
/// (server/app/modules/canvases/service.py) and the desktop shows it (apps/desktop/src/ui/canvasAccess.ts). The screen
/// only hides what would be refused; the server checks every call.
struct CanvasRights: Equatable {
    /// Make a canvas in the conversation.
    var create = false
    /// Change the body (the editor).
    var edit = false
    /// Tick tasks (everyone but guests, whatever edit_policy says; in a DM its members).
    var tick = false
    /// Title, edit_policy, the conversation's tab.
    var manage = false
    /// To the trash and back.
    var trash = false
    /// M58: 「会話に共有」 (posting the link is posting a message: not where only owners post, unless one) — and so
    /// 「コメント」 on a canvas not shared yet, which shares it first.
    var share = false

    static let none = CanvasRights()

    struct Actor: Equatable {
        var id: String?
        var isAdmin: Bool
        var isGuest: Bool

        init(id: String?, isAdmin: Bool, isGuest: Bool) {
            self.id = id
            self.isAdmin = isAdmin
            self.isGuest = isGuest
        }

        init(me: UserMe?) {
            self.init(id: me?.id, isAdmin: me?.role == "admin", isGuest: me?.role == "guest")
        }
    }

    /// Rights in the conversation for a canvas (nil: only whether one can be made).
    static func of(_ channel: ChannelState, actor: Actor, canvas: (createdBy: String, editPolicy: String)?) -> CanvasRights {
        guard channel.isMember, !channel.channel.archived else { return .none } // an archived conversation's canvases are read only
        if channel.channel.isDm {
            let creator = canvas?.createdBy == actor.id && actor.id != nil
            return CanvasRights(create: true, edit: true, tick: true, manage: true, trash: canvas != nil && creator, share: canvas != nil)
        }
        let manager = actor.isAdmin || channel.channel.membership?.role == "owner"
        let create = !actor.isGuest && (!channel.channel.isAnnouncement || manager)
        guard let canvas else { return CanvasRights(create: create) }
        let creator = canvas.createdBy == actor.id && actor.id != nil
        let edit = canvas.editPolicy == "owners" ? !actor.isGuest && (creator || manager) : create
        let manage = !actor.isGuest && (creator || manager)
        // Sharing posts a message: whoever may post at the top level (a guest may post in a channel they are in).
        let share = !channel.channel.isAnnouncement || manager
        return CanvasRights(create: create, edit: edit, tick: edit || !actor.isGuest, manage: manage, trash: manage, share: share)
    }

    static func of(_ channel: ChannelState, actor: Actor, meta: CanvasMeta?) -> CanvasRights {
        of(channel, actor: actor, canvas: meta.map { ($0.createdBy, $0.editPolicy) })
    }
}

/// M58 (§4.13): where 「会話に共有」 and 「コメント」 show (the desktop's CanvasPane). The comments are the shared message's
/// thread; a canvas not shared yet is shared when its comments are opened, so they show only to who may share it.
enum CanvasShare {
    /// 「会話に共有」 in ⋯: allowed here, and not shared yet.
    static func offersShare(_ meta: CanvasMeta, rights: CanvasRights) -> Bool { rights.share && meta.shareMessageId == nil }

    /// 「コメント」: shared already (everyone reads the thread), or not yet by one who may share it.
    static func showsComments(_ meta: CanvasMeta, rights: CanvasRights) -> Bool { meta.shareMessageId != nil || rights.share }
}
