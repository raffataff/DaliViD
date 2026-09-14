/**
 * A v1 project document, shaped to match `serializeProject` in
 * `src/utils/projectSerializer.js` field for field.
 *
 * Deliberately not minimal. The things that break a migration are the awkward
 * corners, so this fixture carries all of them: a compound with an interior, a
 * clip graph, a *transition* graph under its synthetic `<clipId>::tr:<edge>`
 * key, a compound library entry, a legacy `TIME` node that migration is due to
 * rewrite, and inline image data URLs at three different depths (a clip, a
 * top-level node, and inside a compound).
 *
 * A builder rather than a constant so each test gets its own object and one
 * test's mutation cannot leak into the next.
 */

/** A short but structurally real image data URL. */
export const IMG_A = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='
export const IMG_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

export function makeV1Project(overrides = {}) {
  const doc = {
    version: 1,
    savedAt: '2026-08-20T10:00:00.000Z',

    project: {
      name: 'Fixture Project',
      id: 'proj_fixture_0001',
      fps: 30,
      resolution: { width: 1920, height: 1080 },
      colorSpace: 'srgb',
      bpm: 120,
      beatOffset: 0,
      beatGridEnabled: false,
      defaultTransition: '',
      masterBars: { enabled: false, aspect: '2.39', color: '#000000', opacity: 1, feather: 0, offset: 0, zoom: 1 },
    },

    timeline: {
      tracks: [
        { id: 'track_v1', name: 'Video 1', type: 'video', muted: false, solo: false, locked: false, blendMode: 'Normal', opacity: 1, color: '#4488ff', zOrder: 0 },
        { id: 'track_a1', name: 'Audio 1', type: 'audio', muted: false, solo: false, locked: false, blendMode: 'Normal', opacity: 1, color: '#44ff88', zOrder: 1 },
      ],
      clips: [
        {
          id: 'clip_video_1', trackId: 'track_v1',
          filename: 'beach.mp4', fileType: 'video',
          timelineStart: 0, timelineEnd: 8, sourceStart: 0, sourceEnd: 8,
          speed: 1, reversed: false, opacity: 1, volume: 1, audioMuted: false,
          blendMode: 'Inherit', fadeIn: 0.5, fadeOut: 1,
          transitionIn: { type: 'CROSSFADE', params: {} }, transitionOut: null, transition: null,
          transform: null, params: {}, metadata: { width: 1920, height: 1080 }, hasEffects: true,
        },
        {
          // The generator clip that carries a megabyte of base64 today.
          id: 'clip_image_1', trackId: 'track_v1',
          filename: 'logo.png', fileType: 'image',
          timelineStart: 8, timelineEnd: 12, sourceStart: 0, sourceEnd: 4,
          speed: 1, reversed: false, opacity: 1, volume: 1, audioMuted: false,
          blendMode: 'Inherit', fadeIn: 0, fadeOut: 0,
          transitionIn: null, transitionOut: null, transition: null,
          transform: null,
          params: { imageSrc: IMG_A, imageName: 'logo.png', fit: 'Cover' },
          metadata: { width: 512, height: 512 }, hasEffects: false,
        },
        {
          id: 'clip_audio_1', trackId: 'track_a1',
          filename: 'music.mp3', fileType: 'audio',
          timelineStart: 0, timelineEnd: 12, sourceStart: 0, sourceEnd: 12,
          speed: 1, reversed: false, opacity: 1, volume: 0.8, audioMuted: false,
          blendMode: 'Inherit', fadeIn: 0, fadeOut: 2,
          transitionIn: null, transitionOut: null, transition: null,
          transform: null, params: {}, metadata: {}, hasEffects: false,
        },
      ],
      markers: [{ id: 'mk_1', time: 4, label: 'drop', color: '#ffcc00' }],
      inPoint: 0,
      outPoint: 12,
      keyframes: [
        { clipId: 'clip_video_1', nodeId: 'node_blur_1', paramName: 'u_blur_radius',
          keys: [{ time: 0, value: 0, easing: 'linear' }, { time: 4, value: 12, easing: 'ease' }] },
      ],
    },

    graph: {
      masterGraph: {
        nodes: [
          { id: 'n_video', type: 'VIDEO_INPUT', name: 'Video', position: { x: 0, y: 0 }, params: {}, audioBindings: {} },
          { id: 'n_image', type: 'IMAGE_INPUT', name: 'Image', position: { x: 300, y: 0 },
            params: { imageSrc: IMG_B, imageName: 'overlay.png' }, audioBindings: {} },
          // Legacy node type: migration rewrites it to RAMP/LFO on deserialise,
          // so validation must not reject a document that still contains one.
          { id: 'n_time', type: 'TIME', name: 'Time', position: { x: 300, y: 200 },
            params: { source: 'Clip Progress', wave: 'Saw Up' }, audioBindings: {} },
          { id: 'n_compound', type: 'COMPOUND', name: 'My Compound', position: { x: 600, y: 0 },
            params: {}, audioBindings: {},
            subGraph: {
              nodes: [
                { id: 'n_in', type: 'EFFECT_INPUT', name: 'Input', position: { x: 0, y: 0 }, params: {}, terminalRole: 'from' },
                { id: 'n_inner_img', type: 'IMAGE_INPUT', name: 'Inner Image', position: { x: 200, y: 0 },
                  params: { imageSrc: IMG_A, imageName: 'logo.png' } },
                { id: 'n_out', type: 'EFFECT_OUTPUT', name: 'Output', position: { x: 400, y: 0 }, params: {} },
              ],
              edges: [{ id: 'e_i1', fromNode: 'n_in', fromSocket: 'output', toNode: 'n_out', toSocket: 'input' }],
              tapPointNodeId: null,
            },
            exposedParams: [] },
          { id: 'n_output', type: 'OUTPUT', name: 'Output', position: { x: 900, y: 0 }, params: {}, locked: true, audioBindings: {} },
        ],
        edges: [
          { id: 'e_1', fromNode: 'n_video', fromSocket: 'output', toNode: 'n_compound', toSocket: 'input' },
          { id: 'e_2', fromNode: 'n_compound', fromSocket: 'output', toNode: 'n_output', toSocket: 'input' },
        ],
        tapPointNodeId: null,
      },

      clipGraphs: {
        clip_video_1: {
          nodes: [
            { id: 'node_src_1', type: 'CLIP_SOURCE', name: 'Source', position: { x: 0, y: 0 }, params: {}, locked: true, audioBindings: {} },
            { id: 'node_blur_1', type: 'BLUR', name: 'Blur', position: { x: 300, y: 0 },
              params: { u_blur_radius: 4 }, collapsed: true, width: 320, audioBindings: {} },
            { id: 'node_out_1', type: 'CLIP_OUTPUT', name: 'Output', position: { x: 600, y: 0 }, params: {}, locked: true, audioBindings: {} },
          ],
          edges: [
            { id: 'ce_1', fromNode: 'node_src_1', fromSocket: 'output', toNode: 'node_blur_1', toSocket: 'input' },
            { id: 'ce_2', fromNode: 'node_blur_1', fromSocket: 'output', toNode: 'node_out_1', toSocket: 'input' },
          ],
          tapPointNodeId: null,
        },
        // A per-edge transition graph, under the synthetic key that makes the
        // whole feature cheap. It is an ordinary clipGraphs entry and must
        // validate and migrate as one.
        'clip_video_1::tr:in': {
          nodes: [
            { id: 'tn_from', type: 'EFFECT_INPUT', name: 'From', position: { x: 0, y: 0 }, params: {}, terminalRole: 'from' },
            { id: 'tn_to', type: 'EFFECT_INPUT', name: 'To', position: { x: 0, y: 150 }, params: {}, terminalRole: 'to' },
            { id: 'tn_mix', type: 'MIX_BLEND', name: 'Mix', position: { x: 300, y: 0 }, params: { u_mix: 0.5 } },
            { id: 'tn_out', type: 'EFFECT_OUTPUT', name: 'Output', position: { x: 600, y: 0 }, params: {} },
          ],
          edges: [
            { id: 'te_1', fromNode: 'tn_from', fromSocket: 'output', toNode: 'tn_mix', toSocket: 'input' },
            { id: 'te_2', fromNode: 'tn_to', fromSocket: 'output', toNode: 'tn_mix', toSocket: 'input_b' },
            { id: 'te_3', fromNode: 'tn_mix', fromSocket: 'output', toNode: 'tn_out', toSocket: 'input' },
          ],
          tapPointNodeId: null,
        },
      },

      compoundLibrary: [
        { id: 'lib_1', name: 'Saved Look', version: 1,
          subGraph: {
            nodes: [
              { id: 'lb_in', type: 'EFFECT_INPUT', name: 'Input', position: { x: 0, y: 0 }, params: {} },
              { id: 'lb_img', type: 'IMAGE_INPUT', name: 'Texture', position: { x: 200, y: 0 },
                params: { imageSrc: IMG_B, imageName: 'overlay.png' } },
              { id: 'lb_out', type: 'EFFECT_OUTPUT', name: 'Output', position: { x: 400, y: 0 }, params: {} },
            ],
            edges: [{ id: 'lbe_1', fromNode: 'lb_in', fromSocket: 'output', toNode: 'lb_out', toSocket: 'input' }],
            tapPointNodeId: null,
          },
          exposedParams: [] },
      ],
    },

    fonts: [
      { id: 'custom:a1b2c3d4e5f6a1b2c3d4', hash: 'a1b2c3d4e5f6a1b2c3d4', label: 'Some Face', weights: [400, 700], variable: false },
    ],

    ui: { graphLevel: 'master', graphClipId: null, graphCompoundPath: [], editMode: 'select' },
  }

  return { ...doc, ...overrides }
}
