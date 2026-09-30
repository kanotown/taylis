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
            return CanvasRights(create: true, edit: true, tick: true, manage: true, trash: canvas != nil && creator)
        }
        let manager = actor.isAdmin || channel.channel.membership?.role == "owner"
        let create = !actor.isGuest && (!channel.channel.isAnnouncement || manager)
        guard let canvas else { return CanvasRights(create: create) }
        let creator = canvas.createdBy == actor.id && actor.id != nil
        let edit = canvas.editPolicy == "owners" ? !actor.isGuest && (creator || manager) : create
        let manage = !actor.isGuest && (creator || manager)
        return CanvasRights(create: create, edit: edit, tick: edit || !actor.isGuest, manage: manage, trash: manage)
    }

    static func of(_ channel: ChannelState, actor: Actor, meta: CanvasMeta?) -> CanvasRights {
        of(channel, actor: actor, canvas: meta.map { ($0.createdBy, $0.editPolicy) })
    }
}
