# Implementation Plan - AudioWaves Shader Integration

This plan outlines the integration of 10 new audio-reactive procedural shader generator and effect nodes from AudioWaves into DaliVid. Each new node implements multiple variations selectable via a dropdown, support for 17 standard cosine color palettes, and customizable background blending modes so they can function both as standalone visual generators (when the input is disconnected) and overlay filters.

## User Review Required

> [!NOTE]
> All new nodes are backward compatible and run on the standard single-input single-output WebGL2 FBO rendering pipeline in DaliVid.
> When their input socket is disconnected, DaliVid automatically routes a transparent black texture, making them run as standalone procedural generator sources.

## Proposed Changes

---

### 1. WebGL Shader Registry

#### [MODIFY] [shaderRegistry.js](file:///e:/bobby/Documents/DaliViD/AG/DaliViD%20-%20main/src/shaders/shaderRegistry.js)
- Register the following 10 new node shader types, complete with `@param` directives for the Inspector UI controls:
  1. `BIOMATH`: Complex raymarched structures (Neural Field, Gyroid Lattice, Crystalline Lattice, Hypnotic Spiral, Alien Terrain, Digital Sphere, Orchard).
  2. `PLASMA`: Flowing plasma waves (Classic, Liquid Noise, Cellular, Plasma Ball, Nebula).
  3. `FRACTAL`: Mathematical recursive fractals (Julia, Mandelbrot Zoom, KIFS, Fractal Grid, Newton Fractal, Sierpinski Gasket, Burning Ship, Mainframe).
  4. `TUNNEL`: 3D coordinate-warped tunnels (Cylindrical, Box, Warp Speed, Hyper Tunnel, Bio-Tunnel).
  5. `GEOMETRIC`: Grids, tiles, and symmetries (Sacred Geometry, Hexagonal Grid, Rotating Crosses, Geode).
  6. `LIGHTNING`: Electric discharges (Spectral Tesla, Waveform Bolt, Chaos Storm).
  7. `CRYSTAL`: Shattered and faceted patterns (Radial Facets, Glass Shatter, Isometric Cubes, Ethereal Gem).
  8. `COSMIC`: Galactic and celestial visuals (Spiral Arms, Nebula, Black Hole, Quasar).
  9. `WAVES`: Wave interference and ripple physics (Interference, Ripples, Beam Scanlines, Sliding Interference).
  10. `SPACE_DISTORTION`: Space-coordinate distortions (Twist, Fold).
- Each generator shader will feature:
  - `Mode` (dropdown select to pick the variation)
  - `Palette` (dropdown select to pick from 17 standard color palettes: Rainbow, Neon, Cosmic, Fire, Ocean, Pastel, Monochrome, Sunset, Forest, Cyberpunk, Arctic, Lava, Galaxy, Toxic, Vaporwave, Ember, Aqua)
  - Blending controls: `Blend Mode` (Replace, Add, Screen, Multiply, Overlay) and `Background Mix` (0.0 to 1.0) to mix the generator visual with the incoming background texture
  - Common helper functions (e.g. aspect-ratio corrected UV coordinates, pseudo-random hash, 2D rotation, simplex/FBM noise, and cosine color palette generators) embedded inline for standalone compilability

---

### 2. Node Editor UI & Styling

#### [MODIFY] [NodeCard.jsx](file:///e:/bobby/Documents/DaliViD/AG/DaliViD%20-%20main/src/components/NodeEditor/NodeCard.jsx)
- Register custom card accent colors in `NODE_COLORS` for each of the new node types:
  - `BIOMATH`: `#44aaff` (Blue-cyan)
  - `PLASMA`: `#ff00aa` (Deep magenta)
  - `FRACTAL`: `#cc44ff` (Bright purple)
  - `TUNNEL`: `#ff8844` (Vibrant orange)
  - `GEOMETRIC`: `#88aa44` (Olive green)
  - `LIGHTNING`: `#44ffaa` (Neon green)
  - `CRYSTAL`: `#aaccff` (Ice blue)
  - `COSMIC`: `#aa44ff` (Indigo)
  - `WAVES`: `#4488ff` (Ocean blue)
  - `SPACE_DISTORTION`: `#ccaa44` (Warm gold)

#### [MODIFY] [NodeSearchMenu.jsx](file:///e:/bobby/Documents/DaliViD/AG/DaliViD%20-%20main/src/components/NodeEditor/NodeSearchMenu.jsx)
- Add a new category `"Generators (Procedural)"` to `NODE_CATALOG` containing the 10 new node types so users can discover and instantiate them via the canvas right-click context menu.

#### [MODIFY] [ShaderGenerator.jsx](file:///e:/bobby/Documents/DaliViD/AG/DaliViD%20-%20main/src/components/NodeEditor/ShaderGenerator.jsx)
- Update `EFFECT_CATEGORIES` to add the new effects under the appropriate lists so they can be selected, surprise-generated, and chained into compound shaders:
  - Add `SPACE_DISTORTION` to the `distortion` category.
  - Add `BIOMATH`, `PLASMA`, `FRACTAL`, `TUNNEL`, `GEOMETRIC`, `LIGHTNING`, `CRYSTAL`, `COSMIC`, `WAVES` to a new category or merge them into `stylize`/`effects` for selection.

---

### 3. Media Pool Effects Tab

#### [MODIFY] [MediaPool.jsx](file:///e:/bobby/Documents/DaliViD/AG/DaliViD%20-%20main/src/components/MediaPool/MediaPool.jsx)
- Append cards for the new node types in `EFFECT_PRESETS` so they show up as draggable icons inside the "Effects" tab of the Media Pool, aligning with the default set of nodes.

---

## Verification Plan

### Automated Checks
- Run a project build check using `npm run build` to ensure there are no TypeScript/ESLint/Vite compile issues.

### Manual Verification
- **Creation & Styling**: Open the right-click menu or the Media Pool Effects tab, verify the new nodes appear in the search results with correct naming, and place them on the canvas. Check that they render with their assigned card colors.
- **Standalone Mode**: Create a `PLASMA` or `FRACTAL` node, connect its output directly to the `OUTPUT` node (leaving its input disconnected). Verify it renders the procedural pattern correctly on a black background.
- **Dropdown Modes**: Change the `Mode` parameter of the node in the Inspector panel. Verify the shader compiles instantly and changes to the selected visual style.
- **Palettes**: Change the `Palette` parameter of the node and verify that it updates the coloring scheme of the procedurally generated patterns.
- **Background Blending**: Place a video clip in the Media Pool. Connect `CLIP_SOURCE` -> `PLASMA` -> `CLIP_OUTPUT`.
  - Set `Background Mix` to `0.0`. Verify the video is fully hidden, and only the plasma waves are visible.
  - Set `Background Mix` to `0.5` and `Blend Mode` to `Screen`. Verify the plasma waves are blended over the playing video frame.
- **Audio Reactivity**: Connect an `Audio Splitter`'s `bass` socket to the `Speed` or `Intensity` parameter of the generator node. Verify that the visual reacts dynamically to the audio!
