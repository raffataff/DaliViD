/**
 * SVG icon components used throughout DaliVid.
 * All icons are custom SVG — no emoji, no icon library.
 */

export function IconChevronDown({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4.5L6 7.5L9 4.5" />
    </svg>
  )
}

export function IconPlay({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor">
      <path d="M3.5 2.1L11.5 7L3.5 11.9V2.1Z" />
    </svg>
  )
}

export function IconPause({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor">
      <rect x="3" y="2" width="3" height="10" rx="0.5" />
      <rect x="8" y="2" width="3" height="10" rx="0.5" />
    </svg>
  )
}

export function IconSkipStart({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor">
      <rect x="2" y="3" width="2" height="8" rx="0.5" />
      <path d="M5 7L11 3V11L5 7Z" />
    </svg>
  )
}

export function IconSkipEnd({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor">
      <rect x="10" y="3" width="2" height="8" rx="0.5" />
      <path d="M9 7L3 3V11L9 7Z" />
    </svg>
  )
}

export function IconStepBack({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor">
      <rect x="2" y="3" width="1.5" height="8" rx="0.5" />
      <path d="M5 7L10 3.5V10.5L5 7Z" />
    </svg>
  )
}

export function IconStepForward({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor">
      <rect x="10.5" y="3" width="1.5" height="8" rx="0.5" />
      <path d="M9 7L4 3.5V10.5L9 7Z" />
    </svg>
  )
}

export function IconImportVideo({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M6.5 6L10 8L6.5 10V6Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconImportAudio({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6.5V9.5" /><path d="M5.5 5V11" /><path d="M8 4V12" />
      <path d="M10.5 5V11" /><path d="M13 6.5V9.5" />
    </svg>
  )
}

export function IconCamera({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="4" width="10" height="8" rx="1" />
      <path d="M11.5 6.5L14.5 5V11L11.5 9.5" />
    </svg>
  )
}

export function IconSave({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.5 14H3.5C2.95 14 2.5 13.55 2.5 13V3C2.5 2.45 2.95 2 3.5 2H10.5L13.5 5V13C13.5 13.55 13.05 14 12.5 14Z" />
      <path d="M5.5 14V9H10.5V14" />
      <path d="M5.5 2V5H9.5" />
    </svg>
  )
}

export function IconFolder({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4.5C2 3.95 2.45 3.5 3 3.5H6L7.5 5H13C13.55 5 14 5.45 14 6V12C14 12.55 13.55 13 13 13H3C2.45 13 2 12.55 2 12V4.5Z" />
    </svg>
  )
}

export function IconSettings({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7" cy="7" r="2" />
      <path d="M7 1.5V3M7 11V12.5M1.5 7H3M11 7H12.5M2.7 2.7L3.8 3.8M10.2 10.2L11.3 11.3M11.3 2.7L10.2 3.8M3.8 10.2L2.7 11.3" />
    </svg>
  )
}

export function IconEye({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 7C1 7 3 3 7 3C11 3 13 7 13 7C13 7 11 11 7 11C3 11 1 7 1 7Z" />
      <circle cx="7" cy="7" r="2" />
    </svg>
  )
}

export function IconCode({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 3.5L1.5 7L4.5 10.5" />
      <path d="M9.5 3.5L12.5 7L9.5 10.5" />
    </svg>
  )
}

export function IconClose({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" />
    </svg>
  )
}

export function IconPlus({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M7 3V11M3 7H11" />
    </svg>
  )
}

export function IconExport({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2V10M8 2L5 5M8 2L11 5" />
      <path d="M3 10V13H13V10" />
    </svg>
  )
}

export function IconLoop({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.5 3H4.5C3.12 3 2 4.12 2 5.5V6" />
      <path d="M3.5 11H9.5C10.88 11 12 9.88 12 8.5V8" />
      <path d="M9 1L11 3L9 5" />
      <path d="M5 9L3 11L5 13" />
    </svg>
  )
}

export function IconRecord({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="currentColor">
      <circle cx="7" cy="7" r="4" />
    </svg>
  )
}

export function IconAudioReactive({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <path d="M2 9V7M4.5 10V6M7 12V4M9.5 10V6M12 11V5M14 9V7" />
    </svg>
  )
}

export function IconScopes({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <path d="M2 10L5 6L8 9L11 4L14 8" />
    </svg>
  )
}

export function IconNewProject({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="2" width="10" height="12" rx="1" />
      <path d="M8 6V10M6 8H10" />
    </svg>
  )
}

export function IconFitWindow({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 5V2H4.5M9.5 2H12.5V5M12.5 9V12H9.5M4.5 12H1.5V9" />
    </svg>
  )
}

export function IconMute({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <path d="M6 2L3 4.5H1V7.5H3L6 10V2Z" fill="currentColor" opacity="0.3" />
      <path d="M9.5 4.5L11 6L9.5 7.5" />
    </svg>
  )
}

export function IconSolo({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <text x="2" y="9.5" fontSize="9" fontWeight="700" fill="currentColor" fontFamily="DM Sans, sans-serif">S</text>
    </svg>
  )
}

export function IconLock({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="5" width="7" height="5" rx="1" />
      <path d="M4 5V3.5C4 2.4 4.9 1.5 6 1.5C7.1 1.5 8 2.4 8 3.5V5" />
    </svg>
  )
}

export function IconNode({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="5" height="4" rx="1" />
      <rect x="9" y="9" width="5" height="4" rx="1" />
      <path d="M7 5H8C8.5 5 9 5.5 9 6V9" />
    </svg>
  )
}

export function IconTimeline({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M2 7H14" />
      <path d="M6 3V13" />
    </svg>
  )
}

export function IconShaderGenerate({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 2L12 12M12 2L2 12" />
      <circle cx="7" cy="7" r="2" />
      <path d="M7 2V4M7 10V12M2 7H4M10 7H12" strokeWidth="0.8" />
    </svg>
  )
}

export function IconLayers({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 2L2 5L7 12L12 5L7 2Z" />
      <path d="M2 9L7 12L12 9" />
    </svg>
  )
}

