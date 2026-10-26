import Foundation

/// M171 (docs/LENDING.md §9, §12.3): 「備品」 on the phone. Nothing is kept on the device (§9: the ledger is read when the
/// page opens). The hub holds the bootstrap's summary (whether the feature is on for me, the tile's number), the
/// settings (the zone of the due dates, the extensions allowed), the ledger and the loans once read, and a signal bumped
/// whenever they may have changed (`lending.updated`, a reconnect, my own press): an open item or loan reads again.
@MainActor
@Observable
final class LendingHub {
    /// The bootstrap's `lending`: nil for guests, while off and from a server before M167.
    private(set) var summary: LendingSummaryOut?
    private(set) var settings: LendingSettingsOut?
    private(set) var categories: [LendingCategoryOut] = []
    /// The ledger (nil until the page first read it).
    private(set) var items: [LendingItemOut]?
    private(set) var itemsFailure: String?
    /// scope=mine / approved / active / overdue, each nil until read.
    private(set) var myLoans: [LendingLoanOut]?
    private(set) var approvedLoans: [LendingLoanOut]?
    private(set) var activeLoans: [LendingLoanOut]?
    private(set) var overdueLoans: [LendingLoanOut]?
    /// The tile's parts, from the bootstrap's summary, then from GET /lending/summary after lending.updated /
    /// lending.notice (M173); from the loans read since on a server before M173.
    private(set) var myOverdue = 0
    private(set) var keeperAttention = 0
    /// Bumped when what is shown may have changed: open screens read their item or loan again.
    private(set) var changes = 0

    @ObservationIgnored private let api: LendingApi?
    @ObservationIgnored private var bootstraps = 0
    @ObservationIgnored private var reload: Task<Void, Never>?
    @ObservationIgnored private var pendingSettings = false
    /// M173: whether the server has GET /lending/summary (nil until asked; false after its 404: the numbers are counted
    /// from my loans and, for keepers, every active loan, as M171 did).
    @ObservationIgnored private(set) var summaryRoute: Bool?
    /// Reads may overlap (bootstrap's and an event's): an answer that started before one already kept is dropped.
    @ObservationIgnored private var reads: [String: Int] = [:]
    @ObservationIgnored private var kept: [String: Int] = [:]
    /// Whether I am a person (admin / manager / member): guests and bots never read anything here.
    @ObservationIgnored var isPerson: () -> Bool = { true }
    /// Whether someone is deactivated (their active loans need the keepers' attention, §3.3).
    @ObservationIgnored var isDeactivated: (String) -> Bool = { _ in false }
    /// A `lending.notice` for me while the app is open (the banner).
    @ObservationIgnored var onNotice: ((LendingNotice) -> Void)?
    /// The debounce of `lending.updated` (300 ms, §9); tests set 0.
    @ObservationIgnored var debounce: Duration = .milliseconds(300)

    init(api: LendingApi?) {
        self.api = api
    }

    /// The feature is on for me: the tile and the page show.
    var enabled: Bool {
        isPerson() && (settings?.enabled ?? summary?.enabled ?? false)
    }

    var isKeeper: Bool { settings?.isKeeper ?? summary?.isKeeper ?? false }

    var tileCount: Int { LendingRules.tileCount(myOverdue: myOverdue, keeperAttention: keeperAttention, isKeeper: isKeeper) }

    /// The workspace's zone of the due dates.
    var tz: String { settings?.tz ?? "Asia/Tokyo" }

    // MARK: bootstrap and events

    /// After every bootstrap: the summary; the settings once (and when they changed); after a gap, what was read again.
    func bootstrap(_ summary: LendingSummaryOut?) {
        bootstraps += 1
        _ = begin("summary")  // a summary read before this answers older numbers
        kept["summary"] = reads["summary"]
        self.summary = summary
        myOverdue = summary?.myOverdueCount ?? 0
        keeperAttention = summary?.keeperAttentionCount ?? 0
        guard let summary, summary.enabled, isPerson() else {
            // Off (or a guest, or an older server): no tile until lending.updated says the settings changed.
            settings = nil
            return
        }
        let settingsStale = settings == nil || settings?.updatedAt != summary.settingsUpdatedAt || settings?.enabled != true
        let again = bootstraps > 1
        Task {
            if settingsStale { await self.loadSettings() }
            if again { await self.refresh(numbers: false) }  // the bootstrap's numbers are new
        }
    }

    /// `lending.updated {item_ids, categories, settings}` (no contents: what one sees differs per person): read again,
    /// once for a burst.
    func applyUpdated(_ data: JSONValue) {
        if case .bool(true)? = data["settings"] { pendingSettings = true }
        guard isPerson(), api != nil else { return }
        scheduleRefresh()
    }

    /// `lending.notice`: the banner; the teacher's list reads again (a new loan names me).
    /// The morning's reminders come without lending.updated, yet a loan may have just become overdue: the numbers too.
    func applyNotice(_ notice: LendingNotice) {
        onNotice?(notice)
        guard isPerson(), api != nil else { return }
        if notice.role == "approver" { Task { await self.loadApproved() } }
        scheduleRefresh()
    }

    private func scheduleRefresh() {
        guard reload == nil else { return }
        reload = Task { [weak self] in
            guard let self else { return }
            if debounce > .zero { try? await Task.sleep(for: debounce) }
            self.reload = nil
            await self.refresh()
        }
    }

    /// Reads again what may have changed: the settings when they did, the numbers (`numbers`, GET /lending/summary),
    /// my loans and whatever was read before. On a server before M173 the numbers come from my loans and, for keepers,
    /// every active loan.
    func refresh(numbers: Bool = true) async {
        if pendingSettings || settings == nil {
            pendingSettings = false
            await loadSettings()
        }
        if numbers { await loadSummary() }
        guard settings?.enabled ?? summary?.enabled ?? false else {
            changes += 1
            return
        }
        await loadMine()
        if items != nil { await loadItems() }
        if approvedLoans != nil { await loadApproved() }
        if activeLoans != nil || (isKeeper && countsFromLoans) { await loadActive() }
        if overdueLoans != nil, isKeeper { try? await loadOverdue() }
        changes += 1
    }

    // MARK: reads

    private func begin(_ key: String) -> Int {
        reads[key, default: 0] += 1
        return reads[key]!
    }

    private func keep(_ key: String, _ read: Int) -> Bool {
        guard read > kept[key, default: 0] else { return false }
        kept[key] = read
        return true
    }

    /// The numbers are counted from the loans read (a server before M173).
    private var countsFromLoans: Bool { summaryRoute == false }

    /// M173 (docs/LENDING.md §5.1, §17.8): the bootstrap's `lending` again. nil (off, 409 lending_disabled) hides the
    /// tile: the settings are read again when lending.updated says they changed. 404 (a server before M173): from now
    /// on the loans count. Another failure keeps the numbers (the next bootstrap corrects them).
    func loadSummary() async {
        guard let api, isPerson(), summaryRoute != false else { return }
        let read = begin("summary")
        do {
            let out = try await api.lendingSummary()
            summaryRoute = true
            guard keep("summary", read) else { return }
            summary = out
            myOverdue = out?.myOverdueCount ?? 0
            keeperAttention = out?.keeperAttentionCount ?? 0
            if out?.enabled != true { settings = nil }
        } catch {
            if LendingRules.isMissingRoute(error) { summaryRoute = false }
        }
    }

    func loadSettings() async {
        guard let api, isPerson() else { return }
        let read = begin("settings")
        guard let out = try? await api.lendingSettings(), keep("settings", read) else { return }
        settings = out
    }

    /// The ledger and its categories (the page's list).
    func loadItems() async {
        guard let api, isPerson() else { return }
        if settings == nil { await loadSettings() }
        let read = begin("items")
        do {
            async let categories = api.lendingCategories()
            let list = try await api.lendingItems()
            let cats = (try? await categories) ?? self.categories
            guard keep("items", read) else { return }
            items = list
            self.categories = cats
            itemsFailure = nil
        } catch {
            guard read == reads["items"] else { return }
            itemsFailure = ErrorMessages.text(for: error)
        }
    }

    func loadMine() async {
        guard let api, isPerson() else { return }
        let read = begin("mine")
        guard let list = try? await api.lendingLoans(scope: "mine"), keep("mine", read) else { return }
        myLoans = list
        if countsFromLoans { myOverdue = list.filter { $0.isActive && $0.overdueDays > 0 }.count }
    }

    func loadApproved() async {
        guard let api, isPerson() else { return }
        let read = begin("approved")
        guard let list = try? await api.lendingLoans(scope: "approved"), keep("approved", read) else { return }
        approvedLoans = list
    }

    /// Every active loan (「貸出中」); for keepers also their attention count.
    func loadActive() async {
        guard let api, isPerson() else { return }
        let read = begin("active")
        guard let list = try? await api.lendingLoans(scope: "active"), keep("active", read) else { return }
        activeLoans = list
        if countsFromLoans, isKeeper, let settings {
            keeperAttention = LendingRules.keeperAttention(list, keeperOverdueDays: settings.keeperOverdueDays, deactivated: isDeactivated)
        }
    }

    /// The keepers' overdue list (read only on the phone; the morning summary's notice opens it).
    func loadOverdue() async throws {
        guard let api, isPerson() else { return }
        let read = begin("overdue")
        let list = try await api.lendingLoans(scope: "overdue")
        guard keep("overdue", read) else { return }
        overdueLoans = list
    }

    func item(_ id: String) async throws -> LendingItemOut {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        let item = try await api.lendingItem(id)
        // The list shows the same item as the detail did.
        if let index = items?.firstIndex(where: { $0.id == id }) {
            var row = item
            row.recentLoans = nil
            row.watcherCount = nil
            items?[index] = row
        }
        return item
    }

    func loan(_ id: String) async throws -> LendingLoanOut {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        return try await api.lendingLoan(id)
    }

    func approvers() async throws -> LendingApproversOut {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        return try await api.lendingApprovers()
    }

    /// My active loan of an item, when the list of mine has it.
    func myLoan(itemId: String) -> LendingLoanOut? { myLoans?.first { $0.itemId == itemId && $0.isActive } }

    // MARK: presses (each reads again what it changed; lending.updated follows too)

    func borrow(itemId: String, form: LendingBorrowForm) async throws -> LendingLoanOut {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        do {
            let loan = try await api.borrowLending(itemId: itemId, form: form)
            changed(loan)
            return loan
        } catch let taken as LendingUnavailable {
            // Someone was first (or it went to repair): the list and the item show it now.
            scheduleRefresh()
            throw taken
        }
    }

    func returnLoan(_ loanId: String, condition: String, note: String?) async throws -> LendingLoanOut {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        let loan = try await api.returnLending(loanId: loanId, condition: condition, note: note)
        changed(loan)
        return loan
    }

    func extend(_ loanId: String, dueOn: String) async throws -> LendingLoanOut {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        let loan = try await api.extendLending(loanId: loanId, dueOn: dueOn)
        changed(loan)
        return loan
    }

    func decide(_ loanId: String, decision: String, note: String?) async throws -> LendingLoanOut {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        let loan = try await api.decideLending(loanId: loanId, decision: decision, note: note)
        changed(loan)
        return loan
    }

    func watch(itemId: String, on: Bool) async throws {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        try await api.watchLending(itemId: itemId, on: on)
        if let index = items?.firstIndex(where: { $0.id == itemId }) { items?[index].watching = on }
        changes += 1
    }

    /// A loan my press answered: put where it is held, and read the rest again.
    private func changed(_ loan: LendingLoanOut) {
        func put(_ list: inout [LendingLoanOut]?) {
            guard let index = list?.firstIndex(where: { $0.id == loan.id }) else { return }
            list?[index] = loan
        }
        put(&myLoans)
        put(&approvedLoans)
        put(&activeLoans)
        scheduleRefresh()
    }
}
