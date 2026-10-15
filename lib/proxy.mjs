import { BlockList, isIP } from 'node:net';

function normalizeAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return null;
  const value = address.trim().toLowerCase();
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) return value.slice(7);
  const version = isIP(value);
  if (!version) return null;
  return version === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}

export function createClientAddressResolver(cidrs = '') {
  const trusted = new BlockList();
  for (const cidr of cidrs.split(',').map(value => value.trim()).filter(Boolean)) {
    const [rawAddress, rawPrefix, extra] = cidr.split('/');
    const address = normalizeAddress(rawAddress);
    const version = address && isIP(address);
    const prefix = rawPrefix === undefined ? (version === 4 ? 32 : 128) : Number(rawPrefix);
    if (!address || extra || (rawPrefix !== undefined && !/^\d+$/.test(rawPrefix)) || !Number.isInteger(prefix) || prefix <= 0 || prefix > (version === 4 ? 32 : 128)) {
      throw new Error('TRUSTED_PROXY_CIDRS must contain explicit IPv4 or IPv6 proxy networks.');
    }
    trusted.addSubnet(address, prefix, version === 4 ? 'ipv4' : 'ipv6');
  }
  const isTrusted = address => trusted.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6');
  return request => {
    const peer = normalizeAddress(request.socket.remoteAddress);
    if (!peer) throw new Error('Unknown connection address.');
    if (!isTrusted(peer)) return peer;
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded !== 'string') return peer;
    const chain = forwarded.split(',').map(normalizeAddress);
    // Walk from the socket toward the first untrusted hop. Client-added headers
    // to its left cannot replace that hop. Invalid chains fail closed to the peer.
    if (chain.length > 16 || chain.some(address => !address)) return peer;
    let address = peer;
    for (let i = chain.length - 1; i >= 0 && isTrusted(address); i--) address = chain[i];
    return address;
  };
}
