import test from 'node:test'
import assert from 'node:assert/strict'

import {
  validateProject, migrateV1toV2, collectInlineImages, replaceInlineImages,
  forEachNode, mapNodes, SCHEMA_VERSION, LIMITS,
} from '../src/storage/schema.js'
import { createRef, stripRefPath } from '../src/storage/mediaRef.js'
import { makeV1Project, IMG_A, IMG_B } from './fixtures/v1Project.js'

const HASH_A = 'aaaaaaaaaaaaaaaaaaaa'
const HASH_B = 'bbbbbbbbbbbbbbbbbbbb'

const ref = (hash, over = {}) => createRef({
  hash, filename: 'beach.mp4', kind: 'video', mime: 'video/mp4', bytes: 10, ...over,
})

/** Assert a document validates cleanly, printing the errors when it doesn't. */
function assertValid(doc, opts) {
  const r = validateProject(doc, opts)
  assert.ok(r.ok, `expected valid, got errors:\n  ${r.errors.join('\n  ')}`)
  return r
}

// ─── the headline: a real v1 project round-trips ────────────────────────────

test('the v1 fixture validates as-is', () => {
  const r = assertValid(makeV1Project())
  // A legacy TIME node must not even warn — migration is about to rewrite it,
  // and warning on it would train everyone to ignore warnings.
  assert.equal(r.warnings.filter(w => w.includes('TIME')).length, 0, r.warnings.join('\n'))
})

test('v1 → v2 → validate loses nothing', () => {
  const v1 = makeV1Project()
  const v2 = migrateV1toV2(v1)

  assert.equal(v2.version, SCHEMA_VERSION)
  assert.deepEqual(v2.media, { refs: [] })
  assertValid(v2)

  // Every clip gained an explicit null and changed in no other way.
  assert.equal(v2.timeline.clips.length, v1.timeline.clips.length)
  v2.timeline.clips.forEach((c, i) => {
    assert.equal(c.mediaRefId, null)
    assert.deepEqual({ ...c, mediaRefId: undefined }, { ...v1.timeline.clips[i], mediaRefId: undefined })
  })

  // Nothing outside timeline/media/version was touched — the edit is the part
  // this migration must not have opinions about.
  assert.deepEqual(v2.graph, v1.graph)
  assert.deepEqual(v2.project, v1.project)
  assert.deepEqual(v2.fonts, v1.fonts)
  assert.deepEqual(v2.ui, v1.ui)
  assert.equal(v2.savedAt, v1.savedAt)
})

test('migrateV1toV2 does not mutate its input', () => {
  const v1 = makeV1Project()
  const before = JSON.stringify(v1)
  migrateV1toV2(v1)
  assert.equal(JSON.stringify(v1), before)
})

test('migrateV1toV2 is idempotent', () => {
  const once = migrateV1toV2(makeV1Project())
  const twice = migrateV1toV2(once)
  assert.equal(twice, once, 'a second pass must return the same object, not a copy')
})

test('migrateV1toV2 preserves a mediaRefId that is already set', () => {
  const v1 = makeV1Project()
  v1.timeline.clips[0].mediaRefId = `mr_${HASH_A}`
  const v2 = migrateV1toV2(v1)
  assert.equal(v2.timeline.clips[0].mediaRefId, `mr_${HASH_A}`)
})

// ─── inline images ──────────────────────────────────────────────────────────

test('collectInlineImages finds images at every depth, deduplicated', () => {
  const found = collectInlineImages(makeV1Project())
  const urls = found.map(f => f.dataUrl)

  assert.equal(urls.length, 2, 'two distinct images across five uses')
  assert.ok(urls.includes(IMG_A))
  assert.ok(urls.includes(IMG_B))

  // The nested uses are the ones a naive pass misses, and missing them leaves
  // the largest strings in the document exactly where they were.
  const locations = found.map(f => f.at).join(' ')
  assert.ok(/timeline\.clips/.test(locations) || /masterGraph/.test(locations))
})

test('replaceInlineImages swaps every use, at every depth', () => {
  const v2 = migrateV1toV2(makeV1Project())
  const map = new Map([[IMG_A, `mr_${HASH_A}`], [IMG_B, `mr_${HASH_B}`]])
  const out = replaceInlineImages(v2, map)

  assert.equal(collectInlineImages(out).length, 0, 'no data URL may survive')

  const clip = out.timeline.clips.find(c => c.id === 'clip_image_1')
  assert.equal(clip.params.imageRefId, `mr_${HASH_A}`)
  assert.equal(clip.params.imageSrc, undefined)
  assert.equal(clip.params.imageName, 'logo.png', 'sibling params are untouched')

  const seen = []
  forEachNode(out.graph, (n) => { if (n.params?.imageRefId) seen.push([n.id, n.params.imageRefId]) })
  assert.deepEqual(seen.sort(), [
    ['lb_img', `mr_${HASH_B}`],       // compound library interior
    ['n_image', `mr_${HASH_A === HASH_B ? HASH_A : HASH_B}`], // top-level node
    ['n_inner_img', `mr_${HASH_A}`],  // inside a COMPOUND
  ].sort())

  // And the result is still a valid document once the refs it now names exist.
  out.media.refs = [
    stripRefPath(ref(HASH_A, { kind: 'image', filename: 'logo.png' })),
    stripRefPath(ref(HASH_B, { kind: 'image', filename: 'overlay.png' })),
  ]
  assertValid(out)
})

test('replaceInlineImages returns the same document when nothing matches', () => {
  const v2 = migrateV1toV2(makeV1Project())
  assert.equal(replaceInlineImages(v2, new Map()), v2)
})

test('replaceInlineImages accepts a plain object as well as a Map', () => {
  const v2 = migrateV1toV2(makeV1Project())
  const out = replaceInlineImages(v2, { [IMG_A]: `mr_${HASH_A}` })
  assert.equal(out.timeline.clips.find(c => c.id === 'clip_image_1').params.imageRefId, `mr_${HASH_A}`)
})

// ─── graph traversal ────────────────────────────────────────────────────────

test('forEachNode reaches master, clip graphs, compounds and the library', () => {
  const ids = []
  forEachNode(makeV1Project().graph, (n) => ids.push(n.id))
  for (const expected of [
    'n_video',       // master
    'n_inner_img',   // inside a COMPOUND subGraph
    'node_blur_1',   // a clip graph
    'tn_mix',        // a transition graph, under its synthetic key
    'lb_img',        // the compound library
  ]) {
    assert.ok(ids.includes(expected), `forEachNode missed ${expected}`)
  }
})

test('mapNodes keeps referential identity when nothing changes', () => {
  const g = makeV1Project().graph
  assert.equal(mapNodes(g, n => n), g)
})

// ─── validation: what must be rejected ──────────────────────────────────────

test('unknown top-level keys are rejected', () => {
  const doc = { ...makeV1Project(), payload: 'surprise' }
  const r = validateProject(doc)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('payload')))
})

test('unknown keys nested inside are NOT rejected', () => {
  // Forward compatibility: a field a future build adds must not make the
  // document unopenable by this one.
  const doc = makeV1Project()
  doc.project.someFutureSetting = true
  doc.timeline.clips[0].someFutureField = 7
  assertValid(doc)
})

test('a bad version is rejected', () => {
  for (const version of [0, 3, '2', null, undefined]) {
    assert.equal(validateProject({ ...makeV1Project(), version }).ok, false, `version ${String(version)}`)
  }
})

test('a v2 document without a media section is rejected', () => {
  const doc = { ...makeV1Project(), version: 2 }
  const r = validateProject(doc)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('media')))
})

test('a document carrying a filesystem path is an ERROR, not a warning', () => {
  // The single rule the whole security position rests on. A path in a project
  // file leaks the user's directory structure to anyone they send it to.
  const doc = migrateV1toV2(makeV1Project())
  doc.media.refs = [createRef({
    hash: HASH_A, filename: 'beach.mp4', kind: 'video', bytes: 10, mode: 'link',
    path: 'E:\\Footage\\beach.mp4', mtimeMs: 1, sig: 'deadbeefdeadbeefdead',
  })]
  const r = validateProject(doc)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /local-only/.test(e)), r.errors.join('\n'))

  // Stripped, the very same ref is fine.
  doc.media.refs = doc.media.refs.map(stripRefPath)
  assertValid(doc)
})

test('malformed refs and duplicate ref ids are rejected', () => {
  const doc = migrateV1toV2(makeV1Project())
  doc.media.refs = [{ id: 'mr_../../x', hash: HASH_A, mode: 'vault', kind: 'video', filename: 'a', bytes: 1 }]
  assert.equal(validateProject(doc).ok, false)

  doc.media.refs = [stripRefPath(ref(HASH_A)), stripRefPath(ref(HASH_A))]
  const r = validateProject(doc)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /duplicate/.test(e)))
})

test('a malformed mediaRefId on a clip is an error; a dangling one is a warning', () => {
  const doc = migrateV1toV2(makeV1Project())
  doc.media.refs = [stripRefPath(ref(HASH_A))]

  doc.timeline.clips[0].mediaRefId = 'mr_../../etc/passwd'
  assert.equal(validateProject(doc).ok, false)

  // Dangling is recoverable: the media is offline and repair handles it.
  // Refusing to open the project would be the worse outcome.
  doc.timeline.clips[0].mediaRefId = `mr_${HASH_B}`
  const r = validateProject(doc)
  assert.ok(r.ok, r.errors.join('\n'))
  assert.ok(r.warnings.some(w => w.includes(HASH_B)))
})

test('structural faults in the spine are rejected', () => {
  const missingProject = makeV1Project(); delete missingProject.project
  assert.equal(validateProject(missingProject).ok, false)

  const badFps = makeV1Project(); badFps.project.fps = 0
  assert.equal(validateProject(badFps).ok, false)

  const badRes = makeV1Project(); badRes.project.resolution = { width: 1920 }
  assert.equal(validateProject(badRes).ok, false)

  const backwardsClip = makeV1Project(); backwardsClip.timeline.clips[0].timelineEnd = -1
  assert.equal(validateProject(backwardsClip).ok, false)

  const nanClip = makeV1Project(); nanClip.timeline.clips[0].timelineStart = NaN
  assert.equal(validateProject(nanClip).ok, false)

  const dupNode = makeV1Project()
  dupNode.graph.masterGraph.nodes.push({ ...dupNode.graph.masterGraph.nodes[0] })
  assert.equal(validateProject(dupNode).ok, false)

  const badEdge = makeV1Project()
  badEdge.graph.masterGraph.edges[0] = { id: 'e', fromNode: 'n_video' }
  assert.equal(validateProject(badEdge).ok, false)

  assert.equal(validateProject(null).ok, false)
  assert.equal(validateProject([]).ok, false)
  assert.equal(validateProject('{}').ok, false)
})

test('a clip on a track that is not there warns rather than failing', () => {
  const doc = makeV1Project()
  doc.timeline.clips[0].trackId = 'track_that_left'
  const r = validateProject(doc)
  assert.ok(r.ok)
  assert.ok(r.warnings.some(w => w.includes('track_that_left')))
})

// ─── validation: node types, and the untrusted flag ─────────────────────────

test('an unknown node type warns from the vault and fails on import', () => {
  const doc = makeV1Project()
  doc.graph.masterGraph.nodes.push({
    id: 'n_future', type: 'NODE_FROM_A_NEWER_BUILD', name: 'Future', position: { x: 0, y: 0 }, params: {},
  })

  // Our own vault: a project written by a newer build must still open.
  const trusted = validateProject(doc)
  assert.ok(trusted.ok, trusted.errors.join('\n'))
  assert.ok(trusted.warnings.some(w => w.includes('NODE_FROM_A_NEWER_BUILD')))

  // Arrived from outside: an unrecognised type must not reach the compiler.
  const untrusted = validateProject(doc, { untrusted: true })
  assert.equal(untrusted.ok, false)
  assert.ok(untrusted.errors.some(e => e.includes('NODE_FROM_A_NEWER_BUILD')))
})

test('unknown types are caught inside compounds and clip graphs too', () => {
  const doc = makeV1Project()
  const compound = doc.graph.masterGraph.nodes.find(n => n.type === 'COMPOUND')
  compound.subGraph.nodes.push({ id: 'n_bad', type: 'EVIL', position: { x: 0, y: 0 }, params: {} })
  doc.graph.clipGraphs.clip_video_1.nodes.push({ id: 'n_bad2', type: 'ALSO_EVIL', position: { x: 0, y: 0 }, params: {} })

  const r = validateProject(doc, { untrusted: true })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.includes('EVIL')))
  assert.ok(r.errors.some(e => e.includes('ALSO_EVIL')))
})

test('the type whitelist can be injected, so schema.js is testable without the registry', () => {
  const doc = makeV1Project()
  const r = validateProject(doc, { knownNodeTypes: new Set(['VIDEO_INPUT']), untrusted: true })
  assert.equal(r.ok, false, 'every other type should now be unknown')
})

test('real node types resolve through the actual registry', () => {
  // Guards the assembly in nodeTypes.js: if the registry import broke, every
  // type would read as unknown and this would fail rather than silently passing.
  const doc = makeV1Project()
  const r = validateProject(doc, { untrusted: true })
  assert.ok(r.ok, r.errors.join('\n'))
})

// ─── validation: size ceilings ──────────────────────────────────────────────

test('an over-long ordinary string is rejected', () => {
  const doc = makeV1Project()
  doc.project.name = 'x'.repeat(LIMITS.string + 1)
  const r = validateProject(doc)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /over the .* limit/.test(e)))
})

test('shader source gets its own, larger cap', () => {
  const doc = makeV1Project()
  const node = doc.graph.masterGraph.nodes[0]

  // Comfortably over the ordinary string cap — and fine, because a hand-written
  // shader legitimately is.
  node.customShaderSource = '/*x*/'.repeat(LIMITS.string / 2)
  assertValid(doc)

  node.customShaderSource = 'x'.repeat(LIMITS.shaderSource + 1)
  assert.equal(validateProject(doc).ok, false)
})

test('a v1 inline image is allowed to be large; a name in its place is not', () => {
  const doc = makeV1Project()
  const clip = doc.timeline.clips.find(c => c.id === 'clip_image_1')
  clip.params.imageSrc = `data:image/webp;base64,${'A'.repeat(LIMITS.string * 4)}`
  assertValid(doc)

  clip.params.imageName = 'n'.repeat(LIMITS.string + 1)
  assert.equal(validateProject(doc).ok, false)
})

test('a circular document is rejected rather than hanging the validator', () => {
  const doc = makeV1Project()
  doc.timeline.clips[0].params.self = doc.timeline.clips[0]
  const r = validateProject(doc)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /circular/.test(e)))
})

test('validation reports every fault it finds, not just the first', () => {
  const doc = makeV1Project()
  delete doc.project
  doc.extraKey = 1
  doc.timeline.clips = 'not an array'
  const r = validateProject(doc)
  assert.ok(r.errors.length >= 3, r.errors.join('\n'))
})
