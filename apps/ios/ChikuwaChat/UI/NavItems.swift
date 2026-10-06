import SwiftUI

/// M111 (MOBILE_UI.md §14): which home tiles show and in what order, mine on every device (UserMe.nav_items). The
/// catalogue, the default orders and the rule are apps/shared/nav-items.json (NavItemsFixtureTests checks this copy).
enum NavItems {
    enum Platform: String { case desktop, mobile }

    struct Entry {
        let key: String
        let label: String
        var mobileLabel: String? = nil
        let visible: Bool
        let platforms: [Platform]
    }

    static var catalogue: [Entry] { [
        Entry(key: "threads", label: tr("スレッド"), visible: true, platforms: [.desktop, .mobile]),
        Entry(key: "activity", label: tr("アクティビティ"), visible: true, platforms: [.desktop]),
        Entry(key: "times-feed", label: "Times", visible: true, platforms: [.mobile]),
        Entry(key: "drafts", label: tr("下書き"), visible: true, platforms: [.desktop, .mobile]),
        Entry(key: "saved", label: tr("保存済み"), mobileLabel: tr("保存"), visible: true, platforms: [.desktop, .mobile]),
        Entry(key: "reminders", label: tr("リマインダー"), visible: true, platforms: [.desktop, .mobile]),
        Entry(key: "files", label: tr("ファイル"), visible: true, platforms: [.desktop, .mobile]),
        Entry(key: "canvases", label: tr("キャンバス"), visible: true, platforms: [.desktop, .mobile]),
        Entry(key: "docs", label: tr("ドキュメント"), visible: true, platforms: [.desktop, .mobile]),
        Entry(key: "calendar", label: tr("カレンダー"), visible: true, platforms: [.desktop, .mobile]),
        Entry(key: "tasks", label: tr("タスク"), visible: true, platforms: [.desktop, .mobile]),
        Entry(key: "deadlines", label: tr("締切"), visible: true, platforms: [.desktop, .mobile]),
        Entry(key: "reservations", label: tr("予約"), visible: true, platforms: [.desktop, .mobile]),
    ] }

    static let order: [Platform: [String]] = [
        .desktop: ["threads", "activity", "drafts", "reminders", "files", "canvases", "docs", "calendar", "tasks", "deadlines", "reservations", "saved",
                   "times-feed"],
        .mobile: ["threads", "times-feed", "drafts", "saved", "reminders", "calendar", "tasks", "deadlines", "reservations", "files", "canvases", "docs",
                  "activity"],
    ]

    /// The tiles this app has (「予約」 joins when its page exists). アクティビティ is the phone's tab and the iPad
    /// sidebar's own row, never a tile, so it cannot be hidden here.
    static var implemented: [String] { HomeTile.Kind.allCases.map(\.navKey) }

    private static let byKey = Dictionary(uniqueKeysWithValues: catalogue.map { ($0.key, $0) })

    /// The tile's name (the phones' shorter one where it differs).
    static func label(_ key: String) -> String {
        guard let entry = byKey[key] else { return key }
        return entry.mobileLabel ?? entry.label
    }

    /// Everything I have, in my order: not customised (nil), the platform's default order and visibility; else my items
    /// (a repeated key counts once, unknown keys kept), then each catalogue item I never saved, in the default order,
    /// with its default visibility. What a change saves, so the desktop's and newer clients' items survive.
    static func full(_ stored: [NavItem]?, platform: Platform = .mobile) -> [NavItem] {
        let defaults = { (keys: [String]) in keys.map { NavItem(key: $0, visible: byKey[$0]?.visible ?? true) } }
        guard let stored else { return defaults(order[platform] ?? []) }
        var seen = Set<String>()
        var out: [NavItem] = []
        for item in stored where seen.insert(item.key).inserted { out.append(item) }
        return out + defaults((order[platform] ?? []).filter { !seen.contains($0) })
    }

    /// The items of `full` this app lists (in the catalogue, on the platform, implemented here), with their switch.
    static func shown(_ full: [NavItem], platform: Platform = .mobile, implemented: [String]? = nil) -> [NavItem] {
        let have = Set(implemented ?? Self.implemented)
        return full.filter { byKey[$0.key]?.platforms.contains(platform) == true && have.contains($0.key) }
    }

    /// The settings' new order of the shown items: they take the slots of `full` they had, in that order.
    static func reorder(_ full: [NavItem], order keys: [String], platform: Platform = .mobile, implemented: [String]? = nil) -> [NavItem] {
        let editable = Set(shown(full, platform: platform, implemented: implemented).map(\.key))
        let items = Dictionary(full.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        var queue = keys.filter { editable.contains($0) }.makeIterator()
        return full.map { item in
            guard editable.contains(item.key), let next = queue.next(), let moved = items[next] else { return item }
            return moved
        }
    }

    static func setVisible(_ full: [NavItem], key: String, visible: Bool) -> [NavItem] {
        full.map { $0.key == key ? NavItem(key: key, visible: visible) : $0 }
    }

    /// The tiles to draw, in my order.
    static func tileKeys(_ stored: [NavItem]?) -> [String] {
        shown(full(stored)).filter(\.visible).map(\.key)
    }
}

/// M111 「ホームのタイル」 (自分 → 表示): a switch per tile, 「編集」 to drag them into another order, 「元に戻す」 back to
/// the defaults. Every change saves at once (the whole list, the desktop's items included).
struct HomeTilesSettingsView: View {
    @Bindable var controller: AppController
    @State private var editMode: EditMode = .inactive

    private var setting: NavItemsSetting { (controller.store.me ?? controller.me)?.navItems ?? .unsupported }

    var body: some View {
        let full = NavItems.full(setting.chosen)
        let shown = NavItems.shown(full)
        List {
            Section {
                ForEach(shown, id: \.key) { item in
                    Toggle(isOn: Binding(get: { item.visible }, set: { on in save(NavItems.setVisible(full, key: item.key, visible: on)) })) {
                        Label {
                            Text(NavItems.label(item.key))
                        } icon: {
                            if let kind = HomeTile.Kind.allCases.first(where: { $0.navKey == item.key }) {
                                Image(systemName: HomeTile(kind: kind, count: nil, alert: false).icon)
                            }
                        }
                    }
                }
                .onMove { from, to in
                    var keys = shown.map(\.key)
                    keys.move(fromOffsets: from, toOffset: to)
                    save(NavItems.reorder(full, order: keys))
                }
            } footer: {
                Text("ホームの上に並ぶタイルです。「編集」でドラッグして並べ替えます。すべての端末で同じになり、パソコンのサイドバーにも同じ順と表示が使われます。アクティビティは下のタブにいつもあります。")
            }
            Section {
                Button("元に戻す") { Task { _ = await controller.setNavItems(nil) } }
                    .disabled(setting == .unset)
            }
        }
        .environment(\.editMode, $editMode)
        .navigationTitle("ホームのタイル")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(editMode.isEditing ? "完了" : "編集") {
                    withAnimation { editMode = editMode.isEditing ? .inactive : .active }
                }
            }
        }
    }

    private func save(_ list: [NavItem]) {
        Task { _ = await controller.setNavItems(list) }
    }
}
