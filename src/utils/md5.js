/**
 * DaliVid — Lightweight MD5 hash for shader source caching.
 * Used to avoid redundant shader recompilation.
 */

export function md5(str) {
  // Fast 32-bit hash (FNV-1a variant) — sufficient for shader cache keys
  // Not cryptographic, but fast and collision-resistant enough for caching
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  // Convert to hex string
  return hash.toString(16).padStart(8, '0')
}

/**
 * More thorough hash for cases where collision avoidance matters more.
 * Uses a combination of two FNV hashes to reduce collision probability.
 */
export function md5Full(str) {
  let h1 = 0x811c9dc5
  let h2 = 0xcbf29ce4
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    h1 ^= c
    h1 = (h1 * 0x01000193) >>> 0
    h2 ^= c
    h2 = (h2 * 0x100000001b3) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}
