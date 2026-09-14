import test from 'node:test'
import assert from 'node:assert/strict'

import { hashBytes, headTailSig, HASH_RE, HASH_HEX_LENGTH, SIG_WINDOW_BYTES } from '../src/storage/hash.js'

const bytes = (...values) => new Uint8Array(values)

test('hashBytes is stable, hex, and the documented length', async () => {
  const h = await hashBytes(bytes(1, 2, 3, 4))
  assert.match(h, HASH_RE)
  assert.equal(h.length, HASH_HEX_LENGTH)
  assert.equal(h, await hashBytes(bytes(1, 2, 3, 4)), 'same bytes must hash the same')
})

test('hashBytes is byte-identical to the implementation it replaced in fontRegistry', () => {
  // Not a nicety. Every custom font a user has ever imported is stored under
  // `dalivid_font_<hash>` and referenced from saved projects as `custom:<hash>`.
  // Change this algorithm and every one of those becomes unresolvable — the
  // fonts are still on disk, and nothing can find them.
  //
  // The body below is the pre-move implementation, verbatim.
  const oldHashBuffer = async (buffer) => {
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    return [...new Uint8Array(digest).slice(0, 10)]
      .map(b => b.toString(16).padStart(2, '0')).join('')
  }

  const cases = [
    new Uint8Array(0),
    new Uint8Array([0, 1, 2]),
    new Uint8Array(4096).map((_, i) => (i * 31) & 255),
    new TextEncoder().encode('OTTO fake font bytes'),
  ]

  return Promise.all(cases.map(async (c) => {
    const asArrayBuffer = c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength)
    assert.equal(await hashBytes(c), await oldHashBuffer(asArrayBuffer),
      `font hash changed for a ${c.byteLength}-byte input`)
  }))
})

test('hashBytes separates different content and different lengths', async () => {
  const a = await hashBytes(bytes(1, 2, 3))
  const b = await hashBytes(bytes(1, 2, 4))
  const c = await hashBytes(bytes(1, 2, 3, 0))
  assert.notEqual(a, b)
  assert.notEqual(a, c)
})

test('hashBytes accepts ArrayBuffer and typed-array views alike', async () => {
  const buf = new Uint8Array([9, 8, 7, 6, 5]).buffer
  const fromBuffer = await hashBytes(buf)
  const fromView = await hashBytes(new Uint8Array(buf))
  assert.equal(fromBuffer, fromView)

  // A view onto part of a larger buffer must hash only its own window — the
  // subarray case is how `headTailSig` reads a range out of a plain buffer.
  const whole = new Uint8Array([0, 0, 1, 2, 3, 0, 0])
  assert.equal(await hashBytes(whole.subarray(2, 5)), await hashBytes(bytes(1, 2, 3)))
})

test('hashBytes rejects things that are not bytes', async () => {
  await assert.rejects(() => hashBytes('not bytes'), TypeError)
  await assert.rejects(() => hashBytes(null), TypeError)
})

test('headTailSig is stable and reads Blobs and buffers identically', async () => {
  const data = new Uint8Array(1024).map((_, i) => i & 0xff)
  const fromBytes = await headTailSig(data)
  const fromBlob = await headTailSig(new Blob([data]))
  assert.match(fromBytes, HASH_RE)
  assert.equal(fromBytes, fromBlob, 'the same file must sign the same however it is presented')
})

test('headTailSig distinguishes files that differ only at the end', async () => {
  // The case a head-only hash misses, and the reason both windows are read.
  const size = SIG_WINDOW_BYTES * 2 + 4096
  const a = new Uint8Array(size)
  const b = new Uint8Array(size)
  b[size - 1] = 1
  assert.notEqual(await headTailSig(a), await headTailSig(b))
})

test('headTailSig distinguishes files that differ only in the middle it never reads', async () => {
  // It does NOT, and that is the documented trade — the sig is drift detection,
  // not a content hash. Pinning the behaviour so nobody later assumes otherwise.
  const size = SIG_WINDOW_BYTES * 2 + 4096
  const a = new Uint8Array(size)
  const b = new Uint8Array(size)
  b[SIG_WINDOW_BYTES + 100] = 1
  assert.equal(await headTailSig(a), await headTailSig(b),
    'a change in the unread middle is invisible by design — see hash.js')
})

test('headTailSig folds size in, so a truncated copy differs', async () => {
  const a = new Uint8Array(SIG_WINDOW_BYTES * 2 + 8192)
  const b = a.subarray(0, SIG_WINDOW_BYTES * 2 + 4096)
  assert.notEqual(await headTailSig(a), await headTailSig(b))
})

test('headTailSig handles a file smaller than one window', async () => {
  const small = new Uint8Array([1, 2, 3])
  assert.match(await headTailSig(small), HASH_RE)
  assert.match(await headTailSig(new Uint8Array(0)), HASH_RE)
})

test('headTailSig rejects things that are not files', async () => {
  await assert.rejects(() => headTailSig('nope'), TypeError)
})
