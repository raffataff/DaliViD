/* eslint-disable react-refresh/only-export-components */
import { useState, useCallback, useEffect } from 'react'
import './Toast.css'

/**
 * Toast notification system.
 * Usage: addToast({ message, type, duration })
 */

let toastId = 0
let toastListener = null

/** External API — call from anywhere */
export function addToast({ message, type = 'info', duration = 3000 }) {
  if (toastListener) {
    toastListener({ id: ++toastId, message, type, duration })
  }
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState([])

  useEffect(() => {
    toastListener = (toast) => {
      setToasts(prev => [...prev, toast])
      if (toast.duration > 0) {
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== toast.id))
        }, toast.duration)
      }
    }
    return () => { toastListener = null }
  }, [])

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className="toast-container">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`toast toast--${toast.type}`}
          onClick={() => removeToast(toast.id)}
        >
          <span className="toast__icon">
            {toast.type === 'error' ? '✕' :
             toast.type === 'success' ? '✓' :
             toast.type === 'warning' ? '⚠' : 'ℹ'}
          </span>
          <span className="toast__message">{toast.message}</span>
        </div>
      ))}
    </div>
  )
}
