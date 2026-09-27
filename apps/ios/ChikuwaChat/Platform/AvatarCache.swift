import Observation
import UIKit

/// Profile pictures (M14a): fetched once per (user, version) through the API and kept in memory.
/// `versions` follows the store's users; a view asks `image(for:)` and gets the initials until it arrives.
@MainActor
@Observable
final class AvatarCache {
    static let shared = AvatarCache()

    private(set) var versions: [String: String] = [:]
    private var images: [String: UIImage] = [:]
    private var loading: Set<String> = []
    var fetcher: ((String) async throws -> Data)?

    func note(_ user: UserPublic) {
        if let version = user.avatarUpdatedAt { versions[user.id] = version } else { versions.removeValue(forKey: user.id) }
    }

    func reset() {
        versions = [:]
        images = [:]
        loading = []
        fetcher = nil
    }

    /// The cached picture; starts a fetch and returns nil until it arrives (or always, without a picture).
    func image(for id: String) -> UIImage? {
        guard let version = versions[id] else { return nil }
        let key = id + "|" + version
        if let image = images[key] { return image }
        guard let fetcher, !loading.contains(key) else { return nil }
        loading.insert(key)
        Task {
            defer { loading.remove(key) }
            let escaped = version.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? version
            if let data = try? await fetcher("/api/v1/users/\(id)/avatar?v=\(escaped)"), let image = UIImage(data: data) {
                images[key] = image
            }
        }
        return nil
    }
}
