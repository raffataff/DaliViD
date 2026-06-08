# Implementation Plan - Node Canvas Enhancements & Math Node Separation

This plan outlines the changes needed to improve node noodle interactions, implement Blender-style auto-reconnection on Shift+drag, and separate the "Math/Blend" node into two independent nodes: "Mix/Blend" (texture-based mixing) and "Math" (value/float mathematical operations).

## User Review Required

> [!NOTE]
> All changes are backward compatible: existing graphs containing `MATH_BLEND` will continue to compile and function exactly as before.

## Proposed Changes

---

### 1. Canvas & Socket Interaction Fixes

#### [MODIFY] [Socket.jsx](file:///e:/bobby/Documents/DaliViD/AG/DaliViD%20-%20Copy/src/components/NodeEditor/Socket.jsx)
- Render `data-node-id`, `data-socket-id`, and `data-socket-type` attributes on the outer `.socket` div.
- This allows query selectors to locate the socket in the DOM to get pixel-perfect coordinates.

#### [MODIFY] [NodeCard.jsx](file:///e:/bobby/Documents/DaliViD/AG/DaliViD%20-%20Copy/src/components/NodeEditor/NodeCard.jsx)
- Pass `onDragStart={onSocketDragStart}` to all input sockets (both fixed inputs and param inputs) so dragging from input sockets works, allowing users to unplug noodles.
- Handle `e.shiftKey` in `handleMouseDown` to trigger a new `onDetachNode(node.id)` callback.
- Add accent color styling for `MIX_BLEND` and `MATH` nodes.

#### [MODIFY] [NodeCanvas.jsx](file:///e:/bobby/Documents/DaliViD/AG/DaliViD%20-%20Copy/src/components/NodeEditor/NodeCanvas.jsx)
- Update `getSocketPos` to query the DOM for `.socket[data-node-id="..."][data-socket-id="..."] .socket__circle` first. If found, calculate its exact coordinates in canvas space by dividing by `zoom` and offsetting by `pan`.
- Improve the mathematical fallback positions for input/output and parameter sockets to prevent jumps when rendering before mount.
- Implement `handleDetachNode` to reconnect adjacent nodes: for each incoming edge to the detached node, find a compatible unused outgoing edge from the detached node, and connect the upstream source node directly to the downstream target node (like Blender's detaching behavior). Then sever all connections to the detached node.
- Pass `onDetachNode={handleDetachNode}` to `<NodeCard />`.
- Manually define parameter schema for `MATH` node inside `nodeParamConfigs` since it runs purely on the CPU and has no GLSL shader source.

---

### 2. Math & Mix/Blend Node Separation

#### [MODIFY] [nodeDefinitions.js](file:///e:/bobby/Documents/DaliViD/AG/DaliViD%20-%20Copy/src/shaders/nodeDefinitions.js)
- Register `MIX_BLEND` with two texture inputs and one texture output.
- Register `MATH` with zero static inputs (inputs are generated dynamically from params), one float output socket (`output`), and `hasParamInputs: true`.
- Update `getNodeSockets` to skip `select` and `checkbox` parameter types when auto-generating float sockets, so the `Operation` select dropdown on the `MATH` node does not render a connection socket.

#### [MODIFY] [shaderRegistry.js](file:///e:/bobby/Documents/DaliViD/AG/DaliViD%20-%20Copy/src/shaders/shaderRegistry.js)
- Register `MIX_BLEND` alongside `MATH_BLEND` (which remains for backward compatibility) pointing to the same multi-mode texture-blending fragment shader.

#### [MODIFY] [NodeSearchMenu.jsx](file:///e:/bobby/Documents/DaliViD/AG/DaliViD%20-%20Copy/src/components/NodeEditor/NodeSearchMenu.jsx)
- Replace `MATH_BLEND` with `MIX_BLEND` ("Mix / Blend") and `MATH` ("Math") under the `Utility` category.

#### [MODIFY] [clipGraphManager.js](file:///e:/bobby/Documents/DaliViD/AG/DaliViD%20-%20Copy/src/gl/clipGraphManager.js)
- Add `MATH` to the list of shader-less nodes (like `AUDIO_INPUT`, `AUDIO_SPLITTER`) so that the GL engine does not attempt to compile a shader program for it.
- Update `resolveFloatConnections` to topologically sort and evaluate `MATH` CPU-side mathematical operations (Add, Subtract, Multiply, Divide, Sine, Cosine, Absolute, Min, Max, Greater Than, Less Than).
- Evaluate float/audio node chains dynamically and recursive-like, so `MATH` outputs can drive other `MATH` inputs, which eventually drive shader uniforms on rendering nodes.

---

## Verification Plan

### Automated/Compiler Checks
- Verify Vite compilation completes successfully by running a production build (`npm run build`).

### Manual Verification
- **Unplugging**: Verify clicking and dragging a connected input socket severs the connection and lets the user drag the noodle to a new socket or drop it in empty space to delete it.
- **Alignment**: Verify all value sockets and texture sockets align perfectly with noodle start/end endpoints at any zoom level.
- **Shift+drag**: Connect `CLIP_SOURCE` -> `Gaussian Blur` -> `CLIP_OUTPUT`. Shift+drag `Gaussian Blur` and verify it gets detached, and the `CLIP_SOURCE` is automatically connected directly to `CLIP_OUTPUT`.
- **Math Node**: Create an `Audio Splitter` node. Connect the `bass` socket to `Math` node's `Value A` parameter socket. Select `Multiply` operation, and set `Value B` to `2.0`. Connect the `Math` node's `Output` float socket to a blur's `Radius` parameter socket. Verify the blur radius reactively doubles with the audio bass!
