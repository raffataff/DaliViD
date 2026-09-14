/**
 * DaliVid — storage/nodeTypes.js
 * The set of node `type` strings a project document is allowed to contain.
 *
 * Split out of `schema.js` for two reasons. It is the one part of validation
 * that must import the shader registry (megabytes of GLSL string literals), so
 * keeping it separate leaves `schema.js` importable by anything — a Worker, a
 * test, and later the Electron main process — without dragging the whole shader
 * bundle along. And it is the part most likely to need a different source later:
 * on desktop the trusted process wants this list without the shaders behind it.
 *
 * The set is assembled, not hand-maintained. A hand-written list is a list that
 * goes stale the first time someone adds a node and forgets this file, and the
 * symptom would be a valid project refusing to open.
 */

import NODE_DEFS from '../shaders/nodeDefinitions.js'
import { getRegisteredTypes } from '../shaders/shaderRegistry.js'

/**
 * Types with no socket definition and no shader of their own.
 *
 * `COMPOUND` derives its sockets from its own sub-graph terminals, so it never
 * appears in `NODE_DEFS` — see `getNodeSockets`. It is not an oversight, and
 * omitting it here would reject every project containing a compound.
 */
export const STRUCTURAL_NODE_TYPES = ['COMPOUND']

/**
 * Types no longer created, but still present in saved projects and rewritten on
 * load.
 *
 * `TIME` was split into `RAMP` + `LFO`; `migrateGraphNodes` converts it during
 * deserialise. Validation can run *before* that (on a file being imported, on a
 * doc being read out of the vault), so the validator has to accept what the
 * migration is about to remove — otherwise every pre-split project fails to
 * open, which is precisely the data loss validation exists to prevent.
 *
 * Only remove an entry here once nothing can still migrate it.
 */
export const LEGACY_NODE_TYPES = ['TIME']

let _cache = null

/**
 * Every node type a document may legitimately carry.
 * Built once and cached — the registries are fixed at module load.
 *
 * @returns {Set<string>}
 */
export function getKnownNodeTypes() {
  if (_cache) return _cache
  _cache = new Set([
    ...Object.keys(NODE_DEFS),
    ...getRegisteredTypes(),
    ...STRUCTURAL_NODE_TYPES,
    ...LEGACY_NODE_TYPES,
  ])
  return _cache
}

/** @returns {boolean} */
export function isKnownNodeType(type) {
  return getKnownNodeTypes().has(type)
}
