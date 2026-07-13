#!/usr/bin/env node
/**
 * DaliVid — scripts/smoke-shaders.mjs
 * Dependency-free static smoke test for every shader in the shader registry.
 *
 * Why static (and not a real GL compile): the registry shaders are GLSL ES 3.00
 * (`#version 300 es`, i.e. WebGL2). headless-gl only exposes WebGL1 / GLSL ES
 * 1.00, so it can't compile these at all — it would fail every shader and tell
 * us nothing. Rather than pull in a heavyweight WebGL2 stack, this validates the
 * things that actually regress when hand-editing `shaderRegistry.js`, with zero
 * install and no GPU:
 *
 *   1. Structure — `#version 300 es` first, a precision qualifier, a fragment
 *      output (`out vec4 …`), a `void main()`, and balanced () {} [] .
 *   2. Undeclared uniforms — every `u_*` referenced in code is declared, AFTER
 *      running the real `injectAudioDrivers()` pass (so the auto-provided audio
 *      driver uniforms are accounted for exactly as the renderer accounts for
 *      them). This is the cheap catch for the classic "typo'd uniform name"
 *      break that otherwise only surfaces as a black frame at runtime.
 *   3. @param integrity — re-runs the real `parseParams()`, flags `@param`
 *      directives that don't resolve to a uniform (a silently-dropped slider),
 *      and validates each control's ranges / defaults / options.
 *
 * Run:  node scripts/smoke-shaders.mjs        (also chained into `npm run lint`)
 * Exits non-zero if any shader fails, so it slots straight into CI.
 */

import { getRegisteredTypes, getShaderSource } from '../src/shaders/shaderRegistry.js'
import { TRANSITION_TYPES, buildTransitionShader } from '../src/shaders/transitionRegistry.js'
import { parseParams } from '../src/utils/paramParser.js'
import { injectAudioDrivers } from '../src/utils/audioDrivers.js'

const EPS = 1e-6

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip // line comments and block comments so braces / identifiers inside
 * comments (notably the `@param` directive text) don't pollute the structural
 * and uniform checks.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/\/\/[^\n]*/g, ' ')       // line comments
}

/**
 * Names that count as "declared" for the undeclared-uniform check: uniforms
 * (incl. arrays + precision qualifiers), plus `#define` / `const` targets that
 * happen to use the u_ prefix, so those never read as undeclared.
 */
function declaredNames(src) {
  const names = new Set()
  const patterns = [
    /\buniform\s+(?:lowp\s+|mediump\s+|highp\s+)?\w+\s+(u_\w+)/g,
    /#define\s+(u_\w+)/g,
    /\bconst\s+\w+\s+(u_\w+)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(src)) !== null) names.add(m[1])
  }
  return names
}

/** All `u_*` identifiers referenced in code (pass a comment-stripped source). */
function referencedNames(code) {
  const names = new Set()
  const re = /\bu_[A-Za-z0-9_]+\b/g
  let m
  while ((m = re.exec(code)) !== null) names.add(m[0])
  return names
}

/** Returns an error string if () [] {} are unbalanced/mismatched, else null. */
function delimiterError(code) {
  const closeToOpen = { ')': '(', ']': '[', '}': '{' }
  const opens = new Set(['(', '[', '{'])
  const stack = []
  for (const ch of code) {
    if (opens.has(ch)) stack.push(ch)
    else if (ch in closeToOpen) {
      if (stack.pop() !== closeToOpen[ch]) return `mismatched '${ch}'`
    }
  }
  return stack.length ? `unclosed '${stack[stack.length - 1]}'` : null
}

/** Validate one parsed @param config; returns an array of error strings. */
function validateParam(cfg) {
  const errs = []
  if (!cfg.uniformName || !cfg.uniformName.startsWith('u_')) {
    errs.push(`param "${cfg.name}" → invalid uniform "${cfg.uniformName}"`)
  }
  if (cfg.type === 'slider') {
    const { min, max, default: def, step } = cfg
    if (![min, max, def, step].every(Number.isFinite)) {
      errs.push(`slider "${cfg.name}" has non-finite min/max/default/step`)
    } else {
      if (min > max) errs.push(`slider "${cfg.name}" min (${min}) > max (${max})`)
      if (def < min - EPS || def > max + EPS) errs.push(`slider "${cfg.name}" default ${def} outside [${min}, ${max}]`)
      if (step <= 0) errs.push(`slider "${cfg.name}" step ${step} must be > 0`)
    }
  } else if (cfg.type === 'select') {
    if (!cfg.options || cfg.options.length === 0) {
      errs.push(`select "${cfg.name}" has no options`)
    } else if (!Number.isInteger(cfg.default) || cfg.default < 0 || cfg.default >= cfg.options.length) {
      errs.push(`select "${cfg.name}" default index ${cfg.default} out of range 0..${cfg.options.length - 1}`)
    }
  } else if (cfg.type === 'color') {
    if (typeof cfg.default !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(cfg.default)) {
      errs.push(`color "${cfg.name}" default "${cfg.default}" is not #rrggbb`)
    }
  } else if (cfg.type === 'checkbox') {
    if (typeof cfg.default !== 'boolean') errs.push(`checkbox "${cfg.name}" default must be boolean`)
  }
  return errs
}

// ── per-shader validation ─────────────────────────────────────────────────────

function validateShader(type) {
  const errors = []
  const source = getShaderSource(type)
  if (!source) return ['no shader source registered']

  const stripped = stripComments(source)

  // 1. Structure
  const firstLine = source.split('\n').map(l => l.trim()).find(l => l.length > 0)
  if (firstLine !== '#version 300 es') errors.push(`first line must be "#version 300 es" (got "${firstLine}")`)
  if (!/\bprecision\s+(lowp|mediump|highp)\b/.test(stripped)) errors.push('missing precision qualifier')
  if (!/\bout\s+vec4\s+\w+\s*;/.test(stripped)) errors.push('missing fragment output (out vec4 …)')
  if (!/\bvoid\s+main\s*\(\s*\)/.test(stripped)) errors.push('missing void main()')
  const delimErr = delimiterError(stripped)
  if (delimErr) errors.push(`delimiter check: ${delimErr}`)

  // 2. Undeclared uniforms — declared set taken AFTER the real audio injection,
  //    so the auto-provided drivers (u_bass, u_mid, …, u_has_source) are covered.
  const declared = declaredNames(stripComments(injectAudioDrivers(source)))
  const undeclared = [...referencedNames(stripped)].filter(n => !declared.has(n))
  if (undeclared.length) errors.push(`undeclared uniform(s): ${undeclared.sort().join(', ')}`)

  // 3. @param integrity — a directive that doesn't resolve means the slider is
  //    silently dropped (the @param isn't immediately followed by its uniform).
  const directiveCount = (source.match(/\/\/\s*@param\b/g) || []).length
  const configs = parseParams(source)
  if (configs.length !== directiveCount) {
    errors.push(`${directiveCount} @param directive(s) but ${configs.length} resolved — an @param is not followed by a uniform`)
  }
  for (const cfg of configs) errors.push(...validateParam(cfg))

  return errors
}

// ── per-transition validation ────────────────────────────────────────────────
// Same checks as effect shaders, run on the fully assembled transition source
// (header + body + footer). No audio injection: transitions declare their
// standard uniforms explicitly in TRANSITION_HEADER.

function validateTransition(type) {
  const errors = []
  const source = buildTransitionShader(type)
  if (!source) return ['no transition source registered']

  const stripped = stripComments(source)

  // 1. Structure
  const firstLine = source.split('\n').map(l => l.trim()).find(l => l.length > 0)
  if (firstLine !== '#version 300 es') errors.push(`first line must be "#version 300 es" (got "${firstLine}")`)
  if (!/\bprecision\s+(lowp|mediump|highp)\b/.test(stripped)) errors.push('missing precision qualifier')
  if (!/\bout\s+vec4\s+\w+\s*;/.test(stripped)) errors.push('missing fragment output (out vec4 …)')
  if (!/\bvoid\s+main\s*\(\s*\)/.test(stripped)) errors.push('missing void main()')
  if (!/\bvec4\s+transition\s*\(\s*vec2\s+\w+\s*\)/.test(stripped)) errors.push('missing vec4 transition(vec2 uv)')
  const delimErr = delimiterError(stripped)
  if (delimErr) errors.push(`delimiter check: ${delimErr}`)

  // 2. Undeclared uniforms
  const declared = declaredNames(stripped)
  const undeclared = [...referencedNames(stripped)].filter(n => !declared.has(n))
  if (undeclared.length) errors.push(`undeclared uniform(s): ${undeclared.sort().join(', ')}`)

  // 3. @param integrity
  const directiveCount = (source.match(/\/\/\s*@param\b/g) || []).length
  const configs = parseParams(source)
  if (configs.length !== directiveCount) {
    errors.push(`${directiveCount} @param directive(s) but ${configs.length} resolved — an @param is not followed by a uniform`)
  }
  for (const cfg of configs) errors.push(...validateParam(cfg))

  return errors
}

// ── run ────────────────────────────────────────────────────────────────────--

const types = getRegisteredTypes()
const failures = []

for (const type of types) {
  const errs = validateShader(type)
  if (errs.length) failures.push({ type, errs })
}

for (const type of TRANSITION_TYPES) {
  const errs = validateTransition(type)
  if (errs.length) failures.push({ type: `transition:${type}`, errs })
}

const totalChecked = types.length + TRANSITION_TYPES.length

if (failures.length) {
  console.error('\n✖ Shader smoke test FAILED\n')
  for (const { type, errs } of failures) {
    console.error(`  ${type}`)
    for (const e of errs) console.error(`     - ${e}`)
  }
  console.error(`\n${failures.length} of ${totalChecked} shader(s) failed.\n`)
  process.exit(1)
}

console.log(`✔ Shader smoke test passed — ${types.length} shaders + ${TRANSITION_TYPES.length} transitions OK.`)
