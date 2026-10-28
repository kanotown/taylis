import Foundation

/// AL3 (docs/ALBUMS.md §10, §12, §18.4): the pure parts of the phone's albums — the grid's date headings, the header's
/// and the card's lines, the columns, what a message adds, a new album's name, and the slideshow's order and times.
enum AlbumRules {
    // MARK: dates

    /// The time a photo is placed by, as the server orders `taken`: its capture time, else the file's own time, else
    /// when it was added.
    static func placedAt(_ item: DriveItemOut) -> Date? {
        if let taken = item.file?.takenAt, let date = parseIsoDate(taken) { return date }
        if let own = item.contentModifiedAt, let date = parseIsoDate(own) { return date }
        return parseIsoDate(item.createdAt)
    }

    struct Section: Equatable, Identifiable {
        /// The day (yyyy-MM-dd on this device), or "all" for an order without headings.
        let id: String
        /// 「9月16日（火）」; nil: no heading (ordered by name or by when added).
        let title: String?
        let items: [DriveItemOut]
    }

    /// The grid's sections: by capture day (in the album's order, a day once even when photos of another day come
    /// between — they do not, as the server orders by that time), or one without a heading for the other orders.
    static func sections(_ items: [DriveItemOut], sort: AlbumSort, now: Date = Date(), calendar: Calendar = .current) -> [Section] {
        guard !items.isEmpty else { return [] }
        guard sort == .taken else { return [Section(id: "all", title: nil, items: items)] }
        var out: [(key: String, title: String, items: [DriveItemOut])] = []
        for item in items {
            let date = placedAt(item)
            let key = date.map { dayKey($0, calendar: calendar) } ?? "unknown"
            if let last = out.indices.last, out[last].key == key {
                out[last].items.append(item)
            } else {
                out.append((key, date.map { dayTitle($0, now: now, calendar: calendar) } ?? tr("日付なし"), [item]))
            }
        }
        // Distinct ids for the grid even if a day came twice (a photo without a time among them).
        var seen: [String: Int] = [:]
        return out.map { entry in
            let n = seen[entry.key, default: 0]
            seen[entry.key] = n + 1
            return Section(id: n == 0 ? entry.key : "\(entry.key)#\(n)", title: entry.title, items: entry.items)
        }
    }

    static func dayKey(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// 「9月16日（火）」 this year, 「2025年9月16日（火）」 before.
    static func dayTitle(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day, .weekday], from: date)
        let weekdays = AppDates.weekdaysSundayFirst
        let weekday = weekdays.indices.contains((parts.weekday ?? 1) - 1) ? weekdays[(parts.weekday ?? 1) - 1] : ""
        let month = parts.month ?? 0, day = parts.day ?? 0
        if parts.year == calendar.component(.year, from: now) { return tr("\(month)月\(day)日（\(weekday)）") }
        return tr("\(String(parts.year ?? 0))年\(month)月\(day)日（\(weekday)）")
    }

    /// 「2026/9/16 9:12」: the viewer's header (no weekday, no year words: it shares the line).
    static func shortTime(_ date: Date, calendar: Calendar = .current) -> String {
        let p = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return String(format: "%d/%d/%d %d:%02d", p.year ?? 0, p.month ?? 0, p.day ?? 0, p.hour ?? 0, p.minute ?? 0)
    }

    /// A date-only value (yyyy-MM-dd) as that day, read in `calendar`'s zone.
    static func day(_ text: String, calendar: Calendar = .current) -> DateComponents? {
        let parts = text.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return DateComponents(year: parts[0], month: parts[1], day: parts[2])
    }

    /// yyyy-MM-dd of a picked day (the new album's dates).
    static func dayString(_ date: Date, calendar: Calendar = .current) -> String { dayKey(date, calendar: calendar) }

    /// 「2026/9/16〜9/19」: the event's own dates, else the photos' range; a single day once; nil without either.
    static func dateRange(_ album: AlbumOut, calendar: Calendar = .current) -> String? {
        var from: DateComponents?, to: DateComponents?
        if let starts = album.startsOn.flatMap({ day($0) }) {
            from = starts
            to = album.endsOn.flatMap { day($0) } ?? starts
        } else if let first = album.takenFrom.flatMap(parseIsoDate) {
            from = calendar.dateComponents([.year, .month, .day], from: first)
            to = album.takenTo.flatMap(parseIsoDate).map { calendar.dateComponents([.year, .month, .day], from: $0) } ?? from
        }
        guard let from, let to else { return nil }
        let start = "\(from.year ?? 0)/\(from.month ?? 0)/\(from.day ?? 0)"
        if from.year == to.year && from.month == to.month && from.day == to.day { return start }
        let end = from.year == to.year ? "\(to.month ?? 0)/\(to.day ?? 0)" : "\(to.year ?? 0)/\(to.month ?? 0)/\(to.day ?? 0)"
        return tr("\(start)〜\(end)")
    }

    /// 「312 枚」, 「312 枚 · 動画 8 本」 (photos and videos counted apart).
    static func countLabel(_ album: AlbumOut) -> String {
        var parts = [tr("\(album.photoCount) 枚")]
        if album.videoCount > 0 { parts.append(tr("動画 \(album.videoCount) 本")) }
        return parts.joined(separator: " · ")
    }

    /// The card's and the list's line: 「312 枚 · 2026/9/16〜9/19」.
    static func summary(_ album: AlbumOut, calendar: Calendar = .current) -> String {
        [countLabel(album), dateRange(album, calendar: calendar)].compactMap { $0 }.joined(separator: " · ")
    }

    // MARK: the grid

    /// 3 columns on a phone, more on an iPad or the iPhone Duo's inner screen (about 130 pt a cell, at most 8).
    static func columns(width: CGFloat) -> Int {
        guard width >= 560 else { return 3 }
        return min(8, max(5, Int(width / 150)))
    }

    static func isVideo(_ item: DriveItemOut) -> Bool { (item.contentType ?? "").lowercased().hasPrefix("video/") }
    static func isPhoto(_ item: DriveItemOut) -> Bool { !isVideo(item) && (item.contentType ?? "").lowercased().hasPrefix("image/") }

    /// Where the viewer reads a photo: the display size (2048 px), which the server falls back from to the original
    /// raster (never the original of a HEIC or a RAW: those stay icons).
    static func displayPath(_ attachmentId: String) -> String { "/api/v1/attachments/\(attachmentId)/display" }

    // MARK: from a message (§9)

    /// A message's photos and videos 「この投稿の写真をアルバムに」 adds: still there (not in the trash nor purged).
    static func messageMedia(_ attachments: [AttachmentOut]) -> [AttachmentOut] {
        attachments.filter { attachment in
            // By its type (a PDF may carry a thumbnail of its first page, and a HEIC none).
            guard attachment.isVideo || attachment.contentType.lowercased().hasPrefix("image/") else { return false }
            if let state = attachment.drive?.state, state == "trashed" || state == "deleted" { return false }
            return true
        }
    }

    /// 「#学会 2026-09-16」: a new album made from a message (its channel's name and day); a DM: the day.
    static func defaultName(channelName: String?, postedAt: String, calendar: Calendar = .current) -> String {
        let day = parseIsoDate(postedAt).map { dayKey($0, calendar: calendar) } ?? dayKey(Date(), calendar: calendar)
        guard let channelName, !channelName.isEmpty else { return day }
        return "#\(channelName) \(day)"
    }

    /// The albums offered for a message's photos: those in places I can write, the conversation's own drive first,
    /// then the others in the server's order (newest first).
    static func pickable(_ entries: [AlbumListEntryOut], writable: (String) -> Bool, channelLocationId: String?) -> [AlbumListEntryOut] {
        let open = entries.filter { writable($0.folder.locationId) }
        guard let channelLocationId else { return open }
        return open.filter { $0.folder.locationId == channelLocationId } + open.filter { $0.folder.locationId != channelLocationId }
    }

    /// The toast after adding: 「3 枚をアルバム「学会」に追加しました」, with what failed.
    static func addedNotice(_ out: AlbumAddOut, album: String) -> String {
        let ok = out.results.filter(\.ok).count
        let failed = out.results.count - ok
        if ok == 0 { return tr("アルバムに追加できませんでした") }
        let added = tr("\(ok) 枚をアルバム「\(album)」に追加しました")
        return failed > 0 ? added + tr("（\(failed) 枚は追加できませんでした）") : added
    }
}

/// The 「ファイルの一覧で見る」 choice per album, kept on this device (ALBUMS.md §10.1).
enum AlbumListPreference {
    static let key = "album.listView"

    static func showsList(_ folderId: String, defaults: UserDefaults = .standard) -> Bool {
        (defaults.stringArray(forKey: key) ?? []).contains(folderId)
    }

    static func set(_ folderId: String, list: Bool, defaults: UserDefaults = .standard) {
        var ids = defaults.stringArray(forKey: key) ?? []
        ids.removeAll { $0 == folderId }
        if list { ids.append(folderId) }
        defaults.set(Array(ids.suffix(200)), forKey: key)
    }
}

/// AL3 (§8, §10.3, §12): the slideshow's order and how long each item stays. Photos for the chosen interval; a video
/// (muted) to its end, at most a minute; 「動画を飛ばす」 leaves them out; random shuffles once per show.
enum SlideshowRules {
    static let intervals: [Int] = [3, 5, 10]
    static let videoCap: Double = 60

    static func sequence(_ items: [DriveItemOut], skipVideos: Bool, random: Bool, start: String? = nil,
                         shuffle: ([DriveItemOut]) -> [DriveItemOut] = { $0.shuffled() }) -> [DriveItemOut] {
        let shown = items.filter { AlbumRules.isPhoto($0) || (!skipVideos && AlbumRules.isVideo($0)) }
            .filter { AlbumRules.isVideo($0) || $0.file?.hasThumbnail == true || $0.file?.hasDisplay == true }
        guard random else {
            guard let start, let index = shown.firstIndex(where: { $0.id == start }) else { return shown }
            return Array(shown[index...]) + Array(shown[..<index])
        }
        return shuffle(shown)
    }

    /// Seconds an item stays: a photo the interval; a video its length, at most a minute (nil length: the minute,
    /// or its end when that comes first).
    static func duration(_ item: DriveItemOut, interval: Int) -> Double {
        guard AlbumRules.isVideo(item) else { return Double(interval) }
        guard let ms = item.file?.durationMs, ms > 0 else { return videoCap }
        return min(videoCap, Double(ms) / 1000)
    }

    /// The next index, wrapping round (a slideshow goes on until stopped).
    static func next(_ index: Int, count: Int) -> Int { count == 0 ? 0 : (index + 1) % count }
    static func previous(_ index: Int, count: Int) -> Int { count == 0 ? 0 : (index - 1 + count) % count }

    /// The photos read ahead: the next two.
    static func ahead(_ index: Int, count: Int) -> [Int] {
        guard count > 1 else { return [] }
        return [1, 2].map { (index + $0) % count }.filter { $0 != index }
    }
}
