/**
 * DaliVid — Media Pool → Transitions
 *
 * The browser every other NLE has and this app didn't. Before it, the only ways
 * to reach a transition were a dropdown buried in the clip Inspector and a
 * right-click on a fade wedge — and the wedge has zero width until a fade
 * exists, so on a fresh cut there was literally nothing to click. Transitions
 * were the least discoverable feature in the editor despite being one of the
 * most-used in the category.
 *
 * Three ways to apply, matching the muscle memory people arrive with:
 *   · drag a card onto a clip (front half = In, back half = Out)
 *   · click a card to apply it to the selected clip's nearer edge
 *   · right-click → make it the default, then use T / the ⇄ hotspots
 *
 * The list comes from `transitionCatalog`, so built-in shaders, shared library
 * compounds and "a private node graph" are one uniform set of cards and every
 * `type` here is directly consumable by `applyEdgeType`.
 */

import { useState, useMemo, useCallback } from 'react'
import useGraphStore from '../../store/useGraphStore'
import useAppStore from '../../store/useAppStore'
import useTimelineStore from '../../store/useTimelineStore'
import { nearestEdge, edgeLabel, TRANSITION_DRAG_TYPE } from '../../utils/clipTransitions'
import { groupedTransitionCatalog, applyTransitionById } from '../../utils/transitionActions'
import { addToast } from '../common/Toast'
import ContextMenu from '../common/ContextMenu'

export default function TransitionsTab() {
  const compoundLibrary = useGraphStore(s => s.compoundLibrary)
  const defaultTransition = useAppStore(s => s.defaultTransition)
  const setDefaultTransition = useAppStore(s => s.setDefaultTransition)
  const selectedClipId = useAppStore(s => s.selectedClipId)
  const [menu, setMenu] = useState(null) // { x, y, entry }
  const [query, setQuery] = useState('')

  const allGroups = useMemo(() => groupedTransitionCatalog(compoundLibrary), [compoundLibrary])

  // Filtering matters at this size — the library is past the point where
  // scanning eight groups of cards beats typing three letters.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return allGroups
    return allGroups
      .map(g => ({
        group: g.group,
        items: g.items.filter(e =>
          e.label.toLowerCase().includes(q) ||
          e.group.toLowerCase().includes(q) ||
          (e.description || '').toLowerCase().includes(q)),
      }))
      .filter(g => g.items.length > 0)
  }, [allGroups, query])

  /**
   * Click-to-apply. The edge is chosen from the PLAYHEAD's position within the
   * clip, not from a fixed end: if you have parked the playhead near a cut —
   * which is what you do before adding a transition — that is the edge you mean.
   */
  const applyToSelection = useCallback((type) => {
    if (!selectedClipId) {
      addToast({ message: 'Select a clip first, or drag this onto one' })
      return
    }
    const clip = useTimelineStore.getState().clips.find(c => c.id === selectedClipId)
    if (!clip) return
    const edge = nearestEdge(clip, useAppStore.getState().playheadTime)
    if (applyTransitionById(clip.id, edge, type || null)) {
      addToast({ message: `${edgeLabel(edge)} set on "${clip.filename || 'clip'}"`, type: 'success' })
    }
  }, [selectedClipId])

  return (
    <div className="media-pool__transitions">
      <div className="media-pool__transitions-hint">
        Drag onto a clip — front half sets Transition In, back half Transition Out.
        Click to apply to the selected clip. Right-click to set the default (<kbd>T</kbd>).
      </div>

      <input
        className="media-pool__transitions-search"
        type="search"
        value={query}
        placeholder="Search transitions…"
        onChange={(e) => setQuery(e.target.value)}
      />

      {groups.length === 0 && (
        <div className="media-pool__transitions-hint">No transition matches “{query}”.</div>
      )}

      {groups.map(({ group, items }) => (
        <div className="media-pool__effects-section" key={group}>
          <div className="media-pool__section-label">{group}</div>
          <div className="media-pool__transitions-grid">
            {items.map(entry => {
              const isDefault = entry.type === defaultTransition
              return (
                <div
                  key={entry.type || '__fade'}
                  className={`media-pool__transition-card ${isDefault ? 'media-pool__transition-card--default' : ''}`}
                  style={entry.color ? { borderColor: entry.color } : undefined}
                  draggable="true"
                  title={entry.description}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/dalivid-drag', JSON.stringify({
                      kind: 'transition',
                      // null is meaningful — "hand this edge back to the plain
                      // opacity ramp" — so it must survive the round trip as a
                      // real value rather than a missing key.
                      transitionType: entry.type || null,
                      name: entry.label,
                    }))
                    // A second, empty MIME type purely as a marker. Browsers
                    // withhold getData outside the `drop` event, so `types` is
                    // the only thing a dragover handler can read — and the
                    // Timeline needs to know this is a transition (highlight the
                    // edge it would land on) rather than a generator clip
                    // (no highlight, it becomes a new clip wherever you let go).
                    e.dataTransfer.setData(TRANSITION_DRAG_TYPE, '1')
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => applyToSelection(entry.type)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, entry })
                  }}
                >
                  <div className="media-pool__transition-icon">⇄</div>
                  <div className="media-pool__transition-name">
                    {entry.label}
                    {isDefault && <span className="media-pool__transition-star" title="Default transition (T)">★</span>}
                  </div>
                  <div className="media-pool__transition-desc">{entry.description}</div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          header={menu.entry.label}
          items={[
            {
              label: 'Apply to Selected Clip',
              icon: '⇄',
              hint: selectedClipId ? 'Nearest edge to the playhead' : 'No clip selected',
              disabled: !selectedClipId,
              onSelect: () => applyToSelection(menu.entry.type),
            },
            { separator: true },
            {
              label: menu.entry.type === defaultTransition ? 'Already the Default' : 'Set as Default Transition',
              icon: '★',
              hint: 'Used by the T shortcut and the ⇄ hotspots on a clip’s ends',
              disabled: menu.entry.type === defaultTransition,
              onSelect: () => setDefaultTransition(menu.entry.type),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
