import SwiftUI

/// Short confirmation at the bottom (M12b 「リンクをコピーしました」); disappears by itself.
struct NoticeToast: View {
    @Bindable var controller: AppController

    var body: some View {
        if let notice = controller.notice {
            Label(notice, systemImage: "checkmark.circle")
                .font(.footnote)
                .padding(.horizontal, 14).padding(.vertical, 9)
                .background(.regularMaterial, in: Capsule())
                .padding(.bottom, 8)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task(id: notice) {
                    try? await Task.sleep(for: .seconds(2))
                    if controller.notice == notice { controller.notice = nil }
                }
        }
    }
}
