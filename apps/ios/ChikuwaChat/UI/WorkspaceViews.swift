import SwiftUI

/// The eight tile colours of the desktop rail (apps/desktop/src/state/workspaces.ts), so a workspace looks the same on both.
/// Spelled out with explicit types: the literal-to-Color chain made older compilers (Xcode 26) give up type-checking.
private let workspacePaletteHex: [UInt32] = [0x5b5bd6, 0x0f9d8a, 0xd9480f, 0xc2255c, 0x1c7ed6, 0x7048e8, 0x2b8a3e, 0xe67700]
private let workspacePalette: [Color] = workspacePaletteHex.map(paletteColor)

private func paletteColor(_ hex: UInt32) -> Color {
    let red = Double((hex >> 16) & 0xff) / 255
    let green = Double((hex >> 8) & 0xff) / 255
    let blue = Double(hex & 0xff) / 255
    return Color(red: red, green: green, blue: blue)
}

/// A workspace's tile (M16c): its initials on its colour, grey while signed out, a dot when something waits there.
struct WorkspaceTile: View {
    let workspace: Workspace
    var size: CGFloat = 36
    var dot = false

    var body: some View {
        Text(workspace.initials)
            .font(.system(size: size * 0.42, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(workspacePalette[Workspaces.paletteIndex(workspace.colorKey)], in: RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
            .saturation(workspace.isSignedIn ? 1 : 0)
            .opacity(workspace.isSignedIn ? 1 : 0.55)
            .overlay(alignment: .topTrailing) {
                if dot {
                    Circle()
                        .fill(Color.red)
                        .frame(width: max(8, size * 0.3), height: max(8, size * 0.3))
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 1.5))
                        .offset(x: size * 0.12, y: -size * 0.12)
                }
            }
            .accessibilityHidden(true)
    }
}

/// One workspace in the switcher: tile, name, account, what waits there, and a check on the one on screen.
struct WorkspaceRow: View {
    let workspace: Workspace
    let active: Bool

    var body: some View {
        HStack(spacing: 12) {
            WorkspaceTile(workspace: workspace, size: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(workspace.name).font(.body.weight(active ? .semibold : .regular)).lineLimit(1)
                Text(workspace.isSignedIn ? "\(workspace.signInName) @ \(workspace.host)" : "サインインが必要です · \(workspace.host)")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            if !active && workspace.isSignedIn {
                if let badge = workspace.badge, badge > 0 {
                    Text(badge > 99 ? "99+" : "\(badge)")
                        .font(.caption2.bold()).foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.red, in: Capsule())
                } else if workspace.hasUnread == true {
                    Circle().fill(Color.accentColor).frame(width: 9, height: 9)
                }
            }
            if active {
                Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Color.accentColor)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(active ? "表示中" : workspace.hasNews ? "未読あり" : "")
    }
}

/// The workspaces on this device (WORKSPACES.md §5): open one, add one, sign out of one. The switcher sheet and the
/// settings both show it.
struct WorkspaceListView: View {
    @Bindable var controller: AppController
    /// Called before switching (the sheet closes).
    var onSwitch: () -> Void = {}
    @State private var adding = false
    @State private var leaving: Workspace?

    var body: some View {
        List {
            Section {
                ForEach(controller.workspaces) { workspace in
                    let active = workspace.serverUrl == controller.activeServerUrl
                    Button {
                        onSwitch()
                        if !active || controller.screen != .main { Task { await controller.switchTo(workspace.serverUrl) } }
                    } label: {
                        WorkspaceRow(workspace: workspace, active: active)
                    }
                    .foregroundStyle(.primary)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(workspace.isSignedIn ? "サインアウト" : "一覧から外す", role: .destructive) { leave(workspace) }
                    }
                }
            } footer: {
                Text("通知はサインインしているすべてのワークスペースから届きます。左にスワイプするとサインアウトできます。")
            }
            Section {
                Button { adding = true } label: { Label("ワークスペースを追加", systemImage: "plus") }
            }
        }
        .alert(leaving.map { "\($0.name) からサインアウトしますか？" } ?? "",
               isPresented: Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } }),
               presenting: leaving) { workspace in
            Button("サインアウト", role: .destructive) { Task { await controller.signOutWorkspace(workspace.serverUrl) } }
            Button("キャンセル", role: .cancel) {}
        } message: { workspace in
            Text("\(workspace.signInName) @ \(workspace.host)\nこの端末に保存したこのワークスペースのメッセージと下書きを消し、一覧から外します。サーバ上のデータは消えません。")
        }
        .sheet(isPresented: $adding) {
            LoginView(controller: controller, mode: .add) { adding = false }
        }
        .task { await controller.refreshSummaries() }
    }

    /// A signed-in workspace asks first; one already signed out just leaves the list.
    private func leave(_ workspace: Workspace) {
        if workspace.isSignedIn {
            leaving = workspace
        } else {
            Task { await controller.signOutWorkspace(workspace.serverUrl) }
        }
    }
}

/// The switcher sheet from the channel list's title.
struct WorkspaceSwitcherSheet: View {
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WorkspaceListView(controller: controller) { dismiss() }
                .navigationTitle("ワークスペース")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

/// The title over the channel list: with two or more workspaces, the one on screen and a way to switch (a dot when
/// another has something unread); with one, just its name.
struct WorkspaceTitle: View {
    @Bindable var controller: AppController
    let onSwitch: () -> Void

    var body: some View {
        if let workspace = controller.activeWorkspace, controller.workspaces.count > 1 {
            Button(action: onSwitch) {
                HStack(spacing: 7) {
                    WorkspaceTile(workspace: workspace, size: 24, dot: controller.otherWorkspacesUnread)
                    Text(workspace.name).font(.headline).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
                .foregroundStyle(.primary)
            }
            .accessibilityLabel("ワークスペース: \(workspace.name)")
            .accessibilityHint(controller.otherWorkspacesUnread ? "ほかのワークスペースに未読があります" : "ワークスペースを切り替えます")
        } else {
            Text(controller.workspaceName).font(.headline).lineLimit(1)
        }
    }
}
