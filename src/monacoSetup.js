/**
 * Bundle Monaco from node_modules instead of letting @monaco-editor/react fetch
 * it from the jsDelivr CDN at runtime.
 *
 * Why this matters: the default loader injects a <script> from cdn.jsdelivr.net
 * into our own origin. That third party then runs with full access to the user's
 * project, any linked folder handle and the camera — a code-injection surface
 * that exists even when our own hosting is untouched. It would also force the
 * CSP to whitelist an external script host, defeating the point of having one.
 *
 * Imported dynamically (see MonacoDrawer) so the ~5MB editor stays in a lazy
 * chunk and never lands in the startup bundle.
 */
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
// NOTE the subpath: monaco-editor 0.56 added an `exports` map that rewrites
// every subpath relative to esm/vs ("./*" → "./esm/vs/*.js"). The pre-0.56
// specifier 'monaco-editor/esm/vs/editor/editor.worker' therefore resolves to
// esm/vs/esm/vs/... and fails to build. Keep this path prefix-free.
import editorWorker from 'monaco-editor/editor/editor.worker?worker'

// GLSL is a custom Monarch grammar with no language service behind it, so the
// base editor worker covers everything we use — no ts/json/css/html workers.
self.MonacoEnvironment = { getWorker: () => new editorWorker() }

loader.config({ monaco })

export default monaco
