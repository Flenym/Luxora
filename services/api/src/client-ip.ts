import { isIP } from "node:net";

const INVALID_CLIENT_IP_BUCKET = "ip:unresolved";
const INVALID_ANONYMOUS_PASSKEY_BUCKET = "passkey-login:v1:ip:unresolved";
const MAX_TRUSTED_PROXY_CIDRS = 32;
const MAX_TRUSTED_PROXY_CONFIG_BYTES = 4_096;

function canonicalIpv6(address: string): string | null {
  const scopeStart = address.indexOf("%");
  const withoutScope = scopeStart === -1 ? address : address.slice(0, scopeStart);
  try {
    const hostname = new URL(`http://[${withoutScope}]/`).hostname;
    if (!hostname.startsWith("[") || !hostname.endsWith("]")) return null;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

function mappedIpv4Address(canonicalIpv6Address: string): string | null {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(canonicalIpv6Address);
  if (match === null) return null;
  const high = Number.parseInt(match[1] as string, 16);
  const low = Number.parseInt(match[2] as string, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
}

function ipv6Prefix64(canonicalIpv6Address: string): string | null {
  const halves = canonicalIpv6Address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : (halves[0] as string).split(":");
  const right = halves.length === 1 || halves[1] === ""
    ? []
    : (halves[1] as string).split(":");
  const omitted = 8 - left.length - right.length;
  if (
    (halves.length === 1 && omitted !== 0)
    || (halves.length === 2 && omitted < 1)
  ) return null;
  const expanded = [
    ...left,
    ...Array.from({ length: omitted }, () => "0"),
    ...right
  ];
  if (expanded.length !== 8) return null;
  const words: string[] = [];
  for (const word of expanded) {
    if (!/^[0-9a-f]{1,4}$/u.test(word)) return null;
    words.push(word.padStart(4, "0"));
  }
  return words.slice(0, 4).join(":");
}

/**
 * Returns one bounded canonical key for HTTP and realtime abuse guards. Invalid
 * forwarded values deliberately collapse into one fail-closed bucket and are
 * never copied into an attacker-selected map key.
 */
export function clientIpBucketKey(untrustedAddress: unknown): string {
  if (typeof untrustedAddress !== "string") return INVALID_CLIENT_IP_BUCKET;
  const address = untrustedAddress.trim();
  const family = isIP(address);
  if (family === 4) {
    const canonical = address.split(".").map((octet) => Number.parseInt(octet, 10)).join(".");
    return `ipv4:${canonical}`;
  }
  if (family !== 6) return INVALID_CLIENT_IP_BUCKET;
  const canonical = canonicalIpv6(address);
  if (canonical === null) return INVALID_CLIENT_IP_BUCKET;
  const mapped = mappedIpv4Address(canonical);
  return mapped === null ? `ipv6:${canonical}` : `ipv4:${mapped}`;
}

/**
 * Coarser, domain-separated admission key for anonymous passkey login. A
 * single IPv6 subscriber commonly controls many addresses in one /64, so
 * exact-address limiting would let that subscriber create durable intents by
 * rotating the low 64 bits. IPv4 remains exact until a deployment-specific
 * aggregation policy has independent false-positive evidence.
 *
 * `request.ip` is still resolved by Fastify's explicit trust-proxy policy
 * before reaching this function. Invalid inputs collapse into one bounded key
 * and attacker-controlled text is never retained.
 */
export function anonymousPasskeyIpBucketKey(untrustedAddress: unknown): string {
  const exact = clientIpBucketKey(untrustedAddress);
  if (exact === INVALID_CLIENT_IP_BUCKET) return INVALID_ANONYMOUS_PASSKEY_BUCKET;
  if (exact.startsWith("ipv4:")) return `passkey-login:v1:${exact}`;
  if (!exact.startsWith("ipv6:")) return INVALID_ANONYMOUS_PASSKEY_BUCKET;
  const prefix = ipv6Prefix64(exact.slice("ipv6:".length));
  return prefix === null
    ? INVALID_ANONYMOUS_PASSKEY_BUCKET
    : `passkey-login:v1:ipv6-64:${prefix}`;
}

/** Parse an explicit Fastify trustProxy allowlist. Catch-all and hop-count trust
 * are intentionally unsupported because deployment paths can have different
 * lengths and untrusted forwarding headers must never choose an abuse bucket.
 */
export function parseTrustedProxyCidrs(rawValue: string): readonly string[] {
  if (Buffer.byteLength(rawValue, "utf8") > MAX_TRUSTED_PROXY_CONFIG_BYTES) {
    throw new Error("TRUSTED_PROXY_CIDRS exceeds its configuration bound");
  }
  if (rawValue === "") return Object.freeze([]);
  const rawEntries = rawValue.split(",");
  if (rawEntries.length > MAX_TRUSTED_PROXY_CIDRS) {
    throw new Error("TRUSTED_PROXY_CIDRS contains too many entries");
  }
  const normalized: string[] = [];
  for (const rawEntry of rawEntries) {
    const entry = rawEntry.trim();
    const slash = entry.indexOf("/");
    if (slash <= 0 || slash !== entry.lastIndexOf("/")) {
      throw new Error("TRUSTED_PROXY_CIDRS entries must be explicit IP/CIDR values");
    }
    const address = entry.slice(0, slash);
    const prefixText = entry.slice(slash + 1);
    if (address.includes("%") || !/^(?:0|[1-9]\d*)$/u.test(prefixText)) {
      throw new Error("TRUSTED_PROXY_CIDRS contains an invalid IP/CIDR value");
    }
    const family = isIP(address);
    const prefix = Number.parseInt(prefixText, 10);
    const maximumPrefix = family === 4 ? 32 : family === 6 ? 128 : 0;
    if (family === 0 || prefix < 1 || prefix > maximumPrefix) {
      throw new Error("TRUSTED_PROXY_CIDRS contains an invalid IP/CIDR value");
    }
    const bucketKey = clientIpBucketKey(address);
    if (bucketKey === INVALID_CLIENT_IP_BUCKET || (family === 6 && bucketKey.startsWith("ipv4:"))) {
      throw new Error("TRUSTED_PROXY_CIDRS must use canonical IPv4 notation for IPv4-mapped addresses");
    }
    const canonicalAddress = bucketKey.slice("ipv4:".length);
    const cidr = `${canonicalAddress}/${prefix}`;
    if (normalized.includes(cidr)) {
      throw new Error("TRUSTED_PROXY_CIDRS entries must be unique after normalization");
    }
    normalized.push(cidr);
  }
  return Object.freeze(normalized);
}
