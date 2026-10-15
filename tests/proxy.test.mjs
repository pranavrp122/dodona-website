import test from 'node:test';
import assert from 'node:assert/strict';
import { createClientAddressResolver } from '../lib/proxy.mjs';
const request = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': forwarded } });

test('untrusted peers cannot use forwarded headers to choose their rate-limit identity', () => {
  const address = createClientAddressResolver('127.0.0.1/32');
  assert.equal(address(request('198.51.100.1', '203.0.113.9')), '198.51.100.1');
});
test('a trusted proxy separates visitors and stops at the first untrusted hop', () => {
  const address = createClientAddressResolver('127.0.0.1/32,10.1.0.0/24');
  assert.equal(address(request('127.0.0.1', '203.0.113.9,198.51.100.1,10.1.0.2')), '198.51.100.1');
  assert.equal(address(request('127.0.0.1', '198.51.100.2')), '198.51.100.2');
});
test('malformed and oversized forwarding chains fail closed', () => {
  const address = createClientAddressResolver('127.0.0.1');
  assert.equal(address(request('127.0.0.1', 'not-an-address')), '127.0.0.1');
  assert.equal(address(request('127.0.0.1', Array(17).fill('198.51.100.2').join(','))), '127.0.0.1');
});
test('equivalent IPv4-mapped and IPv6 identities normalize consistently', () => {
  const address = createClientAddressResolver('::1/128');
  assert.equal(address(request('::ffff:192.0.2.1')), '192.0.2.1');
  assert.equal(address(request('::1', '2001:0db8:0:0:0:0:0:1')), '2001:db8::1');
});
test('trust settings reject all-network wildcards and invalid subnets', () => {
  for (const value of ['*', '0.0.0.0/0', '::/0', '127.0.0.1/33', '::1/129', '127.0.0.1/x', '127.0.0.1/32/extra']) assert.throws(() => createClientAddressResolver(value));
});
