import SwiftUI
import UIKit

/// The Share Extension's entry (MOBILE_UI.md §20): hosts the SwiftUI sheet and hands it what the other app shared.
final class ShareViewController: UIViewController {
    private var model: ShareModel?

    override func viewDidLoad() {
        super.viewDidLoad()
        let language = ShareLanguage.current
        ErrorMessages.locale = language
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        let model = ShareModel(providers: providers) { [weak self] sent in
            guard let context = self?.extensionContext else { return }
            if sent {
                context.completeRequest(returningItems: nil)
            } else {
                context.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
            }
        }
        self.model = model
        let host = UIHostingController(rootView: ShareRootView(model: model)
            .environment(\.locale, Locale(identifier: language))
            .tint(Color.taylisAccent))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        Task { await model.start() }
    }
}

/// The UI language: the app's (自分 → 表示 → 言語, left in the App Group), else the device's among ours.
enum ShareLanguage {
    static var current: String {
        if let chosen = SharedContainer.language(), ["ja", "en", "zh-Hans"].contains(chosen) { return chosen }
        for identifier in Locale.preferredLanguages {
            let id = identifier.lowercased()
            if id.hasPrefix("ja") { return "ja" }
            if id.hasPrefix("en") { return "en" }
            if id.hasPrefix("zh-hans") || id == "zh-cn" || id.hasPrefix("zh") { return "zh-Hans" }
        }
        return "ja"
    }

    static var locale: Locale { Locale(identifier: current) }
}

/// A text of the extension's Localizable.xcstrings in the UI language (outside SwiftUI's `Text("…")`).
func localized(_ resource: LocalizedStringResource) -> String {
    var resource = resource
    resource.locale = ShareLanguage.locale
    return String(localized: resource)
}

extension Color {
    /// The brand colour #5b5bd6 (#7f7ff2 in dark mode), as the app's AccentColor.
    static let taylisAccent = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x7f / 255, green: 0x7f / 255, blue: 0xf2 / 255, alpha: 1)
            : UIColor(red: 0x5b / 255, green: 0x5b / 255, blue: 0xd6 / 255, alpha: 1)
    })
}
