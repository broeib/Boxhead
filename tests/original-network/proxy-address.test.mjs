import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoteAddressResolver } from '../../apps/original-server/telemetry.mjs';
import { parseArguments } from '../../apps/original-server/index.mjs';

const request = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded } });

test('direct connections ignore forged forwarding headers by default and outside the allowlist', () => {
  assert.equal(createRemoteAddressResolver()(request('192.0.2.4', '198.51.100.8')), '192.0.2.4');
  assert.equal(createRemoteAddressResolver(['192.0.2.1'])(request('192.0.2.4', '198.51.100.8')), '192.0.2.4');
});

test('only a trusted proxy may supply a client IP, and spoofed prefixes are ignored', () => {
  const resolve = createRemoteAddressResolver(['192.0.2.1']);
  assert.equal(resolve(request('::ffff:192.0.2.1', '198.51.100.8')), '198.51.100.8');
  assert.equal(resolve(request('192.0.2.1', '203.0.113.99, 198.51.100.8')), '198.51.100.8');
  assert.equal(resolve(request('192.0.2.1', 'malformed, 198.51.100.8')), '198.51.100.8');
});

test('trusted chains stop at the first untrusted hop and accept IPv6 clients', () => {
  const resolve = createRemoteAddressResolver(['192.0.2.1', '192.0.2.2']);
  assert.equal(resolve(request('192.0.2.1', '203.0.113.9, 198.51.100.8, 192.0.2.2')), '198.51.100.8');
  assert.equal(resolve(request('192.0.2.1', '2001:db8::5, 192.0.2.2')), '2001:db8::5');
});

test('missing or malformed trusted forwarding falls back to the transport IP', () => {
  const resolve = createRemoteAddressResolver(['192.0.2.1']);
  for (const header of [undefined, ['198.51.100.8'], '', 'hostname', '198.51.100.8:80', '198.51.100.8, ']) {
    assert.equal(resolve(request('192.0.2.1', header)), '192.0.2.1');
  }
});

test('proxy trust is explicit, bounded and validated in both CLI and environment', () => {
  assert.deepEqual(parseArguments(['--trusted-proxy-ips', '192.0.2.1, 2001:db8::1'], {}).trustedProxyIPs, ['192.0.2.1', '2001:db8::1']);
  assert.deepEqual(parseArguments([], { TRUSTED_PROXY_IPS: '' }).trustedProxyIPs, []);
  for (const value of ['*', 'true', '192.0.2.0/24', '192.0.2.1,', 'hostname']) {
    assert.throws(() => parseArguments([], { TRUSTED_PROXY_IPS: value }));
  }
  for (const value of [true, '192.0.2.1', ['hostname'], Array(33).fill('192.0.2.1')]) {
    assert.throws(() => createRemoteAddressResolver(value));
  }
});
