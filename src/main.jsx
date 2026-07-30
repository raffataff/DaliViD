import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted webfonts. These replace a Google Fonts @import: that was a
// third-party origin in the critical path (blocked by our CSP), a render-blocking
// round trip, and an IP-address leak to Google on every visit. Vite fingerprints
// and bundles the woff2 files, so font-src 'self' covers them and the app works
// fully offline. Imported before index.css so the @font-face rules are in place
// when the design tokens that reference them are parsed.
import '@fontsource-variable/dm-sans'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import App from './App.jsx'
import React from 'react'

// Suppress harmless Monaco Editor cancelation errors caused by React 18 Strict Mode
window.addEventListener('unhandledrejection', (event) => {
  if (event.reason && event.reason.type === 'cancelation' && event.reason.msg === 'operation is manually canceled') {
    event.preventDefault();
  }
});


class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ color: 'red', padding: '20px', background: 'black', height: '100vh', boxSizing: 'border-box' }}>
          <h2>Something went wrong.</h2>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {this.state.error && this.state.error.toString()}
          </pre>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: '10px', color: '#ffaaaa' }}>
            {this.state.error && this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
