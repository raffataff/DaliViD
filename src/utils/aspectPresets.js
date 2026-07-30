/**
 * DaliVid — aspectPresets.js
 * Delivery aspect ratios for the project-level widescreen bars (and anywhere else
 * a framing ratio needs a label). Values are the plain numeric ratio the
 * letterbox shader consumes (u_lb_custom), so the UI can offer any list it likes
 * without the shader knowing about presets.
 *
 * Shared by the Toolbar's quick toggle and the Inspector's Project section —
 * keeping it out of a component module means both read the same list.
 */

export const ASPECT_PRESETS = [
  { label: '2.39:1 (Scope)', short: '2.39', value: 2.39 },
  { label: '2.35:1', short: '2.35', value: 2.35 },
  { label: '2:1 (Univisium)', short: '2.00', value: 2 },
  { label: '1.85:1 (Flat)', short: '1.85', value: 1.85 },
  { label: '16:9', short: '16:9', value: 16 / 9 },
  { label: '3:2', short: '3:2', value: 1.5 },
  { label: '4:3', short: '4:3', value: 4 / 3 },
  { label: '1:1 (Square)', short: '1:1', value: 1 },
  { label: '4:5 (Portrait)', short: '4:5', value: 0.8 },
  { label: '9:16 (Vertical)', short: '9:16', value: 9 / 16 },
]

/** Nearest preset label for a numeric ratio (falls back to "N.NN:1"). */
export function aspectLabel(value) {
  const v = Number(value)
  if (!Number.isFinite(v)) return '—'
  const hit = ASPECT_PRESETS.find(a => Math.abs(a.value - v) < 0.005)
  return hit ? hit.short : `${v.toFixed(2)}:1`
}
