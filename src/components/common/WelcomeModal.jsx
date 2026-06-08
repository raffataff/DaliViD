import { useState, useEffect } from 'react'
import { IconPlay, IconNode, IconTimeline, IconCode } from './Icons'
import './WelcomeModal.css'

export default function WelcomeModal() {
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    const hasSeenWelcome = localStorage.getItem('dalivid_welcome_seen')
    if (!hasSeenWelcome) {
      setIsOpen(true)
    }
  }, [])

  const handleClose = () => {
    localStorage.setItem('dalivid_welcome_seen', 'true')
    setIsOpen(false)
  }

  if (!isOpen) return null

  return (
    <div className="welcome-modal__backdrop">
      <div className="welcome-modal__content">
        <h1 className="welcome-modal__title">Welcome to DaliViD</h1>
        <p className="welcome-modal__subtitle">Professional-grade, browser-based video editing & real-time shader processing.</p>
        
        <div className="welcome-modal__features">
          <div className="welcome-modal__feature">
            <div className="welcome-modal__feature-icon"><IconTimeline /></div>
            <div>
              <h3>Multi-Track Timeline</h3>
              <p>Import video/audio, split clips (S), and arrange them. Real-time compositing.</p>
            </div>
          </div>
          <div className="welcome-modal__feature">
            <div className="welcome-modal__feature-icon"><IconNode /></div>
            <div>
              <h3>Node-Based Effects</h3>
              <p>Right-click in the Node Editor to add effects. Chain them up to build complex visuals.</p>
            </div>
          </div>
          <div className="welcome-modal__feature">
            <div className="welcome-modal__feature-icon"><IconPlay /></div>
            <div>
              <h3>Audio Reactive</h3>
              <p>Built-in 8-band FFT. Connect shader parameters to audio frequencies for dynamic reactivity.</p>
            </div>
          </div>
          <div className="welcome-modal__feature">
            <div className="welcome-modal__feature-icon"><IconCode /></div>
            <div>
              <h3>Custom GLSL</h3>
              <p>Write your own WebGL2 fragment shaders directly in the browser and see them instantly.</p>
            </div>
          </div>
        </div>

        <div className="welcome-modal__footer">
          <span className="text-muted" style={{ fontSize: '11px' }}>Press <strong>Shift + ?</strong> anytime for shortcuts</span>
          <button className="welcome-modal__btn" onClick={handleClose}>Get Started</button>
        </div>
      </div>
    </div>
  )
}
