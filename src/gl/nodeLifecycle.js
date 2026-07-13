/**
 * DaliVid — nodeLifecycle.js
 * A tiny event bus for graph-node removal. The graph store publishes a removal
 * (passing the full node, so subscribers can inspect its type/subGraph); the
 * Renderer subscribes to free that node's GPU resources (output/feedback FBOs,
 * image FBO+texture, and any compound inner FBOs).
 *
 * This keeps the dependency direction clean — the store never imports the
 * renderer. Both sides only depend on this module.
 */

const _hooks = new Set()

/**
 * Subscribe to node removals. The callback receives the removed node object.
 * @param {(node: object) => void} hook
 * @returns {() => void} unsubscribe
 */
export function onNodeRemoved(hook) {
  _hooks.add(hook)
  return () => _hooks.delete(hook)
}

/**
 * Notify subscribers that a node has been (or is about to be) removed from a
 * graph. No-op when the node is null/undefined.
 * @param {object|null} node
 */
export function emitNodeRemoved(node) {
  if (!node) return
  for (const hook of _hooks) {
    try {
      hook(node)
    } catch (err) {
      console.warn('[DaliVid] node-removed hook failed for node', node?.id, err)
    }
  }
}
