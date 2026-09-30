import Foundation
import UIKit

/// M45: a canvas link tapped in a message (`<server>/c/<id>`, CANVAS.md §4.13).
struct CanvasLinkTarget: Identifiable, Equatable {
    let id: String
}

/// M45: the canvas calls the screens make besides the save loop's (CANVAS.md §4.5); failures show as the usual error.
extension AppController {
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
