/**
 * DaliVid — topSort.js
 * Topological sort for node graphs with cycle detection.
 * Returns an ordered array of node IDs for execution.
 */

/**
 * Topologically sort a graph.
 * @param {Array} nodes — [{ id, ... }]
 * @param {Array} edges — [{ fromNode, toNode, ... }]
 * @returns {{ sorted: string[], hasCycle: boolean, cycleNodes: Set<string> }}
 */
export function topologicalSort(nodes, edges) {
  const nodeIds = new Set(nodes.map(n => n.id))
  const adjacency = new Map()   // nodeId → [downstream nodeIds]
  const inDegree = new Map()    // nodeId → number of incoming edges

  // Initialize
  for (const id of nodeIds) {
    adjacency.set(id, [])
    inDegree.set(id, 0)
  }

  // Build adjacency list
  for (const edge of edges) {
    if (nodeIds.has(edge.fromNode) && nodeIds.has(edge.toNode)) {
      adjacency.get(edge.fromNode).push(edge.toNode)
      inDegree.set(edge.toNode, (inDegree.get(edge.toNode) || 0) + 1)
    }
  }

  // Kahn's algorithm
  const queue = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }

  const sorted = []
  while (queue.length > 0) {
    const current = queue.shift()
    sorted.push(current)

    for (const neighbor of adjacency.get(current)) {
      const newDeg = inDegree.get(neighbor) - 1
      inDegree.set(neighbor, newDeg)
      if (newDeg === 0) {
        queue.push(neighbor)
      }
    }
  }

  // Cycle detection
  const hasCycle = sorted.length !== nodeIds.size
  const cycleNodes = new Set()

  if (hasCycle) {
    // Nodes not in sorted result are part of cycles
    for (const id of nodeIds) {
      if (!sorted.includes(id)) {
        cycleNodes.add(id)
      }
    }
  }

  return { sorted, hasCycle, cycleNodes }
}

/**
 * Find all nodes reachable from a given node (downstream).
 */
export function findDownstream(startNodeId, edges) {
  const visited = new Set()
  const queue = [startNodeId]

  while (queue.length > 0) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)

    for (const edge of edges) {
      if (edge.fromNode === current && !visited.has(edge.toNode)) {
        queue.push(edge.toNode)
      }
    }
  }

  visited.delete(startNodeId) // Don't include the start node itself
  return visited
}

/**
 * Find all nodes upstream of a given node.
 */
export function findUpstream(targetNodeId, edges) {
  const visited = new Set()
  const queue = [targetNodeId]

  while (queue.length > 0) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)

    for (const edge of edges) {
      if (edge.toNode === current && !visited.has(edge.fromNode)) {
        queue.push(edge.fromNode)
      }
    }
  }

  visited.delete(targetNodeId)
  return visited
}

/**
 * Find orphaned nodes — not connected to any path leading to a target node (usually OUTPUT).
 */
export function findOrphaned(nodes, edges, targetNodeId) {
  const connected = findUpstream(targetNodeId, edges)
  connected.add(targetNodeId)

  const orphaned = new Set()
  for (const node of nodes) {
    if (!connected.has(node.id)) {
      orphaned.add(node.id)
    }
  }
  return orphaned
}

/**
 * Get the execution order for nodes leading to the output node,
 * skipping orphaned and bypassed nodes.
 */
export function getExecutionOrder(nodes, edges, outputNodeId) {
  const { sorted, hasCycle, cycleNodes } = topologicalSort(nodes, edges)

  if (hasCycle) {
    return { order: [], hasCycle: true, cycleNodes }
  }

  // Filter to only connected nodes
  const connected = findUpstream(outputNodeId, edges)
  connected.add(outputNodeId)

  const order = sorted.filter(id => connected.has(id))

  return { order, hasCycle: false, cycleNodes: new Set() }
}
