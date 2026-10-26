import SwiftUI

// M171 (docs/LENDING.md §12.3): 「備品」 on the phone — the list (search, the category chips, a state), my loans, the
// loans naming me as the teacher, an item (photo, details, 「借りる」 / 「返す」 / 「延長」 / 「返却されたら知らせる」, the
// last loans), a loan (the teacher's 「許可していない」 / 「確認した」) and the active / overdue loans. The ledger, the
// categories, the settings and the keepers' recording of returns and due dates are on the desktop / web (§12.3).

private extension AppController {
    var lendingMe: String? { store.me?.id }

    func lendingName(_ userId: String) -> String { store.statusUser(userId)?.displayName ?? tr("（不明）") }
}

/// 「備品」: the list.
struct LendingView: View {
    static let selectionId = "lending"
    @Bindable var controller: AppController
    @State private var query = ""
    @State private var categoryId: String?
    @State private var status: String?

    private var hub: LendingHub? { controller.lending }

    var body: some View {
        Group {
            if let hub, !hub.enabled {
                ContentUnavailableView("備品は使われていません", systemImage: "shippingbox",
                                       description: Text("管理者が Desktop / Web でオンにします"))
            } else if let hub, let items = hub.items {
                list(hub, items: items)
            } else if let failure = hub?.itemsFailure {
                ContentUnavailableView {
                    Label("読み込めませんでした", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("再読み込み") { Task { await reload() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle("備品")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("状態", selection: $status) {
                        ForEach(LendingRules.statusFilters, id: \.self) { value in
                            Text(LendingRules.statusFilterLabel(value)).tag(value)
                        }
                    }
                } label: {
                    Label("状態", systemImage: status == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                }
            }
        }
        .refreshable { await reload() }
        .task { await reload() }
    }

    private func reload() async {
        guard let hub else { return }
        async let mine: Void = hub.loadMine()
        async let approved: Void = hub.loadApproved()
        await hub.loadItems()
        _ = await (mine, approved)
    }

    private func list(_ hub: LendingHub, items: [LendingItemOut]) -> some View {
        let me = controller.lendingMe
        let today = LendingRules.today(tz: hub.tz)
        let mine = LendingRules.myActive(hub.myLoans)
        let asked = (hub.approvedLoans ?? []).filter { !LendingRules.decisions($0, me: me).isEmpty }
        let shown = LendingRules.filter(items, query: query, categoryId: categoryId, status: status)
        return List {
            if !mine.isEmpty {
                Section("自分の貸し出し") {
                    ForEach(mine) { loan in
                        NavigationLink(value: MainRoute.lending(.loan(loan.id))) {
                            LendingLoanRow(controller: controller, loan: loan, today: today, showsBorrower: false)
                        }
                    }
                }
            }
            if !asked.isEmpty {
                Section {
                    ForEach(asked) { loan in
                        VStack(alignment: .leading, spacing: 6) {
                            NavigationLink(value: MainRoute.lending(.loan(loan.id))) {
                                LendingLoanRow(controller: controller, loan: loan, today: today, showsBorrower: true)
                            }
                            LendingDecisionButtons(controller: controller, loanId: loan.id, decisions: LendingRules.decisions(loan, me: me))
                        }
                    }
                } header: {
                    Text("許可を求められた貸し出し")
                } footer: {
                    Text("あなたの許可を得たとして借りられた備品です。許可していなければ「許可していない」を押してください。")
                }
            }
            Section {
                NavigationLink(value: MainRoute.lending(.active)) {
                    Label("貸出中の一覧", systemImage: "list.bullet.rectangle")
                }
                if hub.isKeeper {
                    NavigationLink(value: MainRoute.lending(.overdue)) {
                        HStack {
                            Label("延滞の一覧", systemImage: "exclamationmark.circle")
                            Spacer()
                            if hub.keeperAttention > 0 {
                                Text("\(hub.keeperAttention)").font(.caption.bold()).foregroundStyle(.white)
                                    .padding(.horizontal, 6).padding(.vertical, 1).background(Color.red, in: Capsule())
                            }
                        }
                    }
                }
            }
            Section {
                if !hub.categories.isEmpty {
                    categoryChips(hub.categories)
                        .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                }
                if shown.isEmpty {
                    Text(items.isEmpty ? tr("備品はまだありません") : tr("該当する備品はありません")).foregroundStyle(.secondary)
                }
                ForEach(shown) { item in
                    NavigationLink(value: MainRoute.lending(.item(item.id))) {
                        LendingItemRow(controller: controller, item: item, categories: hub.categories, today: today)
                    }
                }
            } header: {
                Text(status.map { tr("備品（\(LendingRules.statusLabel($0))）") } ?? tr("備品"))
            } footer: {
                Text("台帳の編集は Desktop / Web で行います。時間で使う枠は「予約」へ。")
            }
        }
        .listStyle(.insetGrouped)
        .searchable(text: $query, prompt: Text("名前・管理番号"))
    }

    private func categoryChips(_ categories: [LendingCategoryOut]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                chip(tr("すべて"), selected: categoryId == nil) { categoryId = nil }
                ForEach(categories) { category in
                    chip(category.name, selected: categoryId == category.id) { categoryId = category.id }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func chip(_ title: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.subheadline)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .foregroundStyle(selected ? Color.white : Color.primary)
                .background(selected ? Color.accentColor : Color(.tertiarySystemFill), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The state as a coloured dot and its word (§12.2: no coloured bar).
struct LendingStatusLabel: View {
    let status: String
    var overdue = false

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(LendingRules.statusColor(status, overdue: overdue)).frame(width: 8, height: 8)
            Text(LendingRules.statusLabel(status))
        }
    }
}

/// An item's photo (its thumbnail), else a box.
struct LendingPhoto: View {
    @Bindable var controller: AppController
    let photo: AttachmentOut?
    let side: CGFloat
    var wide = false
    @State private var loader = AttachmentImageLoader()

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8).fill(Color(.secondarySystemBackground))
            if let image = loader.image {
                if wide {
                    Image(uiImage: image).resizable().scaledToFit()
                } else {
                    Image(uiImage: image).resizable().scaledToFill()
                }
            } else {
                Image(systemName: "shippingbox").font(.system(size: side * 0.4)).foregroundStyle(.secondary)
            }
        }
        .frame(width: wide ? nil : side, height: side)
        .frame(maxWidth: wide ? .infinity : nil)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityHidden(true)
        .task(id: photo?.id) {
            guard let photo, photo.hasThumbnail else { return }
            await loader.load {
                guard let api = controller.api else { throw URLError(.notConnectedToInternet) }
                return try await api.fetchData("/api/v1/attachments/\(photo.id)/thumbnail")
            }
        }
    }
}

/// One item of the list: photo, name, code · category · place, the state (who has it until when; overdue in red).
struct LendingItemRow: View {
    @Bindable var controller: AppController
    let item: LendingItemOut
    let categories: [LendingCategoryOut]
    let today: String

    var body: some View {
        let overdue = (item.loan?.overdueDays ?? 0) > 0
        HStack(spacing: 12) {
            LendingPhoto(controller: controller, photo: item.photo, side: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name).font(.body).lineLimit(2)
                let subtitle = LendingRules.subtitle(item, categories: categories)
                if !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                HStack(spacing: 6) {
                    LendingStatusLabel(status: item.status, overdue: overdue)
                    if let loan = item.loan {
                        Text(controller.lendingName(loan.borrowerId)).lineLimit(1)
                        Text(LendingRules.dueText(dueOn: loan.dueOn, overdueDays: loan.overdueDays, today: today))
                            .foregroundStyle(overdue ? Color.red : Color.secondary)
                    } else if item.status == "available", item.requiresPermission {
                        Text("🔑 許可が要る").foregroundStyle(.secondary)
                    } else if let note = item.statusNote, !note.isEmpty {
                        Text(tr("（\(note)）")).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                .font(.caption)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A loan as a row: the item, (the borrower), until when.
struct LendingLoanRow: View {
    @Bindable var controller: AppController
    let loan: LendingLoanOut
    let today: String
    let showsBorrower: Bool

    var body: some View {
        let overdue = loan.isActive && loan.overdueDays > 0
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text("📦")
                Text(LendingRules.itemTitle(name: loan.itemName, code: loan.itemCode)).font(.body).lineLimit(2)
            }
            HStack(spacing: 6) {
                if showsBorrower { Text(controller.lendingName(loan.borrowerId)) }
                if loan.isActive {
                    Text(LendingRules.dueText(dueOn: loan.dueOn, overdueDays: loan.overdueDays, today: today))
                        .foregroundStyle(overdue ? Color.red : Color.secondary)
                } else {
                    Text("返却済み").foregroundStyle(.secondary)
                }
                if let label = LendingRules.permissionLabel(loan.permissionState) {
                    Text(label).foregroundStyle(loan.permissionState == "denied" ? Color.red : Color.secondary).lineLimit(1)
                }
            }
            .font(.caption)
        }
        .accessibilityElement(children: .combine)
    }
}

/// A screen over the list (MainRoute.lending).
struct LendingScreenView: View {
    @Bindable var controller: AppController
    let screen: LendingScreen

    var body: some View {
        switch screen {
        case .item(let id): LendingItemView(controller: controller, itemId: id).id(id)
        case .loan(let id): LendingLoanView(controller: controller, loanId: id).id(id)
        case .overdue: LendingLoansView(controller: controller, scope: "overdue")
        case .active: LendingLoansView(controller: controller, scope: "active")
        }
    }
}

/// The sheets of an item or a loan.
enum LendingSheet: Identifiable {
    case borrow(LendingItemOut)
    case giveBack(LendingLoanOut)
    case extend(LendingLoanOut)

    var id: String {
        switch self {
        case .borrow(let item): "borrow:\(item.id)"
        case .giveBack(let loan): "return:\(loan.id)"
        case .extend(let loan): "extend:\(loan.id)"
        }
    }
}

/// One item: the photo and its details, 「借りる」 or (mine) 「返す」 / 「延長」, 「返却されたら知らせる」, its last loans.
struct LendingItemView: View {
    @Bindable var controller: AppController
    let itemId: String
    @State private var item: LendingItemOut?
    @State private var myLoan: LendingLoanOut?
    @State private var failure: String?
    @State private var sheet: LendingSheet?
    @State private var busy = false

    private var hub: LendingHub? { controller.lending }

    var body: some View {
        Group {
            if let item, let hub {
                content(item, hub: hub)
            } else if let failure {
                ContentUnavailableView {
                    Label("読み込めませんでした", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("再読み込み") { Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(item?.name ?? tr("備品"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: hub?.changes) { await load() }
        .sheet(item: $sheet) { which in
            switch which {
            case .borrow(let item): LendingBorrowSheet(controller: controller, item: item)
            case .giveBack(let loan): LendingReturnSheet(controller: controller, loan: loan)
            case .extend(let loan): LendingExtendSheet(controller: controller, loan: loan, watcherCount: item?.watcherCount ?? 0)
            }
        }
    }

    private func load() async {
        guard let hub else { return }
        do {
            let fresh = try await hub.item(itemId)
            item = fresh
            failure = nil
            if let loan = fresh.loan, loan.borrowerId == controller.lendingMe {
                if let held = hub.myLoan(itemId: itemId), held.id == loan.id { myLoan = held } else { myLoan = try? await hub.loan(loan.id) }
            } else {
                myLoan = nil
            }
        } catch {
            if item == nil { failure = ErrorMessages.text(for: error) } else { controller.error = ErrorMessages.text(for: error) }
        }
    }

    @ViewBuilder
    private func content(_ item: LendingItemOut, hub: LendingHub) -> some View {
        let me = controller.lendingMe
        let today = LendingRules.today(tz: hub.tz)
        let overdue = (item.loan?.overdueDays ?? 0) > 0
        List {
            Section {
                if item.photo?.hasThumbnail == true {
                    LendingPhoto(controller: controller, photo: item.photo, side: 220, wide: true)
                        .listRowInsets(EdgeInsets())
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.name).font(.title3.bold()).textSelection(.enabled)
                    let subtitle = LendingRules.subtitle(item, categories: hub.categories)
                    if !subtitle.isEmpty { Text(subtitle).font(.subheadline).foregroundStyle(.secondary).textSelection(.enabled) }
                    HStack(spacing: 6) {
                        LendingStatusLabel(status: item.status, overdue: overdue)
                        if let loan = item.loan {
                            Text(tr("（\(controller.lendingName(loan.borrowerId))、\(LendingRules.dueText(dueOn: loan.dueOn, overdueDays: loan.overdueDays, today: today))）"))
                                .foregroundStyle(overdue ? Color.red : Color.secondary)
                        } else if let note = item.statusNote, !note.isEmpty {
                            Text(tr("（\(note)）")).foregroundStyle(.secondary)
                        }
                    }
                    .font(.subheadline)
                }
                .padding(.vertical, 4)
            }
            Section {
                if let location = item.location, !location.isEmpty { LabeledContent("置き場所", value: location) }
                if let notes = item.notes, !notes.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("付属品とメモ").font(.caption).foregroundStyle(.secondary)
                        Text(notes).textSelection(.enabled)
                    }
                }
                if item.requiresPermission { Text("🔑 教員の許可が要る") }
                LabeledContent("最長", value: item.maxDays == 0 ? tr("当日中") : tr("\(item.maxDays) 日"))
            }
            Section {
                if let myLoan, LendingRules.isMine(myLoan, me: me) {
                    Button { sheet = .giveBack(myLoan) } label: { Label("返す", systemImage: "arrow.uturn.backward") }
                    Button { sheet = .extend(myLoan) } label: { Label("延長", systemImage: "calendar.badge.plus") }
                        .disabled(!myLoan.canExtend)
                    if !myLoan.canExtend { Text(extendBlockedText(myLoan)).font(.footnote).foregroundStyle(.secondary) }
                    NavigationLink(value: MainRoute.lending(.loan(myLoan.id))) { Text("この貸し出しを見る") }
                } else if LendingRules.canBorrow(item, isGuest: controller.isGuest) {
                    Button { sheet = .borrow(item) } label: { Label("借りる", systemImage: "hand.raised") }
                        .font(.body.bold())
                } else if let loan = item.loan {
                    NavigationLink(value: MainRoute.lending(.loan(loan.id))) { Text("この貸し出しを見る") }
                }
                if LendingRules.canWatch(item, me: me) {
                    Toggle(isOn: Binding(get: { item.watching }, set: { on in watch(on) })) {
                        Text("返却されたら知らせる")
                    }
                    .disabled(busy)
                }
            } footer: {
                if LendingRules.canWatch(item, me: me) {
                    Text("返却されたとき（修理が終わったとき）に 1 回知らせます。順番や取り置きにはなりません。")
                }
            }
            if let recent = item.recentLoans, !recent.isEmpty {
                Section("最近の貸し出し") {
                    ForEach(recent) { loan in
                        HStack {
                            Text(controller.lendingName(loan.borrowerId))
                            Spacer()
                            Text(recentText(loan, tz: hub.tz)).font(.caption).foregroundStyle(.secondary)
                            if loan.returnCondition == "issue" { Text("🔧").accessibilityLabel("問題あり") }
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            Section {
            } footer: {
                Text("台帳の編集は Desktop / Web で行います。")
            }
        }
        .listStyle(.insetGrouped)
    }

    private func recentText(_ loan: LendingLoanBriefOut, tz: String) -> String {
        let cal = LendingRules.calendar(tz: tz)
        let from = parseIsoDate(loan.borrowedAt).map { LendingRules.shortDay(LendingRules.day($0, calendar: cal)) } ?? ""
        if let returned = loan.returnedAt.flatMap(parseIsoDate) {
            return tr("\(from)〜\(LendingRules.shortDay(LendingRules.day(returned, calendar: cal)))")
        }
        return tr("\(from)〜（\(LendingRules.shortDay(loan.dueOn)) まで）")
    }

    private func watch(_ on: Bool) {
        guard let hub, !busy else { return }
        busy = true
        Task {
            do {
                try await hub.watch(itemId: itemId, on: on)
                item?.watching = on
            } catch {
                controller.error = ErrorMessages.text(for: error)
            }
            busy = false
        }
    }
}

/// Why 「延長」 is off for my loan.
func extendBlockedText(_ loan: LendingLoanOut) -> String {
    if loan.permissionState == "denied" { return tr("教員が「許可していない」とした貸し出しは延長できません。返却して相談してください。") }
    return tr("これ以上は延長できません。備品係に相談してください。")
}

/// One loan: the item, who, when, the purpose and the permission (for those who may see them), the borrower's 「返す」 /
/// 「延長」 and the teacher's 「許可していない」 / 「確認した」.
struct LendingLoanView: View {
    @Bindable var controller: AppController
    let loanId: String
    @State private var loan: LendingLoanOut?
    @State private var failure: String?
    @State private var sheet: LendingSheet?

    private var hub: LendingHub? { controller.lending }

    var body: some View {
        Group {
            if let loan, let hub {
                content(loan, hub: hub)
            } else if let failure {
                ContentUnavailableView {
                    Label("読み込めませんでした", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("再読み込み") { Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(loan.map { LendingRules.itemTitle(name: $0.itemName, code: $0.itemCode) } ?? tr("貸し出し"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task(id: hub?.changes) { await load() }
        .sheet(item: $sheet) { which in
            switch which {
            case .borrow(let item): LendingBorrowSheet(controller: controller, item: item)
            case .giveBack(let loan): LendingReturnSheet(controller: controller, loan: loan)
            case .extend(let loan): LendingExtendSheet(controller: controller, loan: loan, watcherCount: nil)
            }
        }
    }

    private func load() async {
        guard let hub else { return }
        do {
            loan = try await hub.loan(loanId)
            failure = nil
        } catch {
            if loan == nil { failure = ErrorMessages.text(for: error) } else { controller.error = ErrorMessages.text(for: error) }
        }
    }

    @ViewBuilder
    private func content(_ loan: LendingLoanOut, hub: LendingHub) -> some View {
        let me = controller.lendingMe
        let today = LendingRules.today(tz: hub.tz)
        let cal = LendingRules.calendar(tz: hub.tz)
        let decisions = LendingRules.decisions(loan, me: me)
        List {
            Section {
                NavigationLink(value: MainRoute.lending(.item(loan.itemId))) {
                    Label(LendingRules.itemTitle(name: loan.itemName, code: loan.itemCode), systemImage: "shippingbox")
                }
                LabeledContent("借りた人", value: controller.lendingName(loan.borrowerId))
                if let at = parseIsoDate(loan.borrowedAt) {
                    LabeledContent("借りた日", value: LendingRules.shortDay(LendingRules.day(at, calendar: cal)))
                }
                if loan.isActive {
                    LabeledContent("返す日") {
                        Text(LendingRules.dueText(dueOn: loan.dueOn, overdueDays: loan.overdueDays, today: today))
                            .foregroundStyle(loan.overdueDays > 0 ? Color.red : Color.secondary)
                    }
                } else {
                    LabeledContent("返す日", value: LendingRules.shortDay(loan.dueOn))
                }
                if loan.extensionCount > 0 { LabeledContent("延長", value: tr("\(loan.extensionCount) 回")) }
            }
            if !loan.isActive {
                Section("返却") {
                    if let at = loan.returnedAt.flatMap(parseIsoDate) {
                        LabeledContent("返した日", value: LendingRules.shortDay(LendingRules.day(at, calendar: cal)))
                    }
                    if let by = loan.returnedBy, by != loan.borrowerId {
                        LabeledContent("記録した人", value: tr("備品係の \(controller.lendingName(by)) さん"))
                    }
                    if let condition = loan.returnCondition {
                        LabeledContent("状態", value: condition == "issue" ? tr("🔧 問題あり") : tr("問題なし"))
                    }
                    if let note = loan.returnNote, !note.isEmpty { Text(note).textSelection(.enabled) }
                }
            }
            if !loan.detailsHidden {
                Section {
                    if let purpose = loan.purpose { LabeledContent("目的", value: purpose) }
                    if loan.permissionRequired {
                        if let approver = loan.approverId { LabeledContent("許可した教員", value: controller.lendingName(approver)) }
                        if let label = LendingRules.permissionLabel(loan.permissionState) {
                            Text(label).foregroundStyle(loan.permissionState == "denied" ? Color.red : Color.primary)
                        }
                        if let note = loan.permissionNote, !note.isEmpty { LabeledContent("教員の一言", value: note) }
                    }
                }
            }
            if LendingRules.isMine(loan, me: me) {
                Section {
                    Button { sheet = .giveBack(loan) } label: { Label("返す", systemImage: "arrow.uturn.backward") }
                    Button { sheet = .extend(loan) } label: { Label("延長", systemImage: "calendar.badge.plus") }
                        .disabled(!loan.canExtend)
                } footer: {
                    if !loan.canExtend { Text(extendBlockedText(loan)) }
                }
            }
            if !decisions.isEmpty {
                Section {
                    Text(tr("\(controller.lendingName(loan.borrowerId)) さんは、あなたの許可を得たとしています。"))
                    LendingDecisionButtons(controller: controller, loanId: loan.id, decisions: decisions)
                } header: {
                    Text("教員の確認")
                } footer: {
                    Text("「許可していない」を押すと、借りた人と備品係に知らせます。「確認した」は誰にも知らせません。")
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}

/// 「貸出中の一覧」 (every active loan, by due date) or the keepers' 「延滞の一覧」 (past due, the longest first). Read only:
/// the keepers record returns and change due dates on the desktop / web.
struct LendingLoansView: View {
    @Bindable var controller: AppController
    /// active / overdue.
    let scope: String
    @State private var failure: String?
    @State private var loaded = false

    private var hub: LendingHub? { controller.lending }
    private var loans: [LendingLoanOut]? { scope == "overdue" ? hub?.overdueLoans : hub?.activeLoans }

    var body: some View {
        Group {
            if let loans, let hub {
                List {
                    Section {
                        if loans.isEmpty {
                            Text(scope == "overdue" ? tr("返す日を過ぎた貸し出しはありません") : tr("貸出中の備品はありません")).foregroundStyle(.secondary)
                        }
                        ForEach(loans) { loan in
                            NavigationLink(value: MainRoute.lending(.loan(loan.id))) {
                                VStack(alignment: .leading, spacing: 2) {
                                    LendingLoanRow(controller: controller, loan: loan, today: LendingRules.today(tz: hub.tz), showsBorrower: true)
                                    if scope == "overdue", let purpose = loan.purpose, !purpose.isEmpty {
                                        Text(tr("目的：\(purpose)")).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                    }
                                }
                            }
                        }
                    } footer: {
                        if scope == "overdue" { Text("代わりに返却を記録する・返す日を変えるのは Desktop / Web で行います。") }
                    }
                }
                .listStyle(.insetGrouped)
            } else if let failure {
                ContentUnavailableView {
                    Label("読み込めませんでした", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                } actions: {
                    Button("再読み込み") { Task { await load() } }
                }
            } else {
                ProgressView()
            }
        }
        .navigationTitle(scope == "overdue" ? tr("延滞の一覧") : tr("貸出中の一覧"))
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        guard let hub else { return }
        do {
            if scope == "overdue" { try await hub.loadOverdue() } else { await hub.loadActive() }
            failure = nil
        } catch {
            failure = ErrorMessages.text(for: error)
        }
    }
}

/// The teacher's 「許可していない」 (asked first, with an optional word) and 「確認した」.
struct LendingDecisionButtons: View {
    @Bindable var controller: AppController
    let loanId: String
    /// denied / confirmed, as LendingRules.decisions offers them.
    let decisions: [String]
    @State private var asking = false
    @State private var note = ""
    @State private var busy = false

    var body: some View {
        HStack(spacing: 8) {
            ForEach(decisions, id: \.self) { decision in
                Button(LendingRules.decisionLabel(decision), role: decision == "denied" ? .destructive : nil) {
                    if decision == "denied" {
                        note = ""
                        asking = true
                    } else {
                        send(decision, note: nil)
                    }
                }
                .buttonStyle(.bordered)
                .disabled(busy)
            }
        }
        .alert("許可していないとしますか？", isPresented: $asking) {
            TextField("一言（任意）", text: $note)
            Button("許可していない", role: .destructive) {
                let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
                send("denied", note: text.isEmpty ? nil : String(text.prefix(200)))
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("借りた人と備品係に知らせます。")
        }
    }

    private func send(_ decision: String, note: String?) {
        guard let hub = controller.lending, !busy else { return }
        busy = true
        Task {
            do {
                _ = try await hub.decide(loanId, decision: decision, note: note)
                controller.notice = decision == "denied" ? tr("「許可していない」と記録しました") : tr("確認しました")
            } catch {
                controller.error = ErrorMessages.text(for: error)
            }
            busy = false
        }
    }
}

/// 「借りる」: the return date (up to the item's max), the purpose and, when the item needs it, 「教員の許可を得た」 and the
/// teacher. One `client_request_id` per sheet: sending again after a failure never makes a second loan (§7.2).
struct LendingBorrowSheet: View {
    @Bindable var controller: AppController
    let item: LendingItemOut
    @Environment(\.dismiss) private var dismiss
    @State private var requestId = UUID().uuidString.lowercased()
    @State private var due: Date?
    @State private var purpose = ""
    @State private var ticked = false
    @State private var approverId: String?
    @State private var approvers: LendingApproversOut?
    @State private var approversFailure: String?
    @State private var busy = false
    @State private var error: String?

    private var hub: LendingHub? { controller.lending }

    var body: some View {
        let tz = hub?.tz ?? "Asia/Tokyo"
        let cal = LendingRules.calendar(tz: tz)
        let range = LendingRules.borrowRange(maxDays: item.maxDays, tz: tz)
        let first = LendingRules.date(range.lowerBound, calendar: cal) ?? Date()
        let last = LendingRules.date(range.upperBound, calendar: cal) ?? first
        let chosen = min(max(due ?? last, first), last)
        let selfApproved = approvers?.selfApproved == true
        let needs = item.requiresPermission
        let ready = LendingRules.borrowReady(purpose: purpose, needsPermission: needs, selfApproved: selfApproved, ticked: ticked,
                                             approverId: approverId) && (!needs || approvers != nil)
        NavigationStack {
            Form {
                Section {
                    DatePicker("返す日", selection: Binding(get: { chosen }, set: { due = $0 }), in: first...last, displayedComponents: .date)
                        .environment(\.timeZone, cal.timeZone)
                        .environment(\.calendar, cal)
                    Text(LendingRules.maxText(maxDays: item.maxDays, latest: range.upperBound)).font(.footnote).foregroundStyle(.secondary)
                }
                Section("目的") {
                    TextField("学会発表の撮影", text: $purpose)
                }
                if needs {
                    Section {
                        if let approvers {
                            if approvers.selfApproved {
                                Text("あなたは教員なので、許可の印は要りません。")
                            } else {
                                Toggle("教員の許可を得た", isOn: $ticked)
                                Picker("許可した教員", selection: $approverId) {
                                    Text("選んでください").tag(String?.none)
                                    ForEach(LendingRules.approvers(approvers, name: controller.lendingName), id: \.self) { id in
                                        Text(approvers.suggestedIds.contains(id) ? tr("\(controller.lendingName(id))（指導教員）") : controller.lendingName(id))
                                            .tag(Optional(id))
                                    }
                                }
                            }
                        } else if let approversFailure {
                            Text(approversFailure).foregroundStyle(.red)
                            Button("再読み込み") { Task { await loadApprovers() } }
                        } else {
                            ProgressView()
                        }
                    } header: {
                        Text("🔑 教員の許可が要る")
                    } footer: {
                        if !selfApproved { Text("選んだ教員に知らせが届きます。") }
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(tr("\(item.name) を借りる"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("借りる") { send(dueOn: LendingRules.day(chosen, calendar: cal), selfApproved: selfApproved) }
                        .disabled(busy || !ready)
                }
            }
            .task { if needs { await loadApprovers() } }
        }
    }

    private func loadApprovers() async {
        guard let hub else { return }
        do {
            approvers = try await hub.approvers()
            approversFailure = nil
            if approverId == nil, let first = approvers?.suggestedIds.first(where: { approvers?.userIds.contains($0) == true }) {
                approverId = first
            }
        } catch {
            approversFailure = ErrorMessages.text(for: error)
        }
    }

    private func send(dueOn: String, selfApproved: Bool) {
        guard let hub, !busy else { return }
        busy = true
        error = nil
        let asks = item.requiresPermission && !selfApproved
        let form = LendingBorrowForm(clientRequestId: requestId, dueOn: dueOn,
                                     purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines),
                                     permissionConfirmed: asks && ticked, approverId: asks ? approverId : nil)
        Task {
            do {
                _ = try await hub.borrow(itemId: item.id, form: form)
                busy = false
                controller.notice = tr("「\(item.name)」を借りました（\(LendingRules.shortDay(dueOn)) まで）")
                dismiss()
            } catch {
                busy = false
                self.error = LendingRules.errorText(error, me: controller.lendingMe, name: controller.lendingName)
            }
        }
    }
}

/// 「返す」: as it was (問題なし) or not (問題あり, with a note).
struct LendingReturnSheet: View {
    @Bindable var controller: AppController
    let loan: LendingLoanOut
    @Environment(\.dismiss) private var dismiss
    @State private var condition = "ok"
    @State private var note = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("状態", selection: $condition) {
                        Text("問題なし").tag("ok")
                        Text("問題あり").tag("issue")
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    if condition == "issue" { Text("備品係に知らせます。どこに問題があるかを書いてください。") }
                }
                Section(condition == "issue" ? tr("メモ（必須）") : tr("メモ（任意）")) {
                    TextField(condition == "issue" ? tr("レンズキャップがありません") : tr("充電器は棚の箱へ"), text: $note, axis: .vertical)
                        .lineLimit(2...6)
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(tr("\(loan.itemName) を返す"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("返す") { send() }.disabled(busy || !LendingRules.returnReady(condition: condition, note: note))
                }
            }
        }
    }

    private func send() {
        guard let hub = controller.lending, !busy else { return }
        busy = true
        error = nil
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                _ = try await hub.returnLoan(loan.id, condition: condition, note: text.isEmpty ? nil : text)
                busy = false
                controller.notice = tr("「\(loan.itemName)」を返しました")
                dismiss()
            } catch {
                busy = false
                self.error = ErrorMessages.text(for: error)
            }
        }
    }
}

/// 「延長」: a later return date within the borrower's limit, the extensions left, and whether someone waits for it.
struct LendingExtendSheet: View {
    @Bindable var controller: AppController
    let loan: LendingLoanOut
    /// From the item's detail (nil: read here).
    let watcherCount: Int?
    @Environment(\.dismiss) private var dismiss
    @State private var due: Date?
    @State private var watchers: Int?
    @State private var busy = false
    @State private var error: String?

    private var hub: LendingHub? { controller.lending }

    var body: some View {
        let tz = hub?.tz ?? "Asia/Tokyo"
        let cal = LendingRules.calendar(tz: tz)
        let range = LendingRules.extendRange(loan, tz: tz)
        let waiting = watchers ?? watcherCount ?? 0
        NavigationStack {
            Form {
                Section {
                    LabeledContent("今の返す日", value: LendingRules.shortDay(loan.dueOn))
                    if let range, let first = LendingRules.date(range.lowerBound, calendar: cal),
                       let last = LendingRules.date(range.upperBound, calendar: cal) {
                        let chosen = min(max(due ?? last, first), last)
                        DatePicker("新しい返す日", selection: Binding(get: { chosen }, set: { due = $0 }), in: first...last,
                                   displayedComponents: .date)
                            .environment(\.timeZone, cal.timeZone)
                            .environment(\.calendar, cal)
                        Text(tr("\(LendingRules.shortDay(range.upperBound)) まで延ばせます")).font(.footnote).foregroundStyle(.secondary)
                    } else {
                        Text("これ以上は延長できません。備品係に相談してください。").foregroundStyle(.secondary)
                    }
                } footer: {
                    if let left = LendingRules.extensionsLeft(loan, settings: hub?.settings) {
                        Text(left > 0 ? tr("あと \(left) 回延長できます") : tr("延長できる回数を使い切りました"))
                    }
                }
                if waiting > 0 {
                    Section { Text(tr("この備品を待っている人がいます（\(waiting) 人）")).foregroundStyle(.orange) }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(tr("\(loan.itemName) を延長"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("延長") {
                        guard let range, let first = LendingRules.date(range.lowerBound, calendar: cal),
                              let last = LendingRules.date(range.upperBound, calendar: cal) else { return }
                        send(dueOn: LendingRules.day(min(max(due ?? last, first), last), calendar: cal))
                    }
                    .disabled(busy || range == nil || !loan.canExtend)
                }
            }
            .task {
                guard watcherCount == nil, let hub else { return }
                watchers = (try? await hub.item(loan.itemId))?.watcherCount
            }
        }
    }

    private func send(dueOn: String) {
        guard let hub, !busy else { return }
        busy = true
        error = nil
        Task {
            do {
                _ = try await hub.extend(loan.id, dueOn: dueOn)
                busy = false
                controller.notice = tr("返す日を \(LendingRules.shortDay(dueOn)) にしました")
                dismiss()
            } catch {
                busy = false
                self.error = ErrorMessages.text(for: error)
            }
        }
    }
}
