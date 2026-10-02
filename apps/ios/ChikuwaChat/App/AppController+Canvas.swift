import Foundation
import UIKit

/// M45: a canvas link tapped in a message (`<server>/c/<id>`, CANVAS.md §4.13).
struct CanvasLinkTarget: Identifiable, Equatable {
    let id: String
}

/// M73: a canvas to show in its conversation's 「キャンバス」 tab (ChannelView switches to the tab, CanvasPane selects it).
struct CanvasOpen: Equatable {
    let canvasId: String
    let channelId: String
}

/// M45: the canvas calls the screens make besides the save loop's (CANVAS.md §4.5); failures show as the usual error.
extension AppController {
    // MARK: M73 (CANVAS.md §18.5)

    /// A canvas in its conversation's 「キャンバス」 tab. Without its conversation (a personal task's 元のキャンバス) the
    /// canvas is read to learn it; a conversation I am not in, or a canvas that cannot be read, opens the canvas's own
    /// sheet, which says why. `navigate` false: the conversation is on screen already (its 「タスク」 tab).
    func openCanvas(_ canvasId: String, channelId: String? = nil, navigate: Bool = true) async {
        var channelId = channelId ?? store.canvasMeta(canvasId)?.channelId
        if channelId == nil, let api, let canvas = try? await api.getCanvas(id: canvasId, knownVersion: nil) {
            channelId = canvas.channelId
        }
        guard let channelId, store.channel(channelId)?.isMember == true else {
            canvasLink = CanvasLinkTarget(id: canvasId)
            return
        }
        canvasOpen = CanvasOpen(canvasId: canvasId, channelId: channelId)
        if navigate { NotificationCenter.default.post(name: .chikuwaOpenChannel, object: nil, userInfo: ["id": channelId]) }
    }

    /// canvas.mentioned while the app is open (the engine checked the conversation's level and mute): the push's
    /// words, unless I do not want to be disturbed now or the canvas is on screen already. Tapping it opens the canvas.
    func sayCanvasMention(_ mention: CanvasMentioned) {
        let me = store.me ?? self.me
        guard !DND.isActive(me?.asPublic), !(engine?.canvases.isShown(mention.canvasId) ?? false) else { return }
        let text = "📝 " + mention.noticeText { [store] id in store.users[id]?.displayName }
        noticeCanvas = (text, CanvasOpen(canvasId: mention.canvasId, channelId: mention.channelId))
        notice = text
    }

    /// The tapped notice's canvas, if it has one.
    func openNoticeCanvas(_ notice: String) {
        guard let entry = noticeCanvas, entry.notice == notice else { return }
        noticeCanvas = nil
        self.notice = nil
        Task { await openCanvas(entry.target.canvasId, channelId: entry.target.channelId) }
    }

    /// The task form's 「タスクにする」 from a canvas's checklist item (§18.3): what the form starts with. What is typed is
    /// saved first (the server looks for the line in the saved body).
    func canvasTaskDraft(canvasId: String, channelId: String, body: String, line: Int) -> TaskDraft? {
        let draft = TaskRules.canvasTaskInit(canvasId: canvasId, body: body, line: line, channel: store.channel(channelId), users: store.users,
                                             groups: store.groups, isAdmin: isAdmin)
        if draft != nil, let saver = engine?.canvases.current(canvasId) { Task { await saver.flush() } }
        return draft
    }

    var canvasActor: CanvasRights.Actor { CanvasRights.Actor(me: store.me) }

    /// The templates to start a canvas from (read each time the picker opens: they send no events, §11).
    func canvasTemplates() async -> [CanvasTemplateOut]? {
        guard let api else { return nil }
        do { return try await api.canvasTemplates() } catch {
            self.error = describe(error)
            return nil
        }
    }

    /// A new canvas in the conversation, empty or from a template (the server puts in {{date}} and the rest in my
    /// zone). A failure on the network is sent again with the same key, so a retry never makes a second canvas.
    func createCanvas(channelId: String, templateKey: String?, title: String?, asTab: Bool) async -> CanvasOut? {
        guard let api else { return nil }
        let key = UUID().uuidString.lowercased()
        var attempt = 0
        while true {
            do {
                let canvas = try await api.createCanvas(channelId: channelId, clientSaveId: key, title: title, templateKey: templateKey,
                                                        asTab: asTab, tz: TimeZone.current.identifier)
                store.applyCanvasMeta(canvas.meta)
                return canvas
            } catch {
                if attempt < 2, let apiError = error as? ApiError, apiError.isRetryable {
                    attempt += 1
                    try? await Task.sleep(nanoseconds: UInt64(attempt) * 700_000_000)
                    continue
                }
                self.error = describe(error)
                return nil
            }
        }
    }

    /// Title, who may edit, the conversation's tab (§4.7: the creator, owners and administrators; anyone in a DM).
    @discardableResult
    func updateCanvas(_ canvasId: String, title: String? = nil, editPolicy: String? = nil, isChannelTab: Bool? = nil) async -> CanvasOut? {
        guard let api else { return nil }
        do {
            let canvas = try await api.updateCanvas(id: canvasId, title: title, editPolicy: editPolicy, isChannelTab: isChannelTab)
            store.applyCanvasMeta(canvas.meta)
            engine?.canvases.current(canvasId)?.applyMeta(canvas.meta)
            return canvas
        } catch {
            self.error = describe(error)
            return nil
        }
    }

    /// To the trash (restorable from the conversation's canvas list for 30 days).
    func trashCanvas(_ canvasId: String, channelId: String) async -> Bool {
        guard let api else { return false }
        do {
            try await api.deleteCanvas(id: canvasId)
            engine?.canvases.trashed(canvasId, channelId: channelId)
            notice = "ゴミ箱に移しました"
            return true
        } catch {
            self.error = describe(error)
            return false
        }
    }

    func trashedCanvases(channelId: String) async -> [CanvasMeta]? {
        guard let api else { return nil }
        do { return try await api.listCanvases(channelId: channelId, trashed: true) } catch {
            self.error = describe(error)
            return nil
        }
    }

    func restoreCanvas(_ canvasId: String) async -> CanvasOut? {
        guard let api else { return nil }
        do {
            let canvas = try await api.restoreCanvas(id: canvasId)
            store.applyCanvasMeta(canvas.meta)
            return canvas
        } catch {
            self.error = describe(error)
            return nil
        }
    }

    // MARK: M58 (CANVAS.md §4.9 / §4.13, the desktop's M44)

    /// 「会話に共有」: an ordinary message with the canvas's link (nothing new while its shared message still exists).
    @discardableResult
    func shareCanvas(_ canvasId: String) async -> CanvasOut? {
        guard let api else { return nil }
        do {
            let canvas = try await api.shareCanvas(id: canvasId)
            store.applyCanvasMeta(canvas.meta)
            engine?.canvases.current(canvasId)?.applyMeta(canvas.meta)
            return canvas
        } catch {
            self.error = describe(error)
            return nil
        }
    }

    /// 「コメント」: the shared message, whose thread holds the comments; a canvas never shared (or whose message is
    /// gone) is shared first (§4.13).
    func canvasCommentsMessage(_ canvas: CanvasMeta) async -> String? {
        if let id = canvas.shareMessageId, let known = store.message(canvas.channelId, id: id), !known.deleted { return id }
        return await shareCanvas(canvas.id)?.shareMessageId
    }

    /// That version's body as a new version (§4.9). What is typed here is saved first, so it stays in the history. One
    /// key per restore: a failure on the network is sent again with it (one version, however many tries).
    func restoreCanvasRevision(_ canvasId: String, revisionId: String) async -> CanvasOut? {
        guard let api else { return nil }
        let saver = engine?.canvases.current(canvasId)
        await saver?.flush()
        let key = UUID().uuidString.lowercased()
        var attempt = 0
        while true {
            do {
                let canvas = try await api.restoreCanvasRevision(id: canvasId, revisionId: revisionId, clientSaveId: key)
                store.applyCanvasMeta(canvas.meta)
                saver?.remoteVersion(canvas.version) // the open editor reads the restored body as for canvas.updated
                return canvas
            } catch {
                if attempt < 2, let apiError = error as? ApiError, apiError.isRetryable {
                    attempt += 1
                    try? await Task.sleep(nanoseconds: UInt64(attempt) * 700_000_000)
                    continue
                }
                self.error = describe(error)
                return nil
            }
        }
    }

    /// A version's name (「提出版」: kept when old versions are thinned out); nil or blank removes it.
    func labelCanvasRevision(_ canvasId: String, revisionId: String, label: String?) async -> CanvasRevisionMeta? {
        guard let api else { return nil }
        let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            return try await api.labelCanvasRevision(id: canvasId, revisionId: revisionId,
                                                     label: trimmed.flatMap { $0.isEmpty ? nil : String($0.prefix(80)) })
        } catch {
            self.error = describe(error)
            return nil
        }
    }

    /// A canvas's body as a reader sees it (mentions as names) on the clipboard.
    func copyCanvasText(_ text: String) {
        UIPasteboard.general.string = Mentions.decode(text, users: store.users, groups: store.groups)
        notice = "本文をコピーしました"
    }

    func copyCanvasLink(_ canvasId: String) {
        guard let api else { return }
        UIPasteboard.general.string = CanvasLink.url(base: api.baseUrl, canvasId: canvasId)
        notice = "リンクをコピーしました"
    }
}
