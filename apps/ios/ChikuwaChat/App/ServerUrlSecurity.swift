import Foundation

/// M190 (SECURITY.md §6.1): whether a server URL is https, plain HTTP to a server off the internet (a LAN, this device,
/// a Tailscale address), or plain HTTP across the internet. Only the last asks for a confirmation before the app first
/// contacts the server (sign in, Google sign-in, an invite link). The cases: apps/shared/server-url-security.json, as
/// the desktop's serverUrlSecurity.ts and Android's ServerUrlSecurity.kt read them.
enum ServerUrlSecurity: String {
    case secure, local, insecure

    /// A normalized server URL (or an invite link's server) → its class; an http URL that cannot be read is insecure.
    static func classify(_ url: String) -> ServerUrlSecurity {
        let text = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: text), let scheme = components.scheme?.lowercased() else {
            return text.lowercased().hasPrefix("https:") ? .secure : .insecure
        }
        if scheme == "https" { return .secure }
        return classify(host: components.host ?? "")
    }

    /// The same URL with https: the action 「https で接続」.
    static func https(_ url: String) -> String {
        let text = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.lowercased().hasPrefix("http:") else { return text }
        return "https:" + text.dropFirst(5)
    }

    private static let localSuffixes = ["localhost", "local", "lan", "home.arpa", "internal"]

    /// The host of an http URL (brackets, an IPv6 zone, upper case and a trailing dot allowed).
    static func classify(host input: String) -> ServerUrlSecurity {
        var host = input.trimmingCharacters(in: .whitespaces).lowercased()
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        if host.contains(":") {
            if let zone = host.firstIndex(of: "%") { host = String(host[..<zone]) }
            guard let bytes = ipv6(host) else { return .insecure }
            return isLocal(ipv6: bytes) ? .local : .insecure
        }
        if host.hasSuffix(".") { host.removeLast() }
        if host.isEmpty { return .insecure }
        if endsInNumber(host) {
            guard let address = ipv4(host) else { return .insecure }
            return isLocal(ipv4: address) ? .local : .insecure
        }
        if !host.contains(".") { return .local } // a single-label name: the LAN's own DNS or the hosts file
        return localSuffixes.contains { host == $0 || host.hasSuffix("." + $0) } ? .local : .insecure
    }

    /// 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 and 100.64/10 (carrier-grade NAT, Tailscale).
    private static func isLocal(ipv4 address: UInt32) -> Bool {
        let a = address >> 24, b = (address >> 16) & 0xff
        return a == 127 || a == 10 || (a == 172 && (16...31).contains(b)) || (a == 192 && b == 168) || (a == 169 && b == 254)
            || (a == 100 && (64...127).contains(b))
    }

    /// ::1, fc00::/7, fe80::/10, and an IPv4-mapped address (::ffff:a.b.c.d) by its IPv4 address.
    private static func isLocal(ipv6 bytes: [UInt8]) -> Bool {
        if bytes[0..<15].allSatisfy({ $0 == 0 }), bytes[15] == 1 { return true }
        if bytes[0..<10].allSatisfy({ $0 == 0 }), bytes[10] == 0xff, bytes[11] == 0xff {
            return isLocal(ipv4: UInt32(bytes[12]) << 24 | UInt32(bytes[13]) << 16 | UInt32(bytes[14]) << 8 | UInt32(bytes[15]))
        }
        return bytes[0] & 0xfe == 0xfc || (bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80)
    }

    /// A host URL parsers read as an IPv4 address: its last label is all digits or 0x hex.
    private static func endsInNumber(_ host: String) -> Bool {
        let last = host.split(separator: ".", omittingEmptySubsequences: false).last ?? ""
        if !last.isEmpty, last.allSatisfy({ $0.isASCII && $0.isNumber }) { return true }
        return last.hasPrefix("0x") && last.dropFirst(2).allSatisfy { $0.isASCII && $0.isHexDigit }
    }

    /// ASCII digits of `radix` → their value; nil for anything else (no sign, no other digits) or on overflow.
    private static func number(_ text: Substring, radix: Int) -> UInt64? {
        guard !text.isEmpty, text.allSatisfy({ $0.isASCII && $0.hexDigitValue.map { $0 < radix } == true }) else { return nil }
        return UInt64(text, radix: radix)
    }

    /// The IPv4 forms URL parsers and inet_aton take (1 to 4 parts; decimal, 0x hex, 0-octal); nil when it is none.
    private static func ipv4(_ host: String) -> UInt32? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 4 else { return nil }
        var numbers: [UInt64] = []
        for part in parts {
            let value: UInt64?
            if part.hasPrefix("0x") {
                value = part.count == 2 ? 0 : number(part.dropFirst(2), radix: 16)
            } else if part.count > 1, part.hasPrefix("0") {
                value = number(part.dropFirst(), radix: 8)
            } else {
                value = number(part, radix: 10)
            }
            guard let value else { return nil }
            numbers.append(value)
        }
        let last = numbers.removeLast()
        guard numbers.allSatisfy({ $0 <= 255 }), last < UInt64(1) << UInt64(8 * (4 - numbers.count)) else { return nil }
        var address = last
        for (index, value) in numbers.enumerated() { address += value << UInt64(8 * (3 - index)) }
        return UInt32(address)
    }

    /// An IPv6 address (no zone) → 16 bytes; nil when it is none.
    private static func ipv6(_ text: String) -> [UInt8]? {
        let halves = text.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }
        // An embedded IPv4 address (::ffff:192.168.1.1) may only end the address.
        func words(_ half: String, last: Bool) -> [UInt16]? {
            if half.isEmpty { return [] }
            let pieces = half.split(separator: ":", omittingEmptySubsequences: false)
            var result: [UInt16] = []
            for (index, piece) in pieces.enumerated() {
                if last, index == pieces.count - 1, piece.contains(".") {
                    let octets = piece.split(separator: ".", omittingEmptySubsequences: false)
                    guard octets.count == 4 else { return nil }
                    var bytes: [UInt16] = []
                    for octet in octets {
                        guard (1...3).contains(octet.count), let value = number(octet, radix: 10), value <= 255 else { return nil }
                        bytes.append(UInt16(value))
                    }
                    result += [bytes[0] << 8 | bytes[1], bytes[2] << 8 | bytes[3]]
                } else {
                    guard (1...4).contains(piece.count), let value = number(piece, radix: 16) else { return nil }
                    result.append(UInt16(value))
                }
            }
            return result
        }
        guard let head = words(halves[0], last: halves.count == 1), let tail = halves.count == 2 ? words(halves[1], last: true) : [] else {
            return nil
        }
        let missing = 8 - head.count - tail.count
        guard halves.count == 2 ? missing >= 1 : missing == 0 else { return nil }
        return (head + Array(repeating: 0, count: missing) + tail).flatMap { [UInt8($0 >> 8), UInt8($0 & 0xff)] }
    }
}
