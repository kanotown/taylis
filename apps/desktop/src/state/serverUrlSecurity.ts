/**
 * M190 (SECURITY.md §6.1): whether a server URL is https, plain HTTP to a server off the internet (a LAN, this
 * computer, a Tailscale address), or plain HTTP across the internet. Only the last asks for a confirmation before the
 * app first contacts the server (sign in, Google sign-in, an invite link). The cases: apps/shared/server-url-security.json.
 */

export type ServerUrlSecurity = "secure" | "local" | "insecure";

/** A normalized server URL (or an invite link's server) → its class; an http URL that cannot be read is insecure. */
export function classifyServerUrl(url: string): ServerUrlSecurity {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return /^\s*https:/i.test(url) ? "secure" : "insecure";
  }
  if (parsed.protocol === "https:") return "secure";
  return classifyServerHost(parsed.hostname);
}

/** The same URL with https: the action 「https で接続」. */
export function httpsVariant(url: string): string {
  return url.trim().replace(/^http:/i, "https:");
}

const LOCAL_SUFFIXES = ["localhost", "local", "lan", "home.arpa", "internal"];

/** The host of an http URL (brackets, an IPv6 zone, upper case and a trailing dot allowed). */
export function classifyServerHost(input: string): ServerUrlSecurity {
  let host = input.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.includes(":")) {
    const zone = host.indexOf("%");
    const bytes = parseIpv6(zone >= 0 ? host.slice(0, zone) : host);
    return bytes && isLocalIpv6(bytes) ? "local" : "insecure";
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return "insecure";
  if (endsInNumber(host)) {
    const address = parseIpv4(host);
    return address !== null && isLocalIpv4(address) ? "local" : "insecure";
  }
  if (!host.includes(".")) return "local"; // a single-label name: the LAN's own DNS or the hosts file
  return LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ? "local" : "insecure";
}

/** 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 and 100.64/10 (carrier-grade NAT, Tailscale). */
function isLocalIpv4(address: number): boolean {
  const a = address >>> 24;
  const b = (address >>> 16) & 0xff;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

/** ::1, fc00::/7, fe80::/10, and an IPv4-mapped address (::ffff:a.b.c.d) by its IPv4 address. */
function isLocalIpv6(bytes: number[]): boolean {
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return true;
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isLocalIpv4(((bytes[12]! << 24) | (bytes[13]! << 16) | (bytes[14]! << 8) | bytes[15]!) >>> 0);
  }
  return (bytes[0]! & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80);
}

/** A host URL parsers read as an IPv4 address: its last label is all digits or 0x hex. */
function endsInNumber(host: string): boolean {
  const last = host.slice(host.lastIndexOf(".") + 1);
  return /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last);
}

/** The IPv4 forms URL parsers and inet_aton take (1 to 4 parts; decimal, 0x hex, 0-octal); null when it is none. */
function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0x[0-9a-f]*$/.test(part)) value = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = parseInt(part.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(part)) value = Number(part);
    else return null;
    if (!Number.isFinite(value)) return null;
    numbers.push(value);
  }
  const last = numbers.pop()!;
  if (numbers.some((n) => n > 255) || last >= 256 ** (4 - numbers.length)) return null;
  return numbers.reduce((sum, n, index) => sum + n * 256 ** (3 - index), 0) + last;
}

/** An IPv6 address (no zone) → 16 bytes; null when it is none. */
function parseIpv6(text: string): number[] | null {
  const halves = text.split("::");
  if (halves.length > 2) return null;
  // An embedded IPv4 address (::ffff:192.168.1.1) may only end the address.
  const groups = (half: string, last: boolean): number[] | null => {
    if (half === "") return [];
    const words: number[] = [];
    const pieces = half.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!;
      if (last && i === pieces.length - 1 && piece.includes(".")) {
        const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(piece);
        if (!v4) return null;
        const octets = v4.slice(1).map(Number);
        if (octets.some((n) => n > 255)) return null;
        words.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else if (/^[0-9a-f]{1,4}$/.test(piece)) {
        words.push(parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return words;
  };
  const head = groups(halves[0]!, halves.length === 1);
  const tail = halves.length === 2 ? groups(halves[1]!, true) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const words = [...head, ...Array<number>(missing).fill(0), ...tail];
  return words.flatMap((word) => [word >> 8, word & 0xff]);
}
