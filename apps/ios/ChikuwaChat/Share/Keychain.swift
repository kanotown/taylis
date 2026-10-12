import Foundation
import Security

/// Session secrets live in the Keychain only (SECURITY.md §2.3): a workspace's refresh token under its account
/// ("server|username") and, since the Share Extension (MOBILE_UI.md §21), its current access token under
/// "server|username#access". Both are kept in the Keychain group the app shares with its extension
/// (`keychain-access-groups`: `<team>.jp.chikuwachat.ios.shared`), never in UserDefaults or a file.
enum Keychain {
    static let service = "jp.chikuwachat.ios"

    /// The shared group: the Info.plist's `TaylisKeychainGroup` (`$(AppIdentifierPrefix)jp.chikuwachat.ios.shared`).
    /// nil when the build has no team prefix; items then stay in the app's own group.
    static let sharedGroup: String? = {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "TaylisKeychainGroup") as? String,
              !group.isEmpty, !group.hasPrefix("jp.") else { return nil }
        return group
    }()

    /// The account of a workspace's access token item.
    static func accessAccount(_ account: String) -> String { account + "#access" }

    static func get(account: String, service: String = service) -> String? {
        var query = baseQuery(account, service: service)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Updates the item wherever it is (its own group until migrated), else adds it to the shared group.
    @discardableResult
    static func set(account: String, value: String, service: String = service, group: String? = sharedGroup) -> OSStatus {
        let data = Data(value.utf8)
        let query = baseQuery(account, service: service)
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        guard status == errSecItemNotFound else { return status }
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        if let group { insert[kSecAttrAccessGroup as String] = group }
        var added = SecItemAdd(insert as CFDictionary, nil)
        if added == errSecMissingEntitlement, group != nil {
            // A build signed without the shared group (an unsigned simulator build): the app's own group.
            insert.removeValue(forKey: kSecAttrAccessGroup as String)
            added = SecItemAdd(insert as CFDictionary, nil)
        }
        return added
    }

    /// The account's refresh token and access token go (signing out, another account of the server).
    static func delete(account: String, service: String = service) {
        SecItemDelete(baseQuery(account, service: service) as CFDictionary)
        SecItemDelete(baseQuery(accessAccount(account), service: service) as CFDictionary)
    }

    /// Every item of `service` and the group it is in.
    static func items(service: String = service) -> [(account: String, group: String?)] {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: service,
                                    kSecReturnAttributes as String: true,
                                    kSecMatchLimit as String: kSecMatchLimitAll]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let rows = result as? [[String: Any]] else { return [] }
        return rows.compactMap { row in
            guard let account = row[kSecAttrAccount as String] as? String else { return nil }
            return (account, row[kSecAttrAccessGroup as String] as? String)
        }
    }

    /// The items an older build kept in the app's own group move to the shared one, so the Share Extension can read
    /// them; nobody is signed out (the values stay as they are). Run at every launch: it finds nothing once done.
    /// Returns the accounts moved.
    @discardableResult
    static func migrateToSharedGroup(service: String = service, group: String? = sharedGroup) -> [String] {
        guard let group else { return [] }
        var moved: [String] = []
        for item in items(service: service) where item.group != group {
            var query = baseQuery(item.account, service: service)
            if let old = item.group { query[kSecAttrAccessGroup as String] = old }
            let status = SecItemUpdate(query as CFDictionary, [kSecAttrAccessGroup as String: group] as CFDictionary)
            switch status {
            case errSecSuccess:
                moved.append(item.account)
            case errSecDuplicateItem:
                // Already in the shared group (a newer value written there): the old copy goes.
                SecItemDelete(query as CFDictionary)
                moved.append(item.account)
            case errSecMissingEntitlement:
                return moved // this build cannot use the shared group: leave everything where it is
            default:
                // Moving in place failed: copy the value over, then remove the old item.
                guard let value = value(query) else { continue }
                var insert = baseQuery(item.account, service: service)
                insert[kSecValueData as String] = Data(value.utf8)
                insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                insert[kSecAttrAccessGroup as String] = group
                if SecItemAdd(insert as CFDictionary, nil) == errSecSuccess {
                    SecItemDelete(query as CFDictionary)
                    moved.append(item.account)
                }
            }
        }
        return moved
    }

    private static func value(_ query: [String: Any]) -> String? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func baseQuery(_ account: String, service: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }
}
