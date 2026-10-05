import SwiftUI

@main
struct ChikuwaChatApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var controller = AppController()
    @Environment(\.scenePhase) private var scenePhase

    init() { KeyboardBehavior.watch() }

    var body: some Scene {
        WindowGroup {
            RootView(controller: controller)
                .task { await controller.boot() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { controller.didBecomeActive() }
                    if phase == .background { controller.didEnterBackground() }
                }
        }
        // A hardware keyboard's shortcuts (MOBILE_UI.md §13): held ⌘ lists them on an iPad; MainView acts on them.
        .commands {
            CommandMenu("移動") {
                Button("移動・検索") { KeyCommand.jump.post() }.keyboardShortcut("k", modifiers: .command)
                Button("新しいメッセージ") { KeyCommand.compose.post() }.keyboardShortcut("n", modifiers: .command)
                Button("メッセージを検索") { KeyCommand.search.post() }.keyboardShortcut("f", modifiers: [.command, .shift])
                Button("戻る") { KeyCommand.back.post() }.keyboardShortcut("[", modifiers: .command)
                Button("スレッドを閉じる") { KeyCommand.closeThread.post() }.keyboardShortcut("w", modifiers: .command)
            }
        }
    }
}

struct RootView: View {
    @Bindable var controller: AppController
    /// M40: 端末に合わせる / ライト / ダーク (自分 → 表示), for every screen of the app on this device.
    @AppStorage(AppTheme.storageKey) private var theme: AppTheme = .system
    /// The look in effect (the setting or the device's): text emoji pills are drawn for it (M100), while the scene is
    /// active (`AppController.appearanceChanged`: the app-switcher snapshot flips it in the background).
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        screen.preferredColorScheme(theme.colorScheme)
            .onChange(of: colorScheme, initial: true) { reportAppearance() }
            .onChange(of: scenePhase) { reportAppearance() }
    }

    private func reportAppearance() {
        controller.appearanceChanged(dark: colorScheme == .dark, active: scenePhase == .active)
    }

    @ViewBuilder
    private var screen: some View {
        switch controller.screen {
        case .boot:
            ProgressView("起動中…")
        case .login:
            // A workspace whose session ended signs back in with its server and account filled in (M16c).
            LoginView(controller: controller, mode: controller.activeWorkspace.map { .relogin($0) } ?? .initial)
                .id(controller.activeServerUrl ?? "")
        case .changePassword:
            ChangePasswordView(controller: controller)
        case .main:
            // Keyed by workspace: switching starts from its own open conversation, sheets and drafts (M16c).
            MainView(controller: controller)
                .id(controller.activeServerUrl ?? "")
        }
    }
}
