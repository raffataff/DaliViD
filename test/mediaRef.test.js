import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createRef, refIdForHash, refKey, stripRefPath, hasLocalOnlyFields,
  isMediaRef, isRefId, isHash, kindFor,
  MEDIA_REF_ID_RE, LOCAL_ONLY_REF_FIELDS,
} from '../src/storage/mediaRef.js'

const HASH = 'a1b2c3d4e5f6a1b2c3d4'

const vaultRef = (over = {}) => createRef({
  hash: HASH, filename: 'beach.mp4', kind: 'video', mime: 'video/mp4', bytes: 1024, ...over,
})

test('a ref id is derived from the hash, so the same file dedups to one ref', () => {
  const a = vaultRef()
  const b = vaultRef({ filename: 'a-copy-with-another-name.mp4', addedAt: 1 })
  assert.equal(a.id, b.id, 'identity is the content, not the name')
  assert.equal(a.id, `mr_${HASH}`)
  assert.equal(a.id, refIdForHash(HASH))
  assert.match(a.id, MEDIA_REF_ID_RE)
})

test('refIdForHash refuses to mint an id from a non-hash', () => {
  // The id is what every boundary regex-checks, so a bad one must never exist
  // to be checked in the first place.
  for (const bad of ['../../x', '', 'ZZZZ', null, 'a'.repeat(40)]) {
    assert.throws(() => refIdForHash(bad), TypeError, `should reject: ${String(bad)}`)
  }
})

test('createRef rejects malformed input rather than producing a bad ref', () => {
  assert.throws(() => createRef({ hash: 'NOT HEX', filename: 'a.mp4', kind: 'video', bytes: 1 }), TypeError)
  assert.throws(() => createRef({ hash: HASH, filename: 'a.mp4', kind: 'font', bytes: 1 }), TypeError)
  assert.throws(() => createRef({ hash: HASH, filename: '', kind: 'video', bytes: 1 }), TypeError)
  assert.throws(() => createRef({ hash: HASH, filename: 'a.mp4', kind: 'video', bytes: -1 }), TypeError)
  assert.throws(() => createRef({ hash: HASH, filename: 'a.mp4', kind: 'video', bytes: NaN }), TypeError)
  assert.throws(() => createRef({ hash: HASH, filename: 'a.mp4', kind: 'video', bytes: 1, mode: 'wat' }), TypeError)
})

test('a vault ref may not carry a path, at all', () => {
  // A path on a vault ref is a path with no reason to exist — and the one place
  // it could leak from is the place it should never have been.
  assert.throws(
    () => createRef({ hash: HASH, filename: 'a.mp4', kind: 'video', bytes: 1, mode: 'vault', path: 'E:\\x.mp4' }),
    TypeError,
  )
  assert.equal(hasLocalOnlyFields(vaultRef()), false)
})

test('a link ref carries its local-only fields, and stripRefPath removes every one', () => {
  const ref = createRef({
    hash: HASH, filename: 'beach.mp4', kind: 'video', bytes: 1024, mode: 'link',
    path: 'E:\\Footage\\beach.mp4', mtimeMs: 123, sig: 'deadbeefdeadbeefdead',
  })
  assert.equal(hasLocalOnlyFields(ref), true)

  const stripped = stripRefPath(ref)
  for (const f of LOCAL_ONLY_REF_FIELDS) {
    assert.equal(stripped[f], undefined, `${f} must not survive stripRefPath`)
  }
  assert.equal(hasLocalOnlyFields(stripped), false)
  assert.notEqual(stripped, ref, 'stripRefPath must copy, never mutate its input')
  assert.equal(ref.path, 'E:\\Footage\\beach.mp4', 'the original is untouched')

  // Everything that is not a path survives — a stripped ref is still a usable ref.
  assert.equal(stripped.id, ref.id)
  assert.equal(stripped.mode, 'link')
  assert.equal(stripped.filename, 'beach.mp4')
  assert.ok(isMediaRef(stripped))
})

test('isRefId refuses traversal- and injection-shaped ids', () => {
  assert.ok(isRefId(`mr_${HASH}`))
  for (const bad of [
    'mr_../../../etc/passwd', 'mr_..', '../mr_abcd', 'mr_', 'mr_ABCD',
    'mr_abcd/../x', 'mr_abcd\u0000', 'MR_abcd', 'abcd', '', null, undefined, 42,
    `mr_${'a'.repeat(33)}`, 'mr_ab',
  ]) {
    assert.equal(isRefId(bad), false, `must reject: ${String(bad)}`)
  }
})

test('isMediaRef requires the id and the hash to agree', () => {
  assert.ok(isMediaRef(vaultRef()))
  assert.equal(isMediaRef({ ...vaultRef(), id: 'mr_ffffffffffffffffffff' }), false,
    'an id that does not match its hash is not a ref')
  assert.equal(isMediaRef({ ...vaultRef(), kind: 'font' }), false)
  assert.equal(isMediaRef({ ...vaultRef(), bytes: 'big' }), false)
  assert.equal(isMediaRef(null), false)
  assert.equal(isMediaRef([]), false)
})

test('refKey accepts a ref or a bare id and rejects anything else', () => {
  assert.equal(refKey(vaultRef()), `mr_${HASH}`)
  assert.equal(refKey(`mr_${HASH}`), `mr_${HASH}`)
  assert.throws(() => refKey('mr_../x'), TypeError)
  assert.throws(() => refKey({}), TypeError)
})

test('isHash matches both the SHA and the non-secure-context fallback shape', () => {
  assert.ok(isHash(HASH))
  assert.ok(isHash('f1a2b3c4d5e6'), 'FNV fallback: "f" + hex')
  assert.equal(isHash('xyz'), false)
})

test('kindFor prefers the MIME type and falls back to the extension', () => {
  assert.equal(kindFor('video/mp4', 'whatever.txt'), 'video')
  assert.equal(kindFor('', 'clip.MOV'), 'video')
  assert.equal(kindFor('', 'song.flac'), 'audio')
  assert.equal(kindFor('image/png', ''), 'image')
  assert.equal(kindFor('', 'notes.txt'), null)
  assert.equal(kindFor('', 'noextension'), null)
})
