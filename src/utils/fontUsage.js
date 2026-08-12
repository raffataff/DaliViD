/**
 * DaliVid — fontUsage.js
 * Finds every font a project actually references.
 *
 * Two callers need this and they need it to agree:
 *   • the serializer, which only embeds the fonts a project uses (embedding the
 *     user's whole font library in every saved file would be rude and large);
 *   • the Media Pool, so "remove this font" can say what it will break instead
 *     of quietly pulling a typeface out from under four title cards.
 *
 * Deliberately state-in / data-out with no store imports, so it stays a pure
 * function of a project snapshot and can't create an import cycle with the
 * registry it serves.
 */

/**
 * Walk nodes (including compound interiors, which nest arbitrarily deep) and
 * record every `fontFamily` param found.
 */
function walkNodes(nodes, out) {
  if (!Array.isArray(nodes)) return
  for (const node of nodes) {
    const value = node?.params?.fontFamily
    if (value) out.set(value, (out.get(value) || 0) + 1)
    if (node?.subGraph?.nodes) walkNodes(node.subGraph.nodes, out)
  }
}

/**
 * Count references to each font value across a whole project.
 *
 * @param {object} graph — useGraphStore state (masterGraph, clipGraphs, compounds)
 * @param {object} timeline — useTimelineStore state (clips)
 * @returns {Map<string, number>} font value (id or legacy stack) → reference count
 */
export function collectFontUsage(graph, timeline) {
  const out = new Map()

  // Text clips carry their style on the clip itself, not in a node.
  for (const clip of timeline?.clips || []) {
    const value = clip?.params?.fontFamily
    if (value) out.set(value, (out.get(value) || 0) + 1)
  }

  walkNodes(graph?.masterGraph?.nodes, out)

  // Per-clip graphs (which also hold transition graphs) are an id → graph map.
  for (const g of Object.values(graph?.clipGraphs || {})) walkNodes(g?.nodes, out)

  // The compound library is an array of saved compounds; the text lives inside
  // each one's interior graph.
  for (const c of graph?.compoundLibrary || []) walkNodes(c?.subGraph?.nodes, out)

  return out
}

/** Just the distinct font values a project references. */
export function collectUsedFontValues(graph, timeline) {
  return [...collectFontUsage(graph, timeline).keys()]
}
