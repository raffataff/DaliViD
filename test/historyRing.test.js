import test from 'node:test'
import assert from 'node:assert/strict'

import { ringSlots, ringCount } from '../src/gl/historyRing.js'

test('a 2-slot ring is exactly the existing ping-pong', () => {
  // Two slots means "read what I wrote last frame" — the ping-pong's contract.
  for (let t = 0; t < 4; t++) {
    const { read, write, last } = ringSlots(t, 2)
    assert.equal(write, t % 2)
    assert.equal(read, (t + 1) % 2, 'read is the other slot')
    assert.notEqual(read, write, 'never read and write the same slot')
    assert.equal(last, read, 'with 2 slots the delayed frame IS the most recent one')
  }
})

test('slot relationships hold for every tick of a 4-slot ring', () => {
  for (let t = -8; t < 20; t++) {
    const { read, write, last } = ringSlots(t, 4)
    assert.ok(write >= 0 && write < 4, `write ${write} in range`)
    assert.equal(read, (write + 1) % 4)
    assert.equal(last, (write + 3) % 4)
    assert.notEqual(read, write)
  }
})

test('a 4-slot ring reads the frame written 3 ticks earlier', () => {
  // Simulate the executor: write a marker into the write slot each tick, then
  // check the slot we read on that same tick holds the marker from 3 ticks ago.
  const slots = new Array(4).fill(null)
  for (let t = 0; t < 12; t++) {
    const { read, write } = ringSlots(t, 4)
    const wasRead = slots[read]
    slots[write] = t
    if (t >= 3) assert.equal(wasRead, t - 3, `tick ${t} must read tick ${t - 3}`)
  }
})

test('a 6-slot ring reads the frame written 5 ticks earlier', () => {
  // The delay the Playwright harness exercises (Delay 5 → 6 slots).
  const slots = new Array(6).fill(null)
  for (let t = 0; t < 20; t++) {
    const { read, write } = ringSlots(t, 6)
    const wasRead = slots[read]
    slots[write] = t
    if (t >= 5) assert.equal(wasRead, t - 5, `tick ${t} must read tick ${t - 5}`)
  }
})

test('ringSlots never returns fewer than 2 distinct slots', () => {
  for (const bad of [0, 1, -3, NaN]) {
    const { read, write } = ringSlots(0, bad)
    assert.notEqual(read, write, `count ${bad} must still give a usable pair`)
  }
})

test('ringCount turns a delay into slots, clamped by the memory budget', () => {
  // 1080p RGBA16F = 1920*1080*8 ≈ 16.6 MB/frame; 512 MiB buys 32 slots, so the
  // whole 1–30 range fits and the count is simply delay + 1.
  assert.equal(ringCount(1, 1920, 1080), 2)
  assert.equal(ringCount(12, 1920, 1080), 13)
  assert.equal(ringCount(30, 1920, 1080), 31)

  // 4K RGBA16F ≈ 66.4 MB/frame; 512 MiB buys 8 slots, so Delay 30 is capped.
  assert.equal(ringCount(30, 3840, 2160), 8)
  // Half res at 4K is back under the cap.
  assert.equal(ringCount(30, 1920, 1080), 31)
})

test('ringCount clamps the delay itself to 1–30', () => {
  assert.equal(ringCount(99, 1920, 1080), 31, 'above 30 clamps to 30 frames')
  assert.equal(ringCount(0, 1920, 1080), 2, 'zero / missing means no delay')
  assert.equal(ringCount(-5, 1920, 1080), 2)
  assert.equal(ringCount(undefined, 1920, 1080), 2)
  assert.equal(ringCount(4.4, 1920, 1080), 5, 'a fractional slider value rounds down to 4 frames')
  assert.equal(ringCount(4.6, 1920, 1080), 6, 'and up to 5 frames')
})

test('ringCount always leaves at least a ping-pong, however small the budget', () => {
  assert.equal(ringCount(30, 3840, 2160, 8, 1), 2)
  assert.equal(ringCount(30, 1, 1, 8, 0), 2)
})
