import SwiftUI

@main
struct ChikuwaChatApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var controller = AppController()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(controller: controller)
                .task { await controller.boot() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { controller.didBecomeActive() }
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
            LoginView(controller: controller)
        case .changePassword:
            ChangePasswordView(controller: controller)
        case .main:
            MainView(controller: controller)
        }
    }
}
