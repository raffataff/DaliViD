# The Vault — storage contract

**Authoritative.** `PLAN_Persistence.md` is the roadmap and the reasoning; this file is the
interface. Where the two disagree, this one is right and the plan needs updating.

The vault is where a project and its media live. There are two backends — OPFS in the browser,
the filesystem behind IPC on desktop — and exactly one interface over them, because a web build
and a desktop build that drift are two products.

---

## The one rule

> **Authority lives in the trusted process. The renderer holds identifiers, never paths.**

Everything else here follows from that line. The renderer is where every npm dependency executes;
it is given ids that name *bytes*, never strings that name *places*. On the web there is no
authority to hold at all — OPFS is origin-scoped, so the browser enforces it for us.

This is why `showDirectoryPicker` is not coming back. It granted recursive read+write over a
user-chosen tree, to the renderer, persisted invisibly to IndexedDB. `purgeStoredFolderHandles()`
cleans up the ones that shipped. **Keep that function forever.**

---

## Layout

```
src/storage/
  VAULT.md          this file — the contract
  hash.js           content addressing: hashBytes, headTailSig          ✅ phase 0
  mediaRef.js       the MediaRef type: create / strip / guards          ✅ phase 0
  schema.js         v2 shape, validateProject, migrateV1toV2           ✅ phase 0
  nodeTypes.js      the node-type whitelist the validator checks        ✅ phase 0
  index.js          picks a backend at boot; exports the `vault`        ✅ phase 1
  projectStore.js   project CRUD, atomic write, backup rotation         ✅ phase 1
  webVault.js       OPFS blobs + generic file API                       ✅ phase 1/2
  desktopVault.js   thin proxy over window.dalivid.*                    ▢ phase 3
```

`projectStore`, `mediaRef` and `schema` hold all the *logic* and are backend-agnostic.
`webVault` and `desktopVault` are dumb byte-movers. That split is what stops the two versions
diverging — and it is why phase 0 is not throwaway work for a Steam decision that may never
happen.

---

## Interface

```js
// ── Projects ──────────────────────────────────────────────────────────────
listProjects()                 -> ProjectSummary[]        // {id, name, savedAt, bytes}
readProject(id)                -> ProjectDoc
writeProject(id, doc)          -> {savedAt, bytes}        // ATOMIC. never partial.
deleteProject(id)              -> void
listBackups(id)                -> Backup[]                // {backupId, savedAt, bytes}
restoreBackup(id, backupId)    -> ProjectDoc

// ── Blobs (content-addressed; media AND fonts share this) ─────────────────
putBlob(bytes, meta)           -> {hash, bytes, deduped}
statBlob(hash)                 -> {bytes, mime} | null
getBlobBytes(hash)             -> ArrayBuffer             // SMALL things only (fonts)
getPlaybackURL(refId)          -> string                  // never loads the file into memory
deleteBlob(hash)               -> void
gcBlobs(reachableHashes)       -> {deleted, freed}

// ── External references (desktop only; throws UnsupportedError on web) ────
pickFiles({kinds})             -> MediaRef[]
statRefs(refIds)               -> {refId: 'ok'|'missing'|'changed'}
repairRefs(refIds)             -> {refId: MediaRef}
adoptRef(refId)                -> MediaRef                // copy a link-mode ref into the vault
forgetRef(refId)               -> void

// ── Capability + housekeeping ─────────────────────────────────────────────
capabilities()                 -> {link, nativeDialogs, streamingExport,
                                   persisted, quotaBytes}
usage()                        -> {projects, blobs, total, quota}
```

`capabilities()` is how the UI decides what to offer. **No `if (isElectron)` scattered through
components** — one capability check, read from the store.

---

## MediaRef

What a clip stores instead of a `blob:` URL, and the only handle on media the renderer is given.

```js
{
  id:       'mr_a1b2c3d4e5f6',   // opaque. `mr_` + hash. the ONLY thing the renderer holds.
  mode:     'vault' | 'link',    // copied into our storage, or referenced where it lives
  hash:     'a1b2c3d4e5f6',      // SHA-256[0..10) — the same scheme fonts already use
  filename: 'beach.mp4',         // display + legacy relink-by-name bridge
  kind:     'video'|'audio'|'image',
  mime:     'video/mp4',
  bytes:    184213504,
  addedAt:  1786571117892,

  // ── link mode only. NEVER in a project document, NEVER sent to the renderer. ──
  path:     'E:\\Footage\\beach.mp4',
  mtimeMs:  1786571117892,
  sig:      '…',                 // headTailSig — drift detection
}
```

- **`id` is derived from `hash`**, so importing the same file twice yields one ref and one stored
  copy. Dedup falls out of the naming; there is no dedup pass.
- **`stripRefPath(ref)` is the gate.** Everything that serialises a ref or sends it across a
  process boundary goes through it. The validator asserts the gate was used: a document carrying
  `path` / `mtimeMs` / `sig` is an **error**, not a warning.
- **`sig` is drift detection, not authentication.** SHA-256 of `[first 1 MiB][last 1 MiB][size]`:
  O(2 MiB) whatever the file size, and it catches the case size+mtime misses — a *different* file
  that has taken the same name and path. Nothing trusts it with a security decision.
- **`filename` stays on clips forever.** It is the downgrade path (a v2 project in a v1 build
  falls back to relink-by-name and loses the refs, not the edit) and the fallback when a ref
  cannot be resolved. Costs nothing. Do not remove it.

---

## Playback

`getPlaybackURL(refId)` returns something an `<video>`/`<audio>` element can use, and never loads
the file into renderer memory.

- **Web** — a `blob:` URL made from an OPFS `File`. Still resident, but *recreatable after a
  reload*, which is the entire point. Create lazily on first use; revoke when the clip leaves
  the timeline.
- **Desktop** — `dalivid-media://<refId>`, resolved through the open project's ref table and
  streamed with **Range support** (`206`, `Content-Range`, `Accept-Ranges`). Range handling is not
  optional: without it `<video>` cannot seek, and scrubbing a timeline is nothing but seeking.

---

## Validation

`validateProject(doc, { untrusted })` returns `{ ok, errors, warnings }`. Two severities, because
one forces a choice between rejecting projects that should open and accepting ones that should not.

| | Meaning | Action |
|---|---|---|
| **error** | malformed, unsafe, or would not load | reject |
| **warning** | loads, but something is inconsistent (dangling track, unresolved ref) | report, open |

`untrusted: true` on the **import** path (a `.dalivid.json` from outside). It promotes an unknown
node `type` from warning to error — an unrecognised type must not reach the compiler when the
document came from elsewhere, but a project written by a *newer* build must still open in an
older one.

**Strictness is top-level only.** Unknown top-level keys are rejected; unknown keys *nested*
inside are ignored. Rejecting nested unknowns would make every field the app adds in future a
document that older builds refuse to open — the same forward-compatibility trap `filename` exists
to avoid.

---

## Schema v2

v2 changes two things, both about media, neither touching the edit:

```js
{
  version: 2,
  media: { refs: [ MediaRef, … ] },        // NEW — the pool, which today doesn't persist at all
  timeline: {
    clips: [{
      mediaRefId: 'mr_a1b2c3',             // NEW — null until the media is ingested
      filename:   'beach.mp4',             // KEPT — forever
      params: { imageRefId: 'mr_f00ba7' }, // NEW — replaces the inlined base64 `imageSrc`
    }],
  },
}
```

**Link-mode paths are not in the document.** A `.dalivid.json` you email someone should not leak
your directory structure, and a project file is untrusted input on the way back in. The trusted
process keeps `refs.json` alongside the project, mapping `refId → {path, mtimeMs, sig}`. Send
someone a project and every link ref reports `missing` on their machine, and the repair flow
handles it. That is correct behaviour.

### Migration

`migrateV1toV2(doc)` is **pure and idempotent**: it adds `media.refs: []` and `mediaRefId: null`,
and nothing else. The project then opens exactly as it does today, with the existing relink
prompt. The user relinks once; those files become MediaRefs; that is the last relink that project
ever needs.

Inline images need bytes written to storage, so they are split into two pure halves with the
storage layer in the middle:

```js
const pending = collectInlineImages(doc)              // [{ dataUrl, at }]
const map = new Map()                                 // ← phase 2: putBlob each one
for (const { dataUrl } of pending) map.set(dataUrl, await ingestDataURL(dataUrl))
const v2 = replaceInlineImages(doc, map)
```

This is what keeps schema validation runnable in a Worker, in `node --test`, and later in the
Electron main process, where none of the browser image APIs exist.

### ⚠ Web → desktop is a different origin

The desktop build serves from `app://`, which cannot see `https://raffataff.github.io/DaliViD/`'s
IndexedDB. Origin isolation is doing its job and there is no workaround. The migration path is
an explicit **"Export all projects…"** on web and **"Import from DaliViD Web"** on desktop, and
it must be *built*, not assumed. A user who installs the desktop version and finds an empty
project list will assume the app ate their work.

---

## Rules for the desktop IPC layer (phase 3+)

Written down now so phase 3 does not have to re-derive them.

1. **No handler accepts a filesystem path from the renderer.** Paths travel main → renderer as
   display strings only. This is the single rule the design rests on.
2. **Every id is validated by regex, then resolved through a Map** — never string-concatenated
   into a path. `mr_[0-9a-f]{4,32}`, `sink_[0-9a-f]{16}`, project ids are UUIDs.
3. **Every dialog opens in main**, in response to a call originating from a user gesture.
4. **`project:write` validates against the schema before touching disk.** A doc that fails is
   rejected with an error the UI can show, not written.
5. **Size caps on everything.** `sink:write` chunk ≤ 8 MiB, `media:put` ≤ 2 GiB, document ≤ 256 MiB
   (`LIMITS` in `schema.js`).
6. **Handlers are `async` and never throw raw.** Return `{ok:false, code, message}` — an unhandled
   rejection in main is a crash, and a crash mid-export loses the export.

## Atomic write (phase 1)

```
writeProject(id, doc):
  validate(doc)                              // reject before any I/O
  bytes = JSON.stringify(doc)
  write(tmp); fsync(tmp); close(tmp)
  if exists(project.json) and newestBackupAge > 5min:  copy → backups/<ISO8601>.json
  rename(tmp → project.json)                 // atomic on NTFS, ext4, APFS
  prune backups: keep last 10, plus one per day for 7 days
```

- **Windows:** `fs.rename` over an existing file can fail `EPERM` when an antivirus or indexer
  holds the target open. Retry 3× at 50/150/400 ms before surfacing an error. This *will* happen
  in the wild.
- **OPFS:** `FileSystemFileHandle.move()` gives the same rename. Where it is missing, use A/B
  slots — `project.a.json`, `project.b.json`, and a `current` file naming the good one.
