import Foundation
import UIKit

/// Two-factor authentication helpers (M12i).
enum Totp {
    /// Spaces dropped; a 6-digit app code or a recovery code (letters, digits, one dash).
    static func normalize(_ code: String) -> String { code.filter { !$0.isWhitespace } }

    static func isCode(_ text: String) -> Bool {
        let value = normalize(text)
        return value.count == 6 && value.allSatisfy(\.isNumber)
    }

    /// Failures in words; nil for anything that is not 2FA specific.
    static func errorText(_ error: Error) -> String? {
        guard case ApiError.api(_, let code, _) = error else { return nil }
        switch code {
        case "invalid_password": return tr("パスワードが違います")
        case "invalid_totp": return tr("認証コードが違います")
        case "totp_required": return tr("認証アプリのコードを入力してください")
        case "totp_already_enabled": return tr("2 要素認証はすでに有効です")
        case "totp_setup_required": return tr("先に設定を始めてください")
        default: return nil
        }
    }

    static func qrImage(base64: String) -> UIImage? {
        guard let data = Data(base64Encoded: base64) else { return nil }
        return UIImage(data: data)
    }

    /// The recovery codes as one text block for the clipboard.
    static func recoveryCodesText(_ codes: [String]) -> String {
        ([tr("Taylis の回復コード (各 1 回だけ使えます)"), ""] + codes).joined(separator: "\n")
    }
}
