import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { tickStamp } from '../src/apps/sockets/stamp.ts'

// biquote stamps a tick with WHOLE seconds (`2026-11-04T20:40:19Z`), and coins
// drops any tick whose timestamp is not strictly greater than the previous one
// for that symbol. The stamp we publish must therefore be finer than the
// vendor's, never claim a tick is fresher than it is, and always move forward.

const SEC = Date.parse('2026-11-06T09:30:00Z')

test('a fresh tick takes its arrival time — inside the vendor second', () => {
  assert.equal(tickStamp(SEC, SEC + 240, undefined), SEC + 240)
})

test('a late tick is pinned to the end of its own second, so its age stays visible', () => {
  // arrived 10 s after the second it was stamped with
  assert.equal(tickStamp(SEC, SEC + 10_240, undefined), SEC + 999)
})

test('a vendor clock running ahead of ours never yields a future stamp', () => {
  assert.equal(tickStamp(SEC + 5_000, SEC + 100, undefined), SEC + 100)
})

test('two ticks in one millisecond still move forward', () => {
  const first = tickStamp(SEC, SEC + 300, undefined)
  const second = tickStamp(SEC, SEC + 300, first)
  assert.equal(second, first + 1)
})

test('late ticks of one second keep moving forward past the pin', () => {
  const a = tickStamp(SEC, SEC + 9_000, undefined)
  const b = tickStamp(SEC, SEC + 9_001, a)
  const c = tickStamp(SEC, SEC + 9_002, b)
  assert.deepEqual([a, b, c], [SEC + 999, SEC + 1_000, SEC + 1_001])
})

test('a sub-second vendor stamp is floored to its second first', () => {
  assert.equal(tickStamp(SEC + 500, SEC + 20_000, undefined), SEC + 999)
})
