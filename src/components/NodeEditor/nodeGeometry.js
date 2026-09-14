/**
 * DaliViD — nodeGeometry.js
 * How big a node card is, and the clamps a resize drag obeys.
 *
 * These live apart from NodeCard because they are read by things that never
 * mount a card: the marquee hit test, the wire-insert box, fit-to-window and the
 * minimap all ask about EVERY node in the graph, including ones scrolled out of
 * the DOM, so nothing here may measure. `nodeWidth` and `estimateNodeHeight` are
 * the two halves of one answer and are deliberately in one file — a card whose
 * drawn size disagrees with what the hit tests believe is the bug this module
 * exists to prevent.
 *
 * Card geometry is per-node: `width` and `height` are set by dragging an edge
 * (undefined = the CSS default / content height) and `collapsed` folds the card
 * down to header + socket rail.
 */

import { getNodeSockets } from '../../shaders/nodeDefinitions'
import { visibleDataParams } from '../../shaders/dataNodeParams'

// Default card width — must match .node-card { width } in NodeCard.css. Always
// derive from nodeWidth(node), never from this constant: a node may override it.
export const NODE_WIDTH = 270
export const NODE_MIN_WIDTH = 180
export const NODE_MAX_WIDTH = 720
export const NODE_MIN_HEIGHT = 60
export const NODE_MAX_HEIGHT = 1600
// Smallest the params list may be squeezed to: its divider plus one row. A card
// can otherwise be dragged down until the list is a 2px sliver, which is a
// scroll container nobody can use and reads as a rendering fault.
export const NODE_MIN_PARAMS_H = 46

// A collapsed card is exactly two rows: header + socket rail, plus the card's
// 1px top and bottom borders. Constants rather than measurements for the reason
// above — which is exactly why NodeCard.css PINS the collapsed header's height
// (`.node-card--collapsed .node-card__header`). Left to itself the header is
// sized by its 27px action buttons, and a LOCKED node renders fewer of them, so
// a collapsed locked card came out ~8px shorter than an unlocked one and no
// single constant could describe both. Measured 30, was really 35.8.
export const NODE_HEADER_H = 34
export const NODE_RAIL_H = 22
export const NODE_CARD_BORDER_H = 2
export const NODE_COLLAPSED_HEIGHT = NODE_HEADER_H + NODE_RAIL_H + NODE_CARD_BORDER_H

export function nodeWidth(node) {
  const w = node?.width
  return typeof w === 'number' && isFinite(w)
    ? Math.max(NODE_MIN_WIDTH, Math.min(NODE_MAX_WIDTH, w))
    : NODE_WIDTH
}

/**
 * Estimated card height: header(30) + sockets + params + footer.
 * Shared by the marquee hit test, fit-to-window, the wire-insert hit test and
 * the minimap so they can never drift apart again.
 */
export function estimateNodeHeight(node, params) {
  // A collapsed card is header + rail whatever it contains, and a card whose
  // bottom edge has been dragged IS that height. Both have to be answered HERE
  // or every hit test drifts from what is drawn.
  if (node.collapsed) return NODE_COLLAPSED_HEIGHT
  if (typeof node.height === 'number' && isFinite(node.height)) return node.height
  const { inputs, outputs } = getNodeSockets(node.type, params, node)
  const socketCount = Math.max(inputs.filter(s => !s.isParam).length, outputs.length)
  // Sockets come from the full config list, but only VISIBLE param rows occupy
  // height — a `showIf`-hidden control (LFO's Beats/Cycle, …) draws nothing, and
  // counting it would leave the marquee/insert hit tests reaching below the card.
  const rows = visibleDataParams(params, node.params).length
  return 30 + socketCount * 22 + rows * 26 + 40
}
