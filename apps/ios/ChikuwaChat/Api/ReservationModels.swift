import Foundation

/// M99, M112 (docs/RESERVATIONS.md §3): one member's request in a pool — a booking (kind "booking": a slot of whole
/// hours) or a walk-in (kind "walkin": the 「今すぐ」 queue) — as the server shows it to me.
struct ReservationOut: Codable, Equatable, Identifiable {
    let id: String
    let userId: String
    /// walkin / booking
    let kind: String
    /// waiting / booked / holding / returning / done
    let status: String
    let requestedAt: String
    /// A booking's slot.
    var startAt: String? = nil
    var endAt: String? = nil
    var assignedAt: String? = nil
    var guaranteeUntil: String? = nil
    var returnedAt: String? = nil
    /// A walk-in someone needs: when its seat goes (it was told).
    var evictAt: String? = nil
    /// Only for those who can operate the pool.
    var email: String? = nil
    var position: Int? = nil
    /// A waiting walk-in or a started booking: assign (a seat is free) / swap (takes pairId's seat) / wait.
    var step: String? = nil
    var pairId: String? = nil
    var ready: Bool = false
    /// A waiting walk-in with a free seat: a booking needs it from then (「〜13:00 まで」).
    var until: String? = nil
    /// My booking can grow by an hour.
    var canExtend: Bool = false

    init(id: String, userId: String, kind: String = "booking", status: String, requestedAt: String, startAt: String? = nil,
         endAt: String? = nil, assignedAt: String? = nil, guaranteeUntil: String? = nil, returnedAt: String? = nil,
         evictAt: String? = nil, email: String? = nil, position: Int? = nil, step: String? = nil, pairId: String? = nil,
         ready: Bool = false, until: String? = nil, canExtend: Bool = false) {
        self.id = id
        self.userId = userId
        self.kind = kind
        self.status = status
        self.requestedAt = requestedAt
        self.startAt = startAt
        self.endAt = endAt
        self.assignedAt = assignedAt
        self.guaranteeUntil = guaranteeUntil
        self.returnedAt = returnedAt
        self.evictAt = evictAt
        self.email = email
        self.position = position
        self.step = step
        self.pairId = pairId
        self.ready = ready
        self.until = until
        self.canExtend = canExtend
    }

    private enum CodingKeys: String, CodingKey {
        case id, userId, kind, status, requestedAt, startAt, endAt, assignedAt, guaranteeUntil, returnedAt, evictAt, email
        case position, step, pairId, ready, until, canExtend
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        userId = try c.decode(String.self, forKey: .userId)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "walkin"
        status = try c.decode(String.self, forKey: .status)
        requestedAt = try c.decode(String.self, forKey: .requestedAt)
        startAt = try c.decodeIfPresent(String.self, forKey: .startAt)
        endAt = try c.decodeIfPresent(String.self, forKey: .endAt)
        assignedAt = try c.decodeIfPresent(String.self, forKey: .assignedAt)
        guaranteeUntil = try c.decodeIfPresent(String.self, forKey: .guaranteeUntil)
        returnedAt = try c.decodeIfPresent(String.self, forKey: .returnedAt)
        evictAt = try c.decodeIfPresent(String.self, forKey: .evictAt)
        email = try c.decodeIfPresent(String.self, forKey: .email)
        position = try c.decodeIfPresent(Int.self, forKey: .position)
        step = try c.decodeIfPresent(String.self, forKey: .step)
        pairId = try c.decodeIfPresent(String.self, forKey: .pairId)
        ready = try c.decodeIfPresent(Bool.self, forKey: .ready) ?? false
        until = try c.decodeIfPresent(String.self, forKey: .until)
        canExtend = try c.decodeIfPresent(Bool.self, forKey: .canExtend) ?? false
    }
}

/// M112: something an operator does in the resource's own console, then presses here.
struct ReservationTodo: Codable, Equatable, Identifiable {
    let key: String
    /// assign / swap / remove
    let action: String
    /// free / returned / booking_ended / guarantee_over
    let reason: String
    var assignId: String? = nil
    var removeId: String? = nil
    let dueAt: String
    /// A booking starting within 10 minutes: not yet.
    var upcoming: Bool = false

    var id: String { key }
}

/// M112: a reservation pool of the workspace (shared, limited seats booked by the hour or queued for).
struct PoolOut: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    let capacity: Int
    let minHours: Int
    var maxHours: Int = 6
    let graceMinutes: Int
    let tz: String
    let enabled: Bool
    var operatorIds: [String] = []
    var logChannelId: String? = nil
    var visibility: String = "all"
    var visibilityChannelId: String? = nil
    var visibilityGroupId: String? = nil
    var holders: [ReservationOut] = []
    var waiting: [ReservationOut] = []
    var bookings: [ReservationOut] = []
    var todos: [ReservationTodo] = []
    var nextEvictId: String? = nil
    var myReservationId: String? = nil
    /// The caller's one active reservation in the pool (waiting, booked, on a seat, returned but not yet removed).
    var myActiveId: String? = nil
    var canManage: Bool = false
    var canOperate: Bool = false
    var horizonDays: Int = 14
    let createdAt: String
    let updatedAt: String

    init(id: String, name: String, capacity: Int, minHours: Int = 6, maxHours: Int = 6, graceMinutes: Int = 15,
         tz: String = "Asia/Tokyo", enabled: Bool = true, operatorIds: [String] = [], holders: [ReservationOut] = [],
         waiting: [ReservationOut] = [], bookings: [ReservationOut] = [], todos: [ReservationTodo] = [],
         nextEvictId: String? = nil, myReservationId: String? = nil, myActiveId: String? = nil, canManage: Bool = false,
         canOperate: Bool = false,
         horizonDays: Int = 14, createdAt: String = "2026-10-01T00:00:00Z", updatedAt: String = "2026-10-01T00:00:00Z") {
        self.id = id
        self.name = name
        self.capacity = capacity
        self.minHours = minHours
        self.maxHours = maxHours
        self.graceMinutes = graceMinutes
        self.tz = tz
        self.enabled = enabled
        self.operatorIds = operatorIds
        self.holders = holders
        self.waiting = waiting
        self.bookings = bookings
        self.todos = todos
        self.nextEvictId = nextEvictId
        self.myReservationId = myReservationId
        self.myActiveId = myActiveId
        self.canManage = canManage
        self.canOperate = canOperate
        self.horizonDays = horizonDays
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// M112: `reservation.notice` — a new activity item about reservations for me (the push's words while the app is open).
struct ReservationNotice: Codable, Equatable {
    let itemId: String
    let poolId: String
    var reservationId: String? = nil
    let text: String
    var `operator`: Bool = false
    let at: String
}

/// M112: a reservation item's notice (activity kind `reservation`); it opens 「予約」.
struct ActivityReservation: Codable, Equatable {
    let itemId: String
    let poolId: String
    var poolName: String = ""
    var reservationId: String? = nil
    var text: String = ""
    var `operator`: Bool = false
    var done: Bool = false
    var doneAt: String? = nil
    var doneBy: String? = nil

    init(itemId: String, poolId: String, poolName: String = "", reservationId: String? = nil, text: String = "",
         operator: Bool = false, done: Bool = false, doneAt: String? = nil, doneBy: String? = nil) {
        self.itemId = itemId
        self.poolId = poolId
        self.poolName = poolName
        self.reservationId = reservationId
        self.text = text
        self.operator = `operator`
        self.done = done
        self.doneAt = doneAt
        self.doneBy = doneBy
    }

    private enum CodingKeys: String, CodingKey { case itemId, poolId, poolName, reservationId, text, `operator`, done, doneAt, doneBy }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = try c.decode(String.self, forKey: .itemId)
        poolId = try c.decode(String.self, forKey: .poolId)
        poolName = try c.decodeIfPresent(String.self, forKey: .poolName) ?? ""
        reservationId = try c.decodeIfPresent(String.self, forKey: .reservationId)
        text = try c.decodeIfPresent(String.self, forKey: .text) ?? ""
        `operator` = try c.decodeIfPresent(Bool.self, forKey: .operator) ?? false
        done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
        doneAt = try c.decodeIfPresent(String.self, forKey: .doneAt)
        doneBy = try c.decodeIfPresent(String.self, forKey: .doneBy)
    }
}
