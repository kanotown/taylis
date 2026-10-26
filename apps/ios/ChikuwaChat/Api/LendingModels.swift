import Foundation

// M171 (docs/LENDING.md §5, §12.3): 「備品」 on the phone — the ledger to look at, borrowing, returning and extending
// one's own loans, the teacher's 「許可していない」 / 「確認した」. The ledger is edited on the desktop / web only.
// Every state and kind is a String: a value this build does not know shows as it is and never fails the list.

/// The bootstrap's `lending` (nil for guests, while the feature is off and from a server before M167).
struct LendingSummaryOut: Codable, Equatable {
    let enabled: Bool
    let isKeeper: Bool
    /// My loans not returned yet, and those of them past their due date.
    let myActiveCount: Int
    let myOverdueCount: Int
    /// Keepers only (else 0): loans `keeper_overdue_days` or more past due, and those of deactivated people.
    let keeperAttentionCount: Int
    var settingsUpdatedAt: String? = nil
}

/// GET /lending/settings (readable while off; guests get 403).
struct LendingSettingsOut: Codable, Equatable {
    let enabled: Bool
    var keeperIds: [String] = []
    var defaultMaxDays: Int = 14
    var maxExtensions: Int = 2
    var keeperOverdueDays: Int = 3
    var noticeMinute: Int = 540
    /// The zone of the due dates (a due date is a day there).
    var tz: String = "Asia/Tokyo"
    var isKeeper: Bool = false
    var updatedAt: String? = nil

    init(enabled: Bool, keeperIds: [String] = [], defaultMaxDays: Int = 14, maxExtensions: Int = 2, keeperOverdueDays: Int = 3,
         noticeMinute: Int = 540, tz: String = "Asia/Tokyo", isKeeper: Bool = false, updatedAt: String? = nil) {
        self.enabled = enabled
        self.keeperIds = keeperIds
        self.defaultMaxDays = defaultMaxDays
        self.maxExtensions = maxExtensions
        self.keeperOverdueDays = keeperOverdueDays
        self.noticeMinute = noticeMinute
        self.tz = tz
        self.isKeeper = isKeeper
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case enabled, keeperIds, defaultMaxDays, maxExtensions, keeperOverdueDays, noticeMinute, tz, isKeeper, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        keeperIds = try c.decodeIfPresent([String].self, forKey: .keeperIds) ?? []
        defaultMaxDays = try c.decodeIfPresent(Int.self, forKey: .defaultMaxDays) ?? 14
        maxExtensions = try c.decodeIfPresent(Int.self, forKey: .maxExtensions) ?? 2
        keeperOverdueDays = try c.decodeIfPresent(Int.self, forKey: .keeperOverdueDays) ?? 3
        noticeMinute = try c.decodeIfPresent(Int.self, forKey: .noticeMinute) ?? 540
        tz = try c.decodeIfPresent(String.self, forKey: .tz) ?? "Asia/Tokyo"
        isKeeper = try c.decodeIfPresent(Bool.self, forKey: .isKeeper) ?? false
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
    }
}

/// GET /lending/categories, in their order.
struct LendingCategoryOut: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    var position: Int = 0
    var requiresPermission: Bool = false
    var maxDays: Int? = nil
    var itemCount: Int = 0

    init(id: String, name: String, position: Int = 0, requiresPermission: Bool = false, maxDays: Int? = nil, itemCount: Int = 0) {
        self.id = id
        self.name = name
        self.position = position
        self.requiresPermission = requiresPermission
        self.maxDays = maxDays
        self.itemCount = itemCount
    }

    private enum CodingKeys: String, CodingKey { case id, name, position, requiresPermission, maxDays, itemCount }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        position = try c.decodeIfPresent(Int.self, forKey: .position) ?? 0
        requiresPermission = try c.decodeIfPresent(Bool.self, forKey: .requiresPermission) ?? false
        maxDays = try c.decodeIfPresent(Int.self, forKey: .maxDays)
        itemCount = try c.decodeIfPresent(Int.self, forKey: .itemCount) ?? 0
    }
}

/// An item's loan as the ledger shows it (`LendingItemOut.loan`, `recent_loans`): who, until when — no purpose.
struct LendingLoanBriefOut: Codable, Equatable, Identifiable {
    let id: String
    let borrowerId: String
    let borrowedAt: String
    /// "YYYY-MM-DD" in the workspace's zone.
    let dueOn: String
    var overdueDays: Int = 0
    /// claimed / confirmed / denied; nil when none was needed or I may not see it.
    var permissionState: String? = nil
    /// active / returned.
    var status: String = "active"
    var returnedAt: String? = nil
    /// ok / issue (🔧 for everyone).
    var returnCondition: String? = nil

    init(id: String, borrowerId: String, borrowedAt: String, dueOn: String, overdueDays: Int = 0, permissionState: String? = nil,
         status: String = "active", returnedAt: String? = nil, returnCondition: String? = nil) {
        self.id = id
        self.borrowerId = borrowerId
        self.borrowedAt = borrowedAt
        self.dueOn = dueOn
        self.overdueDays = overdueDays
        self.permissionState = permissionState
        self.status = status
        self.returnedAt = returnedAt
        self.returnCondition = returnCondition
    }

    private enum CodingKeys: String, CodingKey {
        case id, borrowerId, borrowedAt, dueOn, overdueDays, permissionState, status, returnedAt, returnCondition
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        borrowerId = try c.decode(String.self, forKey: .borrowerId)
        borrowedAt = try c.decode(String.self, forKey: .borrowedAt)
        dueOn = try c.decode(String.self, forKey: .dueOn)
        overdueDays = try c.decodeIfPresent(Int.self, forKey: .overdueDays) ?? 0
        permissionState = try c.decodeIfPresent(String.self, forKey: .permissionState)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "active"
        returnedAt = try c.decodeIfPresent(String.self, forKey: .returnedAt)
        returnCondition = try c.decodeIfPresent(String.self, forKey: .returnCondition)
    }
}

/// One item of the ledger (GET /lending/items, and the head of GET /lending/items/{id}).
struct LendingItemOut: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    var categoryId: String? = nil
    var code: String? = nil
    var location: String? = nil
    var notes: String? = nil
    var photo: AttachmentOut? = nil
    /// available / on_loan / in_repair / retired (another: shown as it is, not borrowable).
    var status: String = "available"
    var statusNote: String? = nil
    /// In effect (item → category → false), and the max days in effect (item → category → settings).
    var requiresPermission: Bool = false
    var maxDays: Int = 14
    var loan: LendingLoanBriefOut? = nil
    var watching: Bool = false
    var createdAt: String = ""
    var updatedAt: String = ""
    /// The detail's own (GET /lending/items/{id}): the last five loans and how many wait for its return.
    var recentLoans: [LendingLoanBriefOut]? = nil
    var watcherCount: Int? = nil

    init(id: String, name: String, categoryId: String? = nil, code: String? = nil, location: String? = nil, notes: String? = nil,
         photo: AttachmentOut? = nil, status: String = "available", statusNote: String? = nil, requiresPermission: Bool = false,
         maxDays: Int = 14, loan: LendingLoanBriefOut? = nil, watching: Bool = false, recentLoans: [LendingLoanBriefOut]? = nil,
         watcherCount: Int? = nil) {
        self.id = id
        self.name = name
        self.categoryId = categoryId
        self.code = code
        self.location = location
        self.notes = notes
        self.photo = photo
        self.status = status
        self.statusNote = statusNote
        self.requiresPermission = requiresPermission
        self.maxDays = maxDays
        self.loan = loan
        self.watching = watching
        self.recentLoans = recentLoans
        self.watcherCount = watcherCount
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, categoryId, code, location, notes, photo, status, statusNote, requiresPermission, maxDays, loan, watching
        case createdAt, updatedAt, recentLoans, watcherCount
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        categoryId = try c.decodeIfPresent(String.self, forKey: .categoryId)
        code = try c.decodeIfPresent(String.self, forKey: .code)
        location = try c.decodeIfPresent(String.self, forKey: .location)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        // A photo this build cannot read is no photo, not a lost item.
        photo = try? c.decodeIfPresent(AttachmentOut.self, forKey: .photo)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "available"
        statusNote = try c.decodeIfPresent(String.self, forKey: .statusNote)
        requiresPermission = try c.decodeIfPresent(Bool.self, forKey: .requiresPermission) ?? false
        maxDays = try c.decodeIfPresent(Int.self, forKey: .maxDays) ?? 14
        loan = try? c.decodeIfPresent(LendingLoanBriefOut.self, forKey: .loan)
        watching = try c.decodeIfPresent(Bool.self, forKey: .watching) ?? false
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
        recentLoans = try? c.decodeIfPresent([LendingLoanBriefOut].self, forKey: .recentLoans)
        watcherCount = try c.decodeIfPresent(Int.self, forKey: .watcherCount)
    }
}

/// A loan (`LendingLoanOut`): the borrow / return / extend / permission answers and GET /lending/loans. The purpose,
/// the teacher and the notes are null for those who may not see them (`detailsHidden`).
struct LendingLoanOut: Codable, Equatable, Identifiable {
    let id: String
    let itemId: String
    let itemName: String
    var itemCode: String? = nil
    let borrowerId: String
    /// active / returned.
    var status: String = "active"
    let borrowedAt: String
    /// "YYYY-MM-DD" in the workspace's zone (the return date, until the end of that day).
    let dueOn: String
    var originalDueOn: String? = nil
    var overdueDays: Int = 0
    var extensionCount: Int = 0
    /// For me: whether I may extend it now, and the latest date the borrower may choose.
    var canExtend: Bool = false
    var latestDueOn: String? = nil
    var purpose: String? = nil
    var permissionRequired: Bool = false
    var approverId: String? = nil
    /// claimed / confirmed / denied.
    var permissionState: String? = nil
    var permissionDecidedAt: String? = nil
    var permissionNote: String? = nil
    var returnedAt: String? = nil
    var returnedBy: String? = nil
    /// ok / issue.
    var returnCondition: String? = nil
    var returnNote: String? = nil
    var detailsHidden: Bool = false

    init(id: String, itemId: String, itemName: String, itemCode: String? = nil, borrowerId: String, status: String = "active",
         borrowedAt: String = "2026-10-26T00:00:00Z", dueOn: String, originalDueOn: String? = nil, overdueDays: Int = 0,
         extensionCount: Int = 0, canExtend: Bool = false, latestDueOn: String? = nil, purpose: String? = nil,
         permissionRequired: Bool = false, approverId: String? = nil, permissionState: String? = nil, permissionNote: String? = nil,
         returnedAt: String? = nil, returnCondition: String? = nil, returnNote: String? = nil, detailsHidden: Bool = false) {
        self.id = id
        self.itemId = itemId
        self.itemName = itemName
        self.itemCode = itemCode
        self.borrowerId = borrowerId
        self.status = status
        self.borrowedAt = borrowedAt
        self.dueOn = dueOn
        self.originalDueOn = originalDueOn
        self.overdueDays = overdueDays
        self.extensionCount = extensionCount
        self.canExtend = canExtend
        self.latestDueOn = latestDueOn
        self.purpose = purpose
        self.permissionRequired = permissionRequired
        self.approverId = approverId
        self.permissionState = permissionState
        self.permissionNote = permissionNote
        self.returnedAt = returnedAt
        self.returnCondition = returnCondition
        self.returnNote = returnNote
        self.detailsHidden = detailsHidden
    }

    private enum CodingKeys: String, CodingKey {
        case id, itemId, itemName, itemCode, borrowerId, status, borrowedAt, dueOn, originalDueOn, overdueDays, extensionCount
        case canExtend, latestDueOn, purpose, permissionRequired, approverId, permissionState, permissionDecidedAt, permissionNote
        case returnedAt, returnedBy, returnCondition, returnNote, detailsHidden
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        itemId = try c.decode(String.self, forKey: .itemId)
        itemName = try c.decodeIfPresent(String.self, forKey: .itemName) ?? ""
        itemCode = try c.decodeIfPresent(String.self, forKey: .itemCode)
        borrowerId = try c.decode(String.self, forKey: .borrowerId)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "active"
        borrowedAt = try c.decode(String.self, forKey: .borrowedAt)
        dueOn = try c.decode(String.self, forKey: .dueOn)
        originalDueOn = try c.decodeIfPresent(String.self, forKey: .originalDueOn)
        overdueDays = try c.decodeIfPresent(Int.self, forKey: .overdueDays) ?? 0
        extensionCount = try c.decodeIfPresent(Int.self, forKey: .extensionCount) ?? 0
        canExtend = try c.decodeIfPresent(Bool.self, forKey: .canExtend) ?? false
        latestDueOn = try c.decodeIfPresent(String.self, forKey: .latestDueOn)
        purpose = try c.decodeIfPresent(String.self, forKey: .purpose)
        permissionRequired = try c.decodeIfPresent(Bool.self, forKey: .permissionRequired) ?? false
        approverId = try c.decodeIfPresent(String.self, forKey: .approverId)
        permissionState = try c.decodeIfPresent(String.self, forKey: .permissionState)
        permissionDecidedAt = try c.decodeIfPresent(String.self, forKey: .permissionDecidedAt)
        permissionNote = try c.decodeIfPresent(String.self, forKey: .permissionNote)
        returnedAt = try c.decodeIfPresent(String.self, forKey: .returnedAt)
        returnedBy = try c.decodeIfPresent(String.self, forKey: .returnedBy)
        returnCondition = try c.decodeIfPresent(String.self, forKey: .returnCondition)
        returnNote = try c.decodeIfPresent(String.self, forKey: .returnNote)
        detailsHidden = try c.decodeIfPresent(Bool.self, forKey: .detailsHidden) ?? false
    }

    var isActive: Bool { status == "active" }
}

/// GET /lending/approvers: who may be named as the teacher (never me), my supervisor among `suggestedIds`, and whether I
/// need no permission myself (a teacher of the roster's @faculty).
struct LendingApproversOut: Codable, Equatable {
    var userIds: [String] = []
    var suggestedIds: [String] = []
    var selfApproved: Bool = false

    init(userIds: [String] = [], suggestedIds: [String] = [], selfApproved: Bool = false) {
        self.userIds = userIds
        self.suggestedIds = suggestedIds
        self.selfApproved = selfApproved
    }

    private enum CodingKeys: String, CodingKey { case userIds, suggestedIds, selfApproved }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userIds = try c.decodeIfPresent([String].self, forKey: .userIds) ?? []
        suggestedIds = try c.decodeIfPresent([String].self, forKey: .suggestedIds) ?? []
        selfApproved = try c.decodeIfPresent(Bool.self, forKey: .selfApproved) ?? false
    }
}

/// `lending.notice` (audience: me): a new activity item about equipment (the push's words while the app is open).
struct LendingNotice: Codable, Equatable {
    /// The activity item.
    let itemId: String
    var lendingItemId: String? = nil
    var loanId: String? = nil
    /// borrower / approver / keeper / watcher.
    var role: String = ""
    let text: String
    var at: String = ""

    private enum CodingKeys: String, CodingKey { case itemId, lendingItemId, loanId, role, text, at }

    init(itemId: String, lendingItemId: String? = nil, loanId: String? = nil, role: String = "", text: String, at: String = "") {
        self.itemId = itemId
        self.lendingItemId = lendingItemId
        self.loanId = loanId
        self.role = role
        self.text = text
        self.at = at
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = try c.decode(String.self, forKey: .itemId)
        lendingItemId = try c.decodeIfPresent(String.self, forKey: .lendingItemId)
        loanId = try c.decodeIfPresent(String.self, forKey: .loanId)
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? ""
        text = try c.decode(String.self, forKey: .text)
        at = try c.decodeIfPresent(String.self, forKey: .at) ?? ""
    }
}

/// A `lending` activity item's notice (asked for with `include=lending`): it opens the loan, else the item, else (the
/// keepers' morning summary) the overdue list. The teacher's to-do (`role` approver) is `done` once decided.
struct ActivityLending: Codable, Equatable {
    /// The activity item (= ActivityItem.id).
    let itemId: String
    var lendingItemId: String? = nil
    var loanId: String? = nil
    /// The item's name now (nil for the summary).
    var itemName: String? = nil
    /// borrower / approver / keeper / watcher.
    var role: String = ""
    var text: String = ""
    var done: Bool = false
    var doneAt: String? = nil
    var doneBy: String? = nil

    init(itemId: String, lendingItemId: String? = nil, loanId: String? = nil, itemName: String? = nil, role: String = "",
         text: String = "", done: Bool = false, doneAt: String? = nil, doneBy: String? = nil) {
        self.itemId = itemId
        self.lendingItemId = lendingItemId
        self.loanId = loanId
        self.itemName = itemName
        self.role = role
        self.text = text
        self.done = done
        self.doneAt = doneAt
        self.doneBy = doneBy
    }

    private enum CodingKeys: String, CodingKey { case itemId, lendingItemId, loanId, itemName, role, text, done, doneAt, doneBy }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = try c.decode(String.self, forKey: .itemId)
        lendingItemId = try c.decodeIfPresent(String.self, forKey: .lendingItemId)
        loanId = try c.decodeIfPresent(String.self, forKey: .loanId)
        itemName = try c.decodeIfPresent(String.self, forKey: .itemName)
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? ""
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
        doneAt = try c.decodeIfPresent(String.self, forKey: .doneAt)
        doneBy = try c.decodeIfPresent(String.self, forKey: .doneBy)
    }

    /// The teacher's 「許可していない」 / 「確認した」 still to press.
    var isOpenApproval: Bool { role == "approver" && !done && loanId != nil }
}

/// What 「借りる」 sends. `clientRequestId` is made once per sheet: a retry after a network failure sends the same one
/// and gets the same loan back (200), never a second one.
struct LendingBorrowForm: Equatable {
    let clientRequestId: String
    /// "YYYY-MM-DD" in the workspace's zone.
    var dueOn: String
    var purpose: String
    var permissionConfirmed: Bool = false
    var approverId: String? = nil

    var json: JSONValue {
        var body: [String: JSONValue] = ["client_request_id": .string(clientRequestId), "due_on": .string(dueOn),
                                         "purpose": .string(purpose)]
        if permissionConfirmed { body["permission_confirmed"] = .bool(true) }
        if let approverId { body["approver_id"] = .string(approverId) }
        return .object(body)
    }
}

/// 409 lending_item_unavailable (docs/LENDING.md §7.1): someone (maybe I) borrowed it first, or it is in repair or retired.
/// The phone says who and until when, and reads the item again.
struct LendingUnavailable: Error, Equatable {
    var status: String? = nil
    var borrowerId: String? = nil
    var dueOn: String? = nil

    static func read(status: Int, data: Data) -> Error? {
        struct Envelope: Decodable {
            struct Inner: Decodable { let code: String; let details: JSONValue? }
            let error: Inner
        }
        guard status == 409, let envelope = try? JSON.plainDecoder.decode(Envelope.self, from: data),
              envelope.error.code == "lending_item_unavailable" else { return nil }
        let details = envelope.error.details
        return LendingUnavailable(status: details?["status"]?.stringValue, borrowerId: details?["borrower_id"]?.stringValue,
                                  dueOn: details?["due_on"]?.stringValue)
    }
}

/// The equipment calls (ApiClient and the test fake).
@MainActor
protocol LendingApi: AnyObject {
    func lendingSettings() async throws -> LendingSettingsOut
    /// M173: the bootstrap's `lending` on its own; nil where the bootstrap has null (off, guests). A server before M173
    /// throws 404 not_found.
    func lendingSummary() async throws -> LendingSummaryOut?
    func lendingCategories() async throws -> [LendingCategoryOut]
    func lendingItems() async throws -> [LendingItemOut]
    func lendingItem(_ id: String) async throws -> LendingItemOut
    /// mine / active / overdue (keepers) / approved.
    func lendingLoans(scope: String) async throws -> [LendingLoanOut]
    func lendingLoan(_ id: String) async throws -> LendingLoanOut
    func lendingApprovers() async throws -> LendingApproversOut
    func borrowLending(itemId: String, form: LendingBorrowForm) async throws -> LendingLoanOut
    func returnLending(loanId: String, condition: String, note: String?) async throws -> LendingLoanOut
    func extendLending(loanId: String, dueOn: String) async throws -> LendingLoanOut
    /// denied (「許可していない」) / confirmed (「確認した」).
    func decideLending(loanId: String, decision: String, note: String?) async throws -> LendingLoanOut
    func watchLending(itemId: String, on: Bool) async throws
}

extension ApiClient: LendingApi {
    // MARK: 備品 (M171, docs/LENDING.md §5)

    func lendingSettings() async throws -> LendingSettingsOut { try await requestJSON("GET", "/api/v1/lending/settings") }

    /// M173 (docs/LENDING.md §5.1): the numbers after lending.updated. 409 lending_disabled (off) and 403
    /// guest_restricted are nil, as the bootstrap's null; 404 not_found (a server before M173) is thrown.
    func lendingSummary() async throws -> LendingSummaryOut? {
        do {
            return try await requestJSON("GET", "/api/v1/lending/summary") as LendingSummaryOut
        } catch ApiError.api(_, let code, _) where code == "lending_disabled" || code == "guest_restricted" {
            return nil
        }
    }

    func lendingCategories() async throws -> [LendingCategoryOut] { try await requestJSON("GET", "/api/v1/lending/categories") }

    /// Every item but the retired ones, by name, in one answer (2,000 at most): the phone filters them itself.
    func lendingItems() async throws -> [LendingItemOut] { try await requestJSON("GET", "/api/v1/lending/items") }

    func lendingItem(_ id: String) async throws -> LendingItemOut { try await requestJSON("GET", "/api/v1/lending/items/\(id)") }

    func lendingLoans(scope: String) async throws -> [LendingLoanOut] {
        try await requestJSON("GET", "/api/v1/lending/loans?scope=\(scope)")
    }

    func lendingLoan(_ id: String) async throws -> LendingLoanOut { try await requestJSON("GET", "/api/v1/lending/loans/\(id)") }

    func lendingApprovers() async throws -> LendingApproversOut { try await requestJSON("GET", "/api/v1/lending/approvers") }

    /// 201 a new loan, 200 the same one for a retry with the same client_request_id. 409 lending_item_unavailable comes
    /// back as LendingUnavailable with who has it until when.
    func borrowLending(itemId: String, form: LendingBorrowForm) async throws -> LendingLoanOut {
        try await requestJSON("POST", "/api/v1/lending/items/\(itemId)/borrow", body: form.json, onError: LendingUnavailable.read)
    }

    func returnLending(loanId: String, condition: String, note: String?) async throws -> LendingLoanOut {
        var body: [String: JSONValue] = ["condition": .string(condition)]
        if let note { body["note"] = .string(note) }
        return try await requestJSON("POST", "/api/v1/lending/loans/\(loanId)/return", body: .object(body))
    }

    func extendLending(loanId: String, dueOn: String) async throws -> LendingLoanOut {
        try await requestJSON("POST", "/api/v1/lending/loans/\(loanId)/extend", body: .object(["due_on": .string(dueOn)]))
    }

    func decideLending(loanId: String, decision: String, note: String?) async throws -> LendingLoanOut {
        var body: [String: JSONValue] = ["decision": .string(decision)]
        if let note { body["note"] = .string(note) }
        return try await requestJSON("POST", "/api/v1/lending/loans/\(loanId)/permission", body: .object(body))
    }

    /// 「返却されたら知らせる」 on / off (204, the same again changes nothing).
    func watchLending(itemId: String, on: Bool) async throws {
        try await requestNoContent(on ? "PUT" : "DELETE", "/api/v1/lending/items/\(itemId)/watch")
    }
}
