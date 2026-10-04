import Foundation

/// M99 (docs/RESERVATIONS.md §3): one member's request in a pool, as the server shows it to me.
struct ReservationOut: Codable, Equatable, Identifiable {
    let id: String
    let userId: String
    /// waiting / holding / returning
    let status: String
    let requestedAt: String
    var assignedAt: String? = nil
    var guaranteeUntil: String? = nil
    var returnedAt: String? = nil
    /// A holder past the guarantee whom a waiting member needs: when the grace period ends.
    var evictAt: String? = nil
    /// Only for those who can operate the pool.
    var email: String? = nil
    var position: Int? = nil
    /// A waiting member: assign (a seat is free) / swap (takes pairId's seat) / wait.
    var step: String? = nil
    var pairId: String? = nil
    var ready: Bool = false
}

/// M99: a channel's reservation pool (shared, limited seats with a queue).
struct PoolOut: Codable, Equatable, Identifiable {
    let id: String
    let channelId: String
    let name: String
    let capacity: Int
    let minHours: Int
    let graceMinutes: Int
    let tz: String
    let enabled: Bool
    var operatorIds: [String] = []
    var botUserId: String? = nil
    var holders: [ReservationOut] = []
    var waiting: [ReservationOut] = []
    var nextEvictId: String? = nil
    var myReservationId: String? = nil
    var canManage: Bool = false
    var canOperate: Bool = false
    let createdAt: String
    let updatedAt: String
}
