import SwiftUI

/// M99 (docs/RESERVATIONS.md §6): the pure parts of a channel's reservation pools (the chip's and the card's words).
enum ReservationRules {
    enum Mine: Equatable {
        case none
        case waiting(ReservationOut)
        case holding(ReservationOut)
        case returning(ReservationOut)
    }

    /// My request in the pool, if any.
    static func mine(_ pool: PoolOut) -> Mine {
        guard let id = pool.myReservationId else { return .none }
        if let held = pool.holders.first(where: { $0.id == id }) { return held.status == "returning" ? .returning(held) : .holding(held) }
        if let waiting = pool.waiting.first(where: { $0.id == id }) { return .waiting(waiting) }
        return .none
    }

    /// 「2/3 · 待ち 1」.
    static func summary(_ pool: PoolOut) -> String {
        let base = "\(pool.holders.count)/\(pool.capacity)"
        return pool.waiting.isEmpty ? base : "\(base) · 待ち \(pool.waiting.count)"
    }

    /// What my chip says about me (empty when I am not in the pool).
    static func myStatus(_ pool: PoolOut, when: (String) -> String = RecurringRules.shortDateTime) -> String {
        switch mine(pool) {
        case .none: return ""
        case .waiting(let row): return "待ち \(row.position.map(String.init) ?? "?") 番目"
        case .returning: return "返却中"
        case .holding(let row):
            if let evict = row.evictAt { return "\(when(evict)) 以降に外されます" }
            return row.guaranteeUntil.map { "利用中 (保証 \(when($0)) まで)" } ?? "利用中"
        }
    }

    /// Whether my chip should stand out: I am about to lose the seat, or a seat is ready for me.
    static func urgent(_ pool: PoolOut) -> Bool {
        switch mine(pool) {
        case .holding(let row): return row.evictAt != nil
        case .waiting(let row): return row.ready
        default: return false
        }
    }

    /// The line under a waiting member.
    static func waiterLine(_ row: ReservationOut, pool: PoolOut, name: (String) -> String,
                           when: (String) -> String = RecurringRules.shortDateTime) -> String {
        let since = "\(when(row.requestedAt)) に予約"
        switch row.step {
        case "assign": return "\(since) · 空きあり (担当者の割り当て待ち)"
        case "swap":
            let holder = pool.holders.first { $0.id == row.pairId }
            let who = holder.map { "\(name($0.userId)) さん" } ?? "前の人"
            if holder?.status == "returning" { return "\(since) · \(who)の返却分 (担当者が外し次第)" }
            if row.ready { return "\(since) · \(who)と入れ替えできます" }
            if let evict = holder?.evictAt { return "\(since) · \(who)の後 (\(when(evict)) 以降)" }
            return "\(since) · \(who)の後"
        default: return "\(since) · 保証時間が過ぎる人を待っています"
        }
    }

    /// The line under a holder.
    static func holderLine(_ row: ReservationOut, when: (String) -> String = RecurringRules.shortDateTime) -> String {
        var parts: [String] = []
        if let at = row.assignedAt { parts.append("\(when(at)) から") }
        if let until = row.guaranteeUntil { parts.append("保証 \(when(until)) まで") }
        return parts.joined(separator: " · ")
    }

    /// A holder's state at a glance; `danger` for the ones about to go.
    static func holderBadge(_ row: ReservationOut, pool: PoolOut, now: Date = Date(),
                            when: (String) -> String = RecurringRules.shortDateTime) -> (text: String, danger: Bool)? {
        if row.status == "returning" { return ("返却済み · 外し待ち", false) }
        if let evict = row.evictAt { return row.ready ? ("入れ替えできます", true) : ("\(when(evict)) 以降に外す", true) }
        if pool.nextEvictId == row.id { return ("次に外す", false) }
        if let until = row.guaranteeUntil.flatMap(parseIsoDate), until <= now { return ("保証時間終了", false) }
        return nil
    }

    /// Before the guarantee ends: 「外した」 asks louder.
    static func early(_ row: ReservationOut, now: Date = Date()) -> Bool {
        guard row.status == "holding", row.evictAt == nil, let until = row.guaranteeUntil.flatMap(parseIsoDate) else { return false }
        return until > now
    }
}

/// The channel's pools as chips at the top of the conversation (above the tabs); nothing when it has none.
struct ReservationChipRow: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    let onOpen: (String) -> Void

    var body: some View {
        let pools = controller.store.poolsOf(channel.id).filter { $0.enabled || !$0.holders.isEmpty || !$0.waiting.isEmpty }
        // A stack even when empty (an empty Group carries no modifiers).
        VStack(spacing: 0) {
            if !pools.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(pools) { pool in
                            let status = ReservationRules.myStatus(pool)
                            Button { onOpen(pool.id) } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "ticket")
                                    Text(pool.name).fontWeight(.medium).lineLimit(1)
                                    Text(ReservationRules.summary(pool)).foregroundStyle(.secondary)
                                    if !status.isEmpty {
                                        Text("· \(status)").foregroundStyle(ReservationRules.urgent(pool) ? Color.red : Color.accentColor)
                                    }
                                }
                                .font(.caption)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .accessibilityLabel("\(pool.name) \(ReservationRules.summary(pool)) \(status)")
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
                }
                Divider()
            }
        }
    }
}

/// One pool's card: holders, the queue, my status and buttons; operators also assign / remove / swap.
struct ReservationSheet: View {
    @Bindable var controller: AppController
    let channelId: String
    let poolId: String
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var confirm: Confirm?

    struct Confirm: Identifiable {
        let id = UUID()
        let text: String
        let label: String
        var destructive = false
        let run: () async -> Void
    }

    private var pool: PoolOut? { controller.store.poolsOf(channelId).first { $0.id == poolId } }
    private var channel: ChannelState? { controller.store.channel(channelId) }

    private func name(_ userId: String) -> String { controller.store.statusUser(userId)?.displayName ?? "(不明)" }

    private func run(_ call: @escaping () async -> Void) {
        guard !busy else { return }
        busy = true
        Task {
            await call()
            busy = false
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if let pool {
                    content(pool)
                } else {
                    ContentUnavailableView("枠がありません", systemImage: "ticket")
                }
            }
            .navigationTitle(pool?.name ?? "共有枠の予約")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
            .confirmationDialog(confirm?.text ?? "", isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
                                titleVisibility: .visible, presenting: confirm) { which in
                Button(which.label, role: which.destructive ? .destructive : nil) { run(which.run) }
                Button("キャンセル", role: .cancel) {}
            }
        }
    }

    @ViewBuilder private func content(_ pool: PoolOut) -> some View {
        let operate = pool.canOperate && channel?.channel.archived != true
        List {
            Section {
                mineRow(pool)
            } footer: {
                Text("割り当てから \(pool.minHours) 時間は外されません。過ぎた後に待つ人がいれば、保証の終わりが早い人から \(pool.graceMinutes) 分の猶予の後に入れ替えます。"
                     + (pool.canOperate ? " 担当者の操作は、管理画面で実際に変えた後に押してください。" : ""))
            }
            Section("利用中 \(pool.holders.count)/\(pool.capacity)") {
                if pool.holders.isEmpty { Text("いません").foregroundStyle(.secondary) }
                ForEach(pool.holders) { row in
                    personRow(row, line: ReservationRules.holderLine(row), badge: ReservationRules.holderBadge(row, pool: pool)) {
                        if operate {
                            let early = ReservationRules.early(row)
                            Button("外した") {
                                confirm = Confirm(
                                    text: early ? "\(name(row.userId)) さんはまだ保証時間内です。管理画面で外しましたか？" : "\(name(row.userId)) さんを管理画面で外しましたか？",
                                    label: "外した", destructive: early,
                                    run: { _ = await controller.reservationAction(row.id, "remove") })
                            }
                            .buttonStyle(.bordered).tint(row.ready ? .accentColor : .secondary)
                        }
                    }
                }
            }
            Section("待ち \(pool.waiting.count) 人") {
                if pool.waiting.isEmpty { Text("いません").foregroundStyle(.secondary) }
                ForEach(pool.waiting) { row in
                    let holder = row.step == "swap" ? pool.holders.first { $0.id == row.pairId } : nil
                    personRow(row, line: ReservationRules.waiterLine(row, pool: pool, name: name), badge: nil) {
                        if operate {
                            VStack(alignment: .trailing, spacing: 4) {
                                if row.step == "assign" {
                                    Button("割り当てた") { run { _ = await controller.reservationAction(row.id, "assign") } }
                                        .buttonStyle(.borderedProminent)
                                }
                                if let holder, row.ready {
                                    Button("入れ替えた") {
                                        confirm = Confirm(
                                            text: "管理画面で \(name(holder.userId)) さんを外して \(name(row.userId)) さんを割り当てましたか？",
                                            label: "入れ替えた",
                                            run: { _ = await controller.swapReservations(pool.id, removeId: holder.id, assignId: row.id) })
                                    }
                                    .buttonStyle(.borderedProminent)
                                }
                            }
                        }
                    }
                    .swipeActions {
                        if operate && row.id != pool.myReservationId {
                            Button("取り消す", role: .destructive) {
                                confirm = Confirm(text: "\(name(row.userId)) さんの予約を取り消しますか？ 本人に知らせます。", label: "取り消す",
                                                  destructive: true, run: { _ = await controller.reservationAction(row.id, "cancel") })
                            }
                        }
                    }
                }
            }
        }
        .disabled(busy)
        .refreshable { await controller.engine?.loadReservationPools(channelId) }
    }

    @ViewBuilder private func mineRow(_ pool: PoolOut) -> some View {
        let canReserve = pool.enabled && channel?.isMember == true && channel?.channel.archived != true && !controller.isGuest
        switch ReservationRules.mine(pool) {
        case .none:
            HStack {
                Text(pool.enabled ? "予約していません" : "この枠は今は予約を受け付けていません")
                Spacer()
                if canReserve {
                    Button("予約する") { run { _ = await controller.reservePool(pool.id) } }.buttonStyle(.borderedProminent)
                }
            }
        case .waiting(let row):
            HStack {
                Text("予約中: 待ち \(row.position.map(String.init) ?? "?") 番目" + (row.step == "assign" ? " (空きあり)" : ""))
                Spacer()
                Button("取り消す") { run { _ = await controller.reservationAction(row.id, "cancel") } }.buttonStyle(.bordered)
            }
        case .holding(let row):
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(row.guaranteeUntil.map { "利用中 · 保証 \(RecurringRules.shortDateTime($0)) まで" } ?? "利用中")
                    Spacer()
                    Button("返却する") {
                        confirm = Confirm(text: "「\(pool.name)」を返却しますか？ 担当者が外します。", label: "返却する",
                                          run: { _ = await controller.reservationAction(row.id, "return") })
                    }
                    .buttonStyle(.bordered)
                }
                if let evict = row.evictAt {
                    Text("待っている人がいます。\(RecurringRules.shortDateTime(evict)) 以降に担当者が外します").font(.caption).foregroundStyle(.red)
                }
            }
        case .returning:
            Text("返却しました。担当者が外すのを待っています").foregroundStyle(.secondary)
        }
    }

    private func personRow<Buttons: View>(_ row: ReservationOut, line: String, badge: (text: String, danger: Bool)?,
                                          @ViewBuilder buttons: () -> Buttons) -> some View {
        HStack(alignment: .top, spacing: 10) {
            AvatarView(id: row.userId, name: name(row.userId), size: 28)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(name(row.userId)).fontWeight(.medium)
                    if row.id == pool?.myReservationId { Text("(自分)").font(.caption).foregroundStyle(.secondary) }
                    if let position = row.position { Text("\(position) 番目").font(.caption).foregroundStyle(.secondary) }
                    if let badge {
                        Text(badge.text).font(.caption2.bold())
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(badge.danger ? Color.red.opacity(0.15) : Color.accentColor.opacity(0.15), in: Capsule())
                            .foregroundStyle(badge.danger ? Color.red : Color.accentColor)
                    }
                }
                if let email = row.email { Text(email).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                Text(line).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            buttons()
        }
    }
}
