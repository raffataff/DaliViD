import { useState, useEffect, useRef } from 'react'
import Editor, { useMonaco } from '@monaco-editor/react'
import useAppStore from '../../store/useAppStore'
import useGraphStore from '../../store/useGraphStore'
import { GLSL_BOILERPLATE } from './BoilerplateTemplate'
import { setupGLSLMonaco } from './GLSLTokenizer'
import { IconClose } from '../common/Icons'
import { addToast } from '../common/Toast'
import { getNodeSource } from '../../shaders/shaderRegistry'
import { parseParams } from '../../utils/paramParser'
import { audioDriverHeader } from '../../utils/audioDrivers'
import './MonacoDrawer.css'

export default function MonacoDrawer() {
  const monacoOpen = useAppStore(s => s.monacoOpen)
  const monacoNodeId = useAppStore(s => s.monacoNodeId)
  const closeMonaco = useAppStore(s => s.closeMonaco)
  const graphLevel = useAppStore(s => s.graphLevel)
  const graphClipId = useAppStore(s => s.graphClipId)
  const updateNodeCustomShader = useGraphStore(s => s.updateNodeCustomShader)
  const setNodeParam = useGraphStore(s => s.setNodeParam)
  const getNode = useGraphStore(s => s.getNode)

  const [code, setCode] = useState(GLSL_BOILERPLATE)
  const [nodeName, setNodeName] = useState('CUSTOM SHADER')
  const monaco = useMonaco()
  const editorRef = useRef(null)

  // Configure Monaco language and theme when instance is ready
  useEffect(() => {
    if (monaco) {
      setupGLSLMonaco(monaco)
    }
  }, [monaco])

  // Load code when drawer opens or node changes
  useEffect(() => {
    if (monacoOpen && monacoNodeId) {
      const node = getNode(graphLevel, graphClipId, monacoNodeId)
      if (node) {
        setNodeName(node.name || node.label || 'CUSTOM SHADER')
        // Load the node's actual shader (custom edit → attached code → registry),
        // falling back to boilerplate only when the node has no source at all.
        // audioDriverHeader makes the full set of audio uniforms visible at the
        // top so all bands (sub-bass … rms, beat) are discoverable, not just the
        // few the example code happens to use.
        setCode(audioDriverHeader(getNodeSource(node) || GLSL_BOILERPLATE))
      }
    }
  }, [monacoOpen, monacoNodeId, graphLevel, graphClipId, getNode])

  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor
    
    // Add Ctrl+S / Cmd+S shortcut inside the editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleSave()
    })
  }

  const handleSave = () => {
    if (!monacoNodeId) return
    const currentCode = editorRef.current.getValue()

    // Save the edited source to the node
    updateNodeCustomShader(graphLevel, graphClipId, monacoNodeId, currentCode)

    // Seed default values for any params introduced by the edit so their
    // uniforms aren't left unset (which would render as 0 / "no effect")
    // until the user first touches the slider.
    const node = getNode(graphLevel, graphClipId, monacoNodeId)
    const existing = node?.params || {}
    for (const cfg of parseParams(currentCode)) {
      if (existing[cfg.uniformName] === undefined) {
        setNodeParam(graphLevel, graphClipId, monacoNodeId, cfg.uniformName, cfg.default)
      }
    }

    addToast({ message: 'Shader compiled & saved', type: 'success' })
  }

  // Prevent keyboard events from bubbling up to global App shortcuts while editing
  const handleEditorKeyDown = (e) => {
    e.stopPropagation()
  }

  return (
    <div className={`monaco-drawer ${monacoOpen ? 'monaco-drawer--open' : ''}`}>
      <div className="monaco-drawer__header">
        <div className="monaco-drawer__title">
          <span>Shader Editor</span>
          <span className="monaco-drawer__title-badge">{nodeName}</span>
        </div>
        <div className="monaco-drawer__actions">
          <button className="monaco-drawer__btn monaco-drawer__btn--save" onClick={handleSave}>
            Compile & Save
          </button>
          <button className="monaco-drawer__btn monaco-drawer__btn--close" onClick={closeMonaco}>
            <IconClose />
          </button>
        </div>
      </div>
      
      <div className="monaco-drawer__editor-wrapper" onKeyDown={handleEditorKeyDown}>
        {monacoOpen && (
          <Editor
            height="100%"
            language="glsl"
            theme="dalivid-dark"
            value={code}
            onChange={setCode}
            onMount={handleEditorDidMount}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
              fontLigatures: true,
              wordWrap: 'on',
              lineHeight: 22,
              padding: { top: 16, bottom: 16 },
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              cursorBlinking: 'smooth',
            }}
          />
        )}
      </div>
    </div>
  )
}
