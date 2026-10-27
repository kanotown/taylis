import SwiftUI
import UIKit

/// The Share Extension's entry (MOBILE_UI.md §21): hosts the SwiftUI sheet and hands it what the other app shared.
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
    /// The default 「テーマの色」 Taylis（栗）, as the app's AccentColor: #8f5530, #dba67c in dark mode
    /// (apps/shared/palettes.json; the extension does not follow a palette chosen in the app).
    static let taylisAccent = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xdb / 255, green: 0xa6 / 255, blue: 0x7c / 255, alpha: 1)
            : UIColor(red: 0x8f / 255, green: 0x55 / 255, blue: 0x30 / 255, alpha: 1)
    })
    /// The fill under white text (the prominent buttons): #8f5530 in both modes.
    static let taylisSolid = Color(red: 0x8f / 255, green: 0x55 / 255, blue: 0x30 / 255)
}
