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
    }
}

struct RootView: View {
    @Bindable var controller: AppController

    var body: some View {
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
