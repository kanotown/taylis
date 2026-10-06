import SwiftUI

/// Short confirmation at the bottom (M12b 「リンクをコピーしました」); disappears by itself. M73: a canvas mention's notice
/// opens the canvas when tapped (and stays a little longer to be tapped).
struct NoticeToast: View {
    @Bindable var controller: AppController

    var body: some View {
        if let notice = controller.notice {
            let page = controller.noticePage?.notice == notice
            let opens = controller.noticeCanvas?.notice == notice || page
            Group {
                if page {
                    Button { controller.openNoticePage(notice) } label: {
                        Label(notice, systemImage: "book.closed")
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("ページを開きます")
                } else if opens {
                    Button { controller.openNoticeCanvas(notice) } label: {
                        Label(notice, systemImage: "doc.text")
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("キャンバスを開きます")
                } else {
                    Label(notice, systemImage: "checkmark.circle")
                }
            }
            .font(.footnote)
            .padding(.horizontal, 14).padding(.vertical, 9)
            .background(.regularMaterial, in: Capsule())
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .task(id: notice) {
                try? await Task.sleep(for: .seconds(opens ? 5 : 2))
                if controller.notice == notice { controller.notice = nil }
            }
        }
    }
}
