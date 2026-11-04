import test from 'node:test';
import assert from 'node:assert/strict';
import { ipGroup } from '../src/util.js';

test('PIN limit key: IPv6 grouped by /64 however it is written, IPv4 as is', () => {
  assert.equal(ipGroup('2001:db8::5:1'), ipGroup('2001:db8::6:1')); // same /64, "::" lands in a different place
  assert.equal(ipGroup('2001:db8::5:1'), '2001:db8:0:0::/64');
  assert.equal(ipGroup('2001:db8:0:0:1:2:3:4'), '2001:db8:0:0::/64');
  assert.equal(ipGroup('2001:0DB8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.notEqual(ipGroup('2001:db8:1:2::1'), ipGroup('2001:db8:1:3::1'));
  assert.equal(ipGroup('203.0.113.9'), '203.0.113.9');
  assert.equal(ipGroup(null), 'unknown');
});
