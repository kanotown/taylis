import Foundation
import UIKit

/// M122: a wiki page opened from outside the wiki's screens (a link in a message or a canvas, a notice).
struct PageLinkTarget: Identifiable, Equatable {
    let id: String
}

/// M122 (docs/WIKI.md §9.2 / §9.3): the wiki calls the screens make besides the hub's; failures show as the usual error.
extension AppController {
    var wiki: WikiHub? { engine?.wiki }

    /// wiki.mentioned / wiki.shared while the app is open: the push's words, unless I do not want to be disturbed now
    /// or the page is on screen already. Tapping the notice opens the page.
    func sayWikiNotice(_ notice: WikiNotice, shared: Bool) {
        guard !DND.isActive(currentMe?.asPublic), !(wiki?.isShown(notice.pageId) ?? false) else { return }
        let text = "📄 " + notice.text(shared: shared) { [store] id in store.users[id]?.displayName }
        noticePage = (text, notice.pageId)
        self.notice = text
    }

    /// The tapped notice's page.
    func openNoticePage(_ notice: String) {
        guard let entry = noticePage, entry.notice == notice else { return }
        noticePage = nil
        self.notice = nil
        pageLink = PageLinkTarget(id: entry.pageId)
    }

    /// The page's permalink on the clipboard (`<server>/p/<id>`: the same card in messages and canvases).
    func copyPageLink(_ pageId: String) {
        guard let api else { return }
        copyToClipboard(PageLink.url(base: api.baseUrl, pageId: pageId), notice: tr("リンクをコピーしました"))
    }

    /// A page's file (`[name](attachment:<id>)`): read and kept in the temporary folder to preview or share.
    func downloadPageFile(_ attachmentId: String) async -> URL? {
        guard let api else { return nil }
        do {
            let attachment = try await api.attachment(id: attachmentId)
            return await downloadAttachment(attachment)
        } catch {
            self.error = describe(error)
            return nil
        }
    }
}
