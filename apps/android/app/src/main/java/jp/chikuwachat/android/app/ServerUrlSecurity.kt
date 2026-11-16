package jp.chikuwachat.android.app

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * M190 (SECURITY.md §6.1): whether a server URL is https, plain HTTP to a server off the internet (a LAN, this device,
 * a Tailscale address), or plain HTTP across the internet. Only the last asks for a confirmation before the app first
 * contacts the server (sign in, Google sign-in, an invite link). The cases: apps/shared/server-url-security.json, as the
 * desktop's serverUrlSecurity.ts and iOS's ServerUrlSecurity.swift read them.
 */
enum class ServerUrlSecurity {
    SECURE, LOCAL, INSECURE;

    companion object {
        private val LOCAL_SUFFIXES = listOf("localhost", "local", "lan", "home.arpa", "internal")

        /** A normalized server URL (or an invite link's server) → its class; an http URL that cannot be read is insecure. */
        fun classify(url: String): ServerUrlSecurity {
            val text = url.trim()
            val parsed = text.toHttpUrlOrNull() ?: return if (text.startsWith("https:", ignoreCase = true)) SECURE else INSECURE
            return if (parsed.isHttps) SECURE else classifyHost(parsed.host)
        }

        /** The same URL with https: the action 「https で接続」. */
        fun https(url: String): String {
            val text = url.trim()
            return if (text.startsWith("http:", ignoreCase = true)) "https:" + text.substring(5) else text
        }

        /** The host of an http URL (brackets, an IPv6 zone, upper case and a trailing dot allowed). */
        fun classifyHost(input: String): ServerUrlSecurity {
            var host = input.trim().lowercase()
            if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length - 1)
            if (':' in host) {
                val bytes = ipv6(host.substringBefore('%')) ?: return INSECURE
                return if (isLocalIpv6(bytes)) LOCAL else INSECURE
            }
            host = host.removeSuffix(".")
            if (host.isEmpty()) return INSECURE
            if (endsInNumber(host)) {
                val address = ipv4(host) ?: return INSECURE
                return if (isLocalIpv4(address)) LOCAL else INSECURE
            }
            if ('.' !in host) return LOCAL // a single-label name: the LAN's own DNS or the hosts file
            return if (LOCAL_SUFFIXES.any { host == it || host.endsWith(".$it") }) LOCAL else INSECURE
        }

        /** 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 and 100.64/10 (carrier-grade NAT, Tailscale). */
        private fun isLocalIpv4(address: Long): Boolean {
            val a = (address shr 24).toInt()
            val b = ((address shr 16) and 0xff).toInt()
            return a == 127 || a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168) || (a == 169 && b == 254) || (a == 100 && b in 64..127)
        }

        /** ::1, fc00::/7, fe80::/10, and an IPv4-mapped address (::ffff:a.b.c.d) by its IPv4 address. */
        private fun isLocalIpv6(bytes: IntArray): Boolean {
            if ((0 until 15).all { bytes[it] == 0 } && bytes[15] == 1) return true
            if ((0 until 10).all { bytes[it] == 0 } && bytes[10] == 0xff && bytes[11] == 0xff) {
                return isLocalIpv4((bytes[12].toLong() shl 24) or (bytes[13].toLong() shl 16) or (bytes[14].toLong() shl 8) or bytes[15].toLong())
            }
            return (bytes[0] and 0xfe) == 0xfc || (bytes[0] == 0xfe && (bytes[1] and 0xc0) == 0x80)
        }

        /** A host URL parsers read as an IPv4 address: its last label is all digits or 0x hex. */
        private fun endsInNumber(host: String): Boolean {
            val last = host.substringAfterLast('.')
            return (last.isNotEmpty() && last.all { it in '0'..'9' }) || (last.startsWith("0x") && last.drop(2).all { isHex(it) })
        }

        private fun isHex(c: Char) = c in '0'..'9' || c in 'a'..'f' || c in 'A'..'F'

        /** ASCII digits of [radix] → their value; null for anything else (no sign, no other digits) or on overflow. */
        private fun number(text: String, radix: Int): Long? {
            if (text.isEmpty() || !text.all { isHex(it) && Character.digit(it, radix) >= 0 }) return null
            return text.toLongOrNull(radix)?.takeIf { it >= 0 }
        }

        /** The IPv4 forms URL parsers and inet_aton take (1 to 4 parts; decimal, 0x hex, 0-octal); null when it is none. */
        private fun ipv4(host: String): Long? {
            val parts = host.split('.')
            if (parts.size > 4) return null
            val numbers = parts.map { part ->
                when {
                    part.startsWith("0x") -> if (part.length == 2) 0L else number(part.substring(2), 16)
                    part.length > 1 && part.startsWith("0") -> number(part.substring(1), 8)
                    else -> number(part, 10)
                } ?: return null
            }
            val last = numbers.last()
            val leading = numbers.dropLast(1)
            if (leading.any { it > 255 } || last >= 1L shl (8 * (4 - leading.size))) return null
            return leading.foldIndexed(last) { index, sum, value -> sum + (value shl (8 * (3 - index))) }
        }

        /** An IPv6 address (no zone) → 16 bytes; null when it is none. */
        private fun ipv6(text: String): IntArray? {
            val halves = text.split("::")
            if (halves.size > 2) return null
            // An embedded IPv4 address (::ffff:192.168.1.1) may only end the address.
            fun words(half: String, last: Boolean): List<Int>? {
                if (half.isEmpty()) return emptyList()
                val pieces = half.split(':')
                val result = mutableListOf<Int>()
                for ((index, piece) in pieces.withIndex()) {
                    if (last && index == pieces.lastIndex && '.' in piece) {
                        val octets = piece.split('.')
                        if (octets.size != 4) return null
                        val bytes = octets.map { octet -> number(octet, 10)?.takeIf { octet.length in 1..3 && it <= 255 }?.toInt() ?: return null }
                        result += (bytes[0] shl 8) or bytes[1]
                        result += (bytes[2] shl 8) or bytes[3]
                    } else {
                        if (piece.length !in 1..4) return null
                        result += number(piece, 16)?.toInt() ?: return null
                    }
                }
                return result
            }
            val head = words(halves[0], last = halves.size == 1) ?: return null
            val tail = if (halves.size == 2) words(halves[1], last = true) ?: return null else emptyList()
            val missing = 8 - head.size - tail.size
            if (if (halves.size == 2) missing < 1 else missing != 0) return null
            val all = head + List(missing) { 0 } + tail
            return IntArray(16) { if (it % 2 == 0) all[it / 2] shr 8 else all[it / 2] and 0xff }
        }
    }
}
