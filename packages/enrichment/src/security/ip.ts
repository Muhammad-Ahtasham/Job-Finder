import { BlockList, isIP } from 'node:net';

/**
 * Everything that is not a globally routable unicast address. Anything on these lists is
 * refused by the crawler no matter how the name resolved: loopback, RFC 1918, link-local
 * (which contains the 169.254.169.254 cloud metadata endpoint), CGNAT (Alibaba's
 * 100.100.100.200), unique-local IPv6 (AWS's fd00:ec2::254), multicast and reserved space.
 */
const blocked = new BlockList();
const V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT (+ Alibaba metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (+ cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // RFC 1918
  ['192.0.0.0', 24], // IETF protocol assignments (+ Oracle metadata 192.0.0.192)
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];
for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, 'ipv4');

const V6: [string, number][] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF assignments incl. Teredo + ORCHID
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds arbitrary IPv4)
  ['fc00::', 7], // unique local (AWS metadata fd00:ec2::254)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, 'ipv6');

/** Parse an IPv6 literal into eight 16-bit groups, or undefined if it is malformed. */
function parseIpv6(input: string): number[] | undefined {
  let address = input.toLowerCase();
  const zone = address.indexOf('%');
  if (zone >= 0) address = address.slice(0, zone);

  // Embedded dotted quad ("::ffff:1.2.3.4") → two hex groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const octets = dotted[2]!.split('.').map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return undefined;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    address = `${dotted[1]}${hi}:${lo}`;
  }

  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return undefined;
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return numbers.some(Number.isNaN) ? undefined : numbers;
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * True when the address may be connected to. Fails CLOSED: anything that does not parse as
 * an IP is "not public". IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::/96) addresses are
 * unwrapped and judged by the IPv4 address they embed, so `::ffff:127.0.0.1` cannot sneak by.
 */
export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family !== 6) return false;

  const groups = parseIpv6(address);
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const upperZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // ::/96 (unspecified, loopback, deprecated IPv4-compatible) is never a real destination.
  if (upperZero && g5 === 0) return false;
  // ::ffff:a.b.c.d (IPv4-mapped): judged by the embedded IPv4 address.
  if (upperZero && g5 === 0xffff) return !blocked.check(v4FromGroups(g6, g7), 'ipv4');
  // 64:ff9b::/96 well-known NAT64 prefix
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return !blocked.check(v4FromGroups(g6, g7), 'ipv4');
  }
  const canonical = groups.map((g) => g.toString(16)).join(':');
  return !blocked.check(canonical, 'ipv6');
}
