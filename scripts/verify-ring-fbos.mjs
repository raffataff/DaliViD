#!/usr/bin/env node
/**
 * DaliVid — scripts/verify-ring-fbos.mjs
 *
 * Runtime check for the FEEDBACK_MACHINE delay ring's GPU side: the real
 * FBOManager, on a real WebGL2 context, driven through the slot maths the
 * executor uses. verify-feedback-machine.mjs checks what the SHADER does;
 * this checks what happens to the BUFFERS when the Delay slider moves and when
 * a node is deleted — the two cases that used to need a person watching the app.
 *
 * Same on-demand style as the other harnesses: playwright is deliberately NOT a
 * dependency. It starts the project's own Vite dev server so the page can import
 * src/gl/FBOManager.js directly (no bundling step, no stale copy), then:
 *
 *   - Delay 1 gives a 2-slot ring (identical to the old ping-pong).
 *   - Dragging Delay 1 → 30 rebuilds the ring and SEEDS every new slot with the
 *     most recent frame, so the picture freezes for a frame instead of flashing
 *     black. The seed is checked to be a non-black colour, or the test is vacuous.
 *   - Dragging back 30 → 1 frees the surplus slots and the survivors keep the
 *     picture (the seed is taken from a slot that is about to be deleted).
 *   - A same-count call resizes in place and keeps the ring's tick.
 *   - A scaled (Half / Quarter) ring is created at the size it was asked for,
 *     and returns to it after a canvas resize walks every FBO.
 *   - deleteRing (the node-delete path) frees every slot, and is a safe no-op
 *     for an id that owns nothing.
 *   - dispose leaves no rings or FBOs behind.
 *
 * Run:  npx --yes playwright@latest install chromium && node scripts/verify-ring-fbos.mjs
 */

import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' })
await server.listen()

// A CI image or sandbox may ship its own Chromium rather than playwright's
// download; point PLAYWRIGHT_CHROMIUM_PATH at that binary to use it.
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-sandbox'],
})
const page = await browser.newPage()
page.on('console', m => { if (m.type() === 'error') console.error('  page:', m.text()) })
page.on('pageerror', e => console.error('  pageerror:', e.message))

await page.goto('http://localhost:5199/', { waitUntil: 'domcontentloaded' })

const out = await page.evaluate(async () => {
  const { FBOManager } = await import('/src/gl/FBOManager.js')
  const { ringCount, ringSlots } = await import('/src/gl/historyRing.js')
  const canvas = document.createElement('canvas')
  canvas.width = 64; canvas.height = 64
  const gl = canvas.getContext('webgl2', { antialias: false })
  const results = []
  const ok = (n, p, d) => results.push({ n, p, d })

  const fbos = new FBOManager(gl)
  const ID = '__nring_test'

  // 1. Delay 1 → a 2-slot ring, i.e. the ping-pong.
  let ring = fbos.ensureRing(ID, ringCount(1, 64, 64), 64, 64)
  ok('delay 1 gives 2 slots', ring.count === 2, `count ${ring.count}`)
  ok('both slot FBOs exist', fbos.has(`${ID}_0`) && fbos.has(`${ID}_1`), '')

  // Paint slot contents so the seed can be identified after a rebuild.
  const paint = (id, r, g, b) => {
    fbos.bind(id)
    gl.clearColor(r, g, b, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }
  // RGBA16F targets must be read as FLOAT; fall back to bytes for the RGBA8 case.
  const readOne = (id) => {
    const e = fbos.fbos.get(id)
    gl.bindFramebuffer(gl.FRAMEBUFFER, e.fbo)
    const f = new Float32Array(4)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, f)
    if (gl.getError() === gl.NO_ERROR) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      return Array.from(f, v => Math.round(v * 255))
    }
    const px = new Uint8Array(4)
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.getError()
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return Array.from(px)
  }

  // Run a few ticks so `lastId` is a real, painted slot.
  for (let t = 0; t < 3; t++) {
    paint(ring.writeId, 0.25 * (t + 1), 0, 0)
    ring.advance()
  }
  const lastBefore = readOne(ring.lastId)

  // 2. Drag Delay 1 → 30: the ring is rebuilt and every new slot is SEEDED with
  //    the most recent frame, so the picture freezes rather than flashing black.
  ring = fbos.ensureRing(ID, ringCount(30, 64, 64), 64, 64)
  ok('delay 30 gives 31 slots', ring.count === 31, `count ${ring.count}`)
  let allSeeded = true
  const seen = []
  for (let i = 0; i < ring.count; i++) {
    const px = readOne(`${ID}_${i}`)
    seen.push(px[0])
    if (Math.abs(px[0] - lastBefore[0]) > 2) allSeeded = false
  }
  ok('every new slot is seeded with the last frame (no black flash)',
    allSeeded && lastBefore[0] > 100, `seed ${lastBefore[0]} (must be non-black), slots [${seen.join(',')}]`)

  // 3. Drag back 30 → 1: surplus slots are freed, the survivors keep the picture.
  for (let t = 0; t < 5; t++) { paint(ring.writeId, 0, 0.5, 0); ring.advance() }
  const lastBefore2 = readOne(ring.lastId)
  ring = fbos.ensureRing(ID, ringCount(1, 64, 64), 64, 64)
  ok('back to 2 slots', ring.count === 2, `count ${ring.count}`)
  let freed = true
  for (let i = 2; i < 31; i++) if (fbos.has(`${ID}_${i}`)) freed = false
  ok('surplus slot FBOs are deleted', freed, '')
  const s0 = readOne(`${ID}_0`), s1 = readOne(`${ID}_1`)
  ok('survivors keep the picture',
    lastBefore2[1] > 100 && Math.abs(s0[1] - lastBefore2[1]) <= 2 && Math.abs(s1[1] - lastBefore2[1]) <= 2,
    `seed ${lastBefore2[1]} (must be non-black), slots [${s0[1]},${s1[1]}]`)

  // 4. Same-count call is a no-op resize, not a rebuild (tick survives).
  ring.advance()
  const tickBefore = ring.tick
  const again = fbos.ensureRing(ID, 2, 64, 64)
  ok('same count keeps the same ring object and tick',
    again === ring && again.tick === tickBefore, `tick ${again.tick}`)

  // 5. A scaled (Half) ring: slots are created at the passed size.
  fbos.ensureRing('__nring_half', 4, 32, 32)
  const e = fbos.fbos.get('__nring_half_0')
  ok('scaled ring slots are the size asked for', e.width === 32 && e.height === 32,
    `${e.width}x${e.height}`)

  // 6. deleteRing frees every slot and the record — the node-delete path.
  fbos.deleteRing('__nring_half')
  let gone = true
  for (let i = 0; i < 4; i++) if (fbos.has(`__nring_half_${i}`)) gone = false
  ok('deleteRing frees every slot', gone && fbos.getRing('__nring_half') === null, '')
  fbos.deleteRing('__nring_never_existed') // must not throw

  // 7. resizeAll (canvas resize) then ensureRing puts the ring back to its own size.
  fbos.resizeAll(128, 128)
  fbos.ensureRing(ID, 2, 64, 64)
  const e2 = fbos.fbos.get(`${ID}_0`)
  ok('ring returns to its own size after a canvas resize',
    e2.width === 64 && e2.height === 64, `${e2.width}x${e2.height}`)

  // 8. dispose clears the ring registry.
  fbos.dispose()
  ok('dispose clears rings', fbos.rings.size === 0 && fbos.fbos.size === 0,
    `rings ${fbos.rings.size}, fbos ${fbos.fbos.size}`)

  // 9. The slot the executor reads is the one written `count - 1` ticks ago.
  const hist = new Array(6).fill(null)
  let good = true
  for (let t = 0; t < 20; t++) {
    const s = ringSlots(t, 6)
    const r = hist[s.read]
    hist[s.write] = t
    if (t >= 5 && r !== t - 5) good = false
  }
  ok('ringSlots delivers a 5-frame delay from a 6-slot ring', good, '')

  const err = gl.getError()
  ok('no GL errors', err === gl.NO_ERROR, `error ${err}`)
  return results
})

await browser.close()
await server.close()

let failed = 0
console.log('\nFBOManager delay ring — real WebGL2 checks\n')
for (const r of out) {
  if (!r.p) failed++
  console.log(`  ${r.p ? 'PASS' : 'FAIL'}  ${r.n}${r.d ? `\n          ${r.d}` : ''}`)
}
console.log(`\n${out.length - failed}/${out.length} passed.\n`)
process.exit(failed ? 1 : 0)
