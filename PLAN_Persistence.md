# PLAN — Persistent Storage, Media References & the Desktop Shell

**Status:** phases 0, 1, 2 done — the whole web half. Phase 3+ (Electron) is the next commitment point. · **Owner:** Jonn · **Created:** 2026-08-20 · **Last worked:** 2026-08-26
**Supersedes:** the "Folder linking REMOVED outright" section of `CLAUDE.md` — this plan
brings the *capability* back without bringing the *authority* back. Read that section first;
it explains why the current model exists, and this plan only makes sense against it.

---

## How to work through this document

This is designed to be picked up cold by a future session.

1. Read `CLAUDE.md` first (architecture + the persistence history), then this file.
2. Phases are **ordered and individually shippable**. Do not start phase N+1 until phase N's
   "Done when" list is fully ticked. Every phase leaves the app in a working, releasable state.
3. Phases 0–2 are **pure web work** and deliver most of the user-facing value. Electron does not
   appear until phase 3. If the Steam idea is dropped tomorrow, phases 0–2 are still worth doing.
4. Tick the `- [ ]` boxes as you go and leave a one-line note under any task you changed your mind
   about. This file is the working record, not a pitch document.
5. Each phase ends with a **Verify** block. Actually run it. Several failure modes here
   (torn writes, quota exhaustion, range-request seeking) are invisible until they cost a user a day.

---

## 1. The problem, stated precisely

### What persists today

| Thing | Where | Survives reload? |
|---|---|---|
| Timeline, graphs, project settings | IndexedDB (`dalivid_project_<id>`, `dalivid_autosave`) | ✅ |
| Custom fonts (bytes) | IndexedDB, content-addressed `dalivid_font_<hash>` | ✅ |
| Panel sizes | `localStorage` | ✅ |
| **Media Pool entries** | React `useState` in `MediaPool.jsx` | ❌ gone |
| **Video / audio bytes** | nowhere — a `blob:` URL from a one-shot `<input type=file>` | ❌ gone |
| **Images** | base64 data URL inlined into `clip.params` | ⚠️ persists, but see below |

So: the *edit* survives, the *media* does not. Every session begins with a relink, and the relink
matches **by filename only** — two different `intro.mp4` files are indistinguishable, and a renamed
file is unrecoverable.

### Three distinct defects, not one

1. **No media persistence.** The core complaint. Blob URLs are session-scoped by definition.
2. **Images are the wrong shape.** `prepareImageDataURL` inlines a downscaled base64 image into
   `clip.params.imageSrc`. Autosave then re-serialises the entire project — including every one of
   those base64 blobs — on a 2-second debounce, on every keystroke in a text field. A project with
   ten images is doing megabytes of `JSON.stringify` + IndexedDB write per edit. This is both a
   persistence bug and the app's largest avoidable stall.
3. **The write is not atomic.** `saveProject` does `idbSet(key, data)`. `idb-keyval` wraps a single
   IDB transaction so a crash *mid-transaction* rolls back — that part is fine — but the design has
   no generational history at all. One bad serialise (a NaN, a cyclic ref introduced by a future
   node type, an OOM on a huge project) overwrites the only good copy. There is no previous version
   to fall back to.

### And one lurking one

**IndexedDB is evictable.** `requestPersistentStorage()` mitigates it, and Chrome usually grants it
for an engaged origin, but a refusal is silent and the user is never told their only copy is
best-effort. Under storage pressure the browser is within its rights to delete everything.

---

## 2. The security position

This is the part that must not be got wrong, because it is the reason folder linking was removed.

### Why the old design was bad

```js
showDirectoryPicker({ mode: 'readwrite' })   // → recursive read+write over a whole tree
idbSet(`project_folder_${id}`, handle)       // → that grant now outlives the session, invisibly
```

Two compounding problems:

- **The grant was ambient.** Recursive read+write over an arbitrary user directory, held by the
  *renderer* — the same context where every npm dependency executes. One malicious transitive
  dependency, one XSS through a crafted project file, and the attacker has the user's Documents tree.
- **The grant was invisible.** Persisted to IndexedDB, so it survived reloads with no UI to see or
  revoke it. The user consented once, months ago, to something they can no longer inspect.

`purgeStoredFolderHandles()` exists precisely to clean these up. Keep it forever.

### The principle going forward

> **Authority lives in the trusted process. The renderer holds identifiers, never paths.**

Everything below follows from that one line.

| | Old (removed) | New |
|---|---|---|
| Who holds the grant | renderer | main process (desktop) / nobody (web, OPFS is origin-scoped) |
| Shape of the grant | directory, recursive, read+write | one file, read-only, per reference |
| Revocable | no | yes — remove the ref, the capability is gone |
| Visible to user | no | yes — Project Media panel lists every reference and its path |
| Renderer sees a path | yes | **never** — only opaque `mr_<hash>` ids |
| Blast radius of a compromised renderer | user's Documents tree | the currently-open project's own files |

Note the third row of the last column: this is **stronger than the app is today**. Today the
renderer can call `showSaveFilePicker` directly. Under this design it cannot — it asks main to open
a dialog, and gets back a sink id.

### Threat model, explicitly

| Threat | Mitigation | Phase |
|---|---|---|
| Malicious npm dependency exfiltrates media | CSP `connect-src` (already); renderer has no fs access; desktop network egress deniable at main | 3, 6 |
| Malicious dependency destroys user files | Renderer holds no paths; main validates every id against a registry; refs are read-only | 3, 4 |
| Crafted `.dalivid.json` executes code | Strict schema validation before deserialise; **no project-supplied string is ever eval'd or passed to a shader compile without going through the existing node type whitelist** | 0, 6 |
| Crafted `.dalivid.json` writes outside the vault | All paths are constructed in main from an id; the doc never carries a path | 0, 3 |
| Torn write loses a project | tmp + fsync + atomic rename; backup rotation | 1 |
| Silent eviction loses everything | OPFS + `persist()` + honest UI when persist is refused | 1 |
| Path traversal via ref id | Ids match `/^mr_[0-9a-f]{4,32}$/`, resolved through a Map, never concatenated | 3, 4 |
| Media protocol serves arbitrary files | `dalivid-media://` resolves ids through the open project's ref table only; 404 otherwise | 4 |

### On supply chain (the "GitHub security" question)

Hardening the repo helps, but understand what changes when you ship a binary: **in the browser, a
malicious dependency is contained by the origin sandbox. In Electron it is not.** The renderer stays
sandboxed under this design, which is most of the answer — but the build pipeline itself becomes a
distribution channel for signed executables. Treat it accordingly (phase 6).

---

## 3. Architecture

### 3.1 One interface, two backends

```
src/storage/
  index.js          picks a backend at boot; exports the singleton `vault`
  VAULT.md          the contract, documented once, authoritative
  webVault.js       OPFS + IndexedDB
  desktopVault.js   thin proxy over window.dalivid.*  (no logic of its own)
  projectStore.js   project CRUD, atomic write, backup rotation  (backend-agnostic)
  mediaRef.js       MediaRef create / resolve / repair            (backend-agnostic)
  schema.js         v2 schema + validator + v1→v2 migration
  hash.js           moved out of fontRegistry; shared by fonts and media
```

`projectStore` and `mediaRef` contain all the *logic* and are backend-agnostic. `webVault` and
`desktopVault` are dumb byte-movers. This is what stops the two versions diverging, and it means
phases 0–2 are not throwaway work.

### 3.2 The Vault contract

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
getPlaybackURL(refId)          -> string                  // see 3.4 — never loads into memory
deleteBlob(hash)               -> void
gcBlobs(reachableHashes)       -> {deleted, freed}

// ── External references (desktop only; throws UnsupportedError on web) ────
pickFiles({kinds})             -> MediaRef[]
statRefs(refIds)               -> {refId: 'ok'|'missing'|'changed'}
repairRefs(refIds)             -> {refId: MediaRef}
adoptRef(refId)                -> MediaRef                // copy a link-mode ref into the vault
forgetRef(refId)               -> void

// ── Capability + housekeeping ─────────────────────────────────────────────
capabilities()                 -> {link: bool, nativeDialogs: bool, streamingExport: bool,
                                   persisted: bool, quotaBytes: number|null}
usage()                        -> {projects, blobs, total, quota}
```

`capabilities()` is how the UI decides what to offer. No `if (isElectron)` scattered through
components — one capability check, read from the store.

### 3.3 MediaRef — the load-bearing type

```js
{
  id:        'mr_a1b2c3d4e5f6',   // what clips store. opaque. the ONLY thing the renderer holds.
  mode:      'vault' | 'link',    // copied into our storage, or referenced where it lives
  hash:      'a1b2c3d4e5f6',      // SHA-256[0..10) — same scheme as fontRegistry.hashBuffer
  filename:  'beach.mp4',         // display + legacy relink-by-name bridge
  kind:      'video'|'audio'|'image',
  mime:      'video/mp4',
  bytes:     184213504,
  addedAt:   1786571117892,

  // ── link mode only. NEVER present in vault mode, never sent to the renderer. ──
  path:      'E:\\Footage\\beach.mp4',
  mtimeMs:   1786571117892,
  sig:       '…',   // integrity signature, see below
}
```

**Why a head/tail signature rather than a full hash.** Hashing a 4 GB file at import is 20–40 s of
disk I/O and stalls the import. `sig` = SHA-256 of `[first 1 MiB][last 1 MiB][size as u64]`. Cost is
O(2 MiB) regardless of file size, and it catches the case a size-and-mtime check misses: a
*different* file that has taken the same name and path. It is not adversary-proof, and does not need
to be — it is drift detection, not authentication.

**Clips keep `filename`.** `clip.mediaRefId` is added; `clip.filename` stays populated forever. That
is what lets a v2 project degrade gracefully in an older build, and what keeps the existing
`relinkMediaFromFiles` path alive as a fallback.

### 3.4 Playback without loading the file

Today: `URL.createObjectURL(file)` → a `blob:` URL. The whole `File` is held by the page. For a
handful of clips that is fine; for a real edit it is a memory problem, and it is *why* media cannot
persist (a `blob:` URL is meaningless after reload).

- **Web (`webVault`)** — `getPlaybackURL` returns a `blob:` URL created from an OPFS `File` object.
  Still resident, but now *recreatable on demand* after a reload, which is the whole point. Create
  lazily on first use, revoke when the clip leaves the timeline.
- **Desktop (`desktopVault`)** — returns `dalivid-media://<refId>`. Main registers the scheme as
  privileged (`standard`, `secure`, `supportFetchAPI`, `stream`, `corsEnabled`) **before** `app.whenReady()`,
  then `protocol.handle('dalivid-media', …)` looks the id up in the open project's ref table and
  streams the file with **Range support** (`206`, `Content-Range`, `Accept-Ranges: bytes`).

  Range handling is not optional. Without it `<video>` cannot seek, and scrubbing a timeline is
  nothing but seeking. Get this right in phase 4 or the desktop build will feel broken.

  Nothing is loaded into renderer memory, ever. A 40 GB source costs the same as a 40 MB one.

---

## 4. Project schema v2

```js
{
  version: 2,                      // was 1
  savedAt: '…',

  project: { …unchanged… },

  media: {                         // NEW — the pool, which today doesn't persist at all
    refs: [ MediaRef, … ]          // link-mode refs are stored WITHOUT `path` in the doc;
  },                               // main keeps the path→id table in its own sidecar file

  timeline: {
    clips: [{
      …unchanged…,
      mediaRefId: 'mr_a1b2c3',     // NEW
      filename: 'beach.mp4',       // KEPT — do not remove, ever
      params: {
        imageSrc: undefined,       // REMOVED in v2 → replaced by:
        imageRefId: 'mr_f00ba7',   // NEW
      },
    }],
  },

  graph:  { …unchanged… },
  fonts:  [ …unchanged… ],         // already content-addressed; the model this plan copies
  ui:     { …unchanged… },
}
```

**Where link-mode paths live.** Not in the project document. A `.dalivid.json` you email someone
should not leak your directory structure, and a project file is untrusted input on the way back in.
Main keeps `<vault>/projects/<id>/refs.json` alongside, mapping `refId → {path, mtimeMs, sig}`. Send
someone a project file and they get refs with no paths — every one reports `missing`, and the
existing repair flow handles it. That is the correct behaviour.

### Migration v1 → v2

Runs in `schema.js`, idempotent, on load:

1. `version === 1` → set `mediaRefId: null` on every clip. `filename` already present. **Do nothing
   else.** The project opens exactly as it does today and shows the existing relink prompt.
2. The user relinks once, through the existing flow. Those files are ingested as MediaRefs and
   written into `media.refs`. **This is the last relink that project will ever need.**
3. Any `clip.params.imageSrc` that is a data URL → decode, `putBlob`, replace with `imageRefId`.
   One-time, per project, on first v2 save. This alone will noticeably speed up autosave.
4. Write `version: 2`.

**Downgrade:** a v2 project opened by a v1 build finds `filename` intact and falls back to
relink-by-name. It loses the refs, not the edit. Acceptable.

### ⚠ The web → desktop migration gotcha

The desktop app will serve its bundle from a custom `app://` origin (see 5.1). **That is a different
origin from `https://raffataff.github.io/DaliViD/`, so the desktop build cannot see the web build's
IndexedDB.** There is no clever workaround; origin isolation is doing its job.

The migration path is therefore explicit and must be built, not assumed:
- Web build gains **"Export all projects…"** → one `.dalividpkg` containing every project + its vault blobs.
- Desktop build gains **"Import from DaliViD Web"** in the welcome flow, pointing at that file.
- Say this in the desktop app's first-run screen. A user who installs the desktop version and finds
  an empty project list will assume the app ate their work.

---

## 5. The Electron shell

### 5.1 Window and process configuration

```js
// main.cjs — before app.whenReady()
protocol.registerSchemesAsPrivileged([
  { scheme: 'app',           privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'dalivid-media', privileges: { standard: true, secure: true, supportFetchAPI: true,
                                           stream: true, corsEnabled: true } },
])

new BrowserWindow({
  webPreferences: {
    contextIsolation: true,     // non-negotiable
    nodeIntegration: false,     // non-negotiable
    sandbox: true,              // non-negotiable
    webSecurity: true,          // non-negotiable
    preload: path.join(__dirname, 'preload.cjs'),
    backgroundThrottling: false,   // a paused-in-background render loop stalls exports
  },
})
```

**Serve from `app://dalivid/`, not `file://`.** `file://` gives an opaque origin, breaks
origin-scoped storage in confusing ways, and makes the CSP behave differently from the web build.
A registered standard+secure scheme gives you one stable origin, working ES modules, and
`crypto.subtle`. Vite's existing `base: './'` already emits the relative URLs this needs.

**Lock down navigation** in `app.on('web-contents-created')`:
```js
contents.setWindowOpenHandler(() => ({ action: 'deny' }))   // then shell.openExternal for allowlisted https
contents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault() })
contents.on('will-attach-webview', (e) => e.preventDefault())
```

**Tighten the CSP for the packaged build.** `vite.config.js` currently widens `connect-src` by
`fonts.googleapis.com` + `fonts.gstatic.com` for the Google Fonts importer. On desktop, route that
fetch through main (`net.fetch`) and hand the bytes back over IPC — then the renderer CSP drops back
to `connect-src 'self' blob: data:` with no exceptions at all. Cleanest win available in this phase.

### 5.2 The preload bridge

One frozen object. No `ipcRenderer` escape hatch, no generic `invoke(channel, …)` passthrough — a
generic passthrough hands the renderer the entire IPC surface and undoes the whole design.

```js
// preload.cjs
const { contextBridge, ipcRenderer } = require('electron')
const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args)

contextBridge.exposeInMainWorld('dalivid', Object.freeze({
  version: process.versions.electron,
  project: Object.freeze({
    list: call('project:list'),   read: call('project:read'),
    write: call('project:write'), delete: call('project:delete'),
    backups: call('project:backups'), restore: call('project:restore'),
    reveal: call('project:reveal'),
    exportPackage: call('project:exportPackage'),
    importPackage: call('project:importPackage'),
  }),
  media: Object.freeze({
    pick: call('media:pick'),     stat: call('media:stat'),
    repair: call('media:repair'), adopt: call('media:adopt'),
    forget: call('media:forget'), gc: call('media:gc'),
    put: call('media:put'),                  // bytes → vault (recordings, generated frames)
  }),
  sink: Object.freeze({                      // replaces showSaveFilePicker
    open: call('sink:open'), write: call('sink:write'), close: call('sink:close'),
    abort: call('sink:abort'),
  }),
  app: Object.freeze({ paths: call('app:paths'), usage: call('app:usage'),
                       chooseVaultRoot: call('app:chooseVaultRoot') }),
}))
```

### 5.3 Rules for every IPC handler — no exceptions

1. **No handler accepts a filesystem path from the renderer.** Paths travel main → renderer as
   display strings only. This is the single rule that makes the design work.
2. **Every id is validated by regex, then resolved through a Map.** Never string-concatenated into a
   path. `mr_[0-9a-f]{4,32}`, `sink_[0-9a-f]{16}`, project ids are UUIDs.
3. **Every dialog opens in main**, in response to a call originating from a user gesture.
4. **`project:write` validates against the schema before touching disk.** A doc that fails
   validation is rejected with an error the UI can show, not written.
5. **Size caps on everything.** `sink:write` chunk ≤ 8 MiB, `media:put` ≤ 2 GiB, project doc ≤ 256 MiB.
6. **Handlers are `async` and never throw raw.** Return `{ok:false, code, message}`; an unhandled
   rejection in main is a crash, and a crash mid-export loses the export.

### 5.4 Atomic write

```
writeProject(id, doc):
  validate(doc)                              // reject before any I/O
  bytes = JSON.stringify(doc)
  tmp   = <vault>/projects/<id>/project.json.tmp
  write(tmp, bytes); fsync(tmp); close(tmp)
  if exists(project.json) and newestBackupAge > 5min:
      copy(project.json → backups/<ISO8601>.json)
  rename(tmp → project.json)                 // atomic on NTFS, ext4, APFS
  try { fsync(dirfd) } catch {}              // POSIX only; no-op on Windows
  prune backups: keep last 10, plus one per day for 7 days
```

**Windows caveat:** `fs.rename` over an existing file uses `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`
and can fail `EPERM` when an antivirus or indexer has the target open. Retry 3× with 50/150/400 ms
backoff before surfacing an error. This *will* happen in the wild; handle it or it becomes a bug
report you cannot reproduce.

**OPFS equivalent:** `FileSystemFileHandle.move()` (Chrome 111+) gives the same rename. Where it is
missing, use A/B slots — `project.a.json`, `project.b.json`, and a tiny `current` file naming the
good one. Write the inactive slot, fsync-equivalent (`close()` the writable), then flip `current`.
Recoverable from any interruption.

---

## 6. Phases

> **Order changed 2026-08-26 (agreed): 0 → 2 → 1**, not 0 → 1 → 2.
>
> Phase 2 is the actual complaint — media does not survive a reload. Phase 1 rewrites the one
> part that already works (projects persist fine through `idbSet` today) and fixes no
> user-visible fault; it is the highest-risk task in the web half and it can wait.
>
> **Phase 2 does not depend on phase 1.** It needs `putBlob` / `getPlaybackURL` / `gcBlobs` — the
> *blob* half of `webVault`. The project document can stay in IndexedDB carrying `media.refs`
> until phase 1 moves it. That the swap costs nothing later is exactly what the backend-agnostic
> split in §3.1 is for; if it turns out to cost something, the split is wrong, and that is worth
> finding out now rather than after phase 1 has been built on top of it.
>
> Phase 1's checklist is unchanged — only its position moved.

### Phase 0 — Groundwork · *no user-visible change* — **DONE 2026-08-26**

- [x] Create `src/storage/`, write `VAULT.md` (the contract from §3.2) as the authoritative doc.
- [x] Move `hashBuffer` from `fontRegistry.js` → `src/storage/hash.js`; re-export so nothing breaks.
      Add `headTailSig(fileOrBytes)`.
      > *Not re-exported.* `hashBuffer` was **private** to `fontRegistry` — nothing outside it ever
      > imported it — so a re-export would have been new public surface with no consumer.
      > `fontRegistry` imports it as `hashBytes as hashBuffer` and its single call site is
      > unchanged. A regression test in `test/hash.test.js` pins the output against the pre-move
      > implementation *verbatim*: every custom font a user has imported is stored under
      > `dalivid_font_<hash>` and referenced from projects as `custom:<hash>`, so a drift in this
      > algorithm orphans all of them — the bytes are still on disk and nothing can find them.
- [x] `src/storage/schema.js`: v2 shape, `validateProject(doc)`, `migrateV1toV2(doc)`.
      Validator is **structural and strict** — unknown top-level keys rejected, every node `type`
      checked against the registry, no string longer than a sane cap.
      > **Three deviations, each load-bearing.**
      > 1. **Two severities, not one.** `validateProject` returns `{ok, errors, warnings}`. A single
      >    severity forces a choice between rejecting projects that should open and accepting ones
      >    that should not. Dangling refs and clips on missing tracks are *warnings* — recoverable,
      >    and refusing to open the project is the worse outcome. Malformed ids, a broken spine,
      >    and **any local-only field present in the document** are errors.
      > 2. **An `untrusted` flag** sets the severity of an unknown node `type`. Reading our own
      >    vault it is a warning — a project written by a *newer* build must still open in an older
      >    one. On the import path (phase 6) it is an error: an unrecognised type must not reach the
      >    compiler when the bytes came from outside. One flag, set by the caller who knows the
      >    provenance.
      > 3. **Strictness is top-level only.** Rejecting unknown keys *nested* inside would make every
      >    field the app adds in future a document that older builds refuse to open — the same
      >    forward-compatibility trap `clip.filename` exists to avoid.
      >
      > The string cap is **per-field**, not global (`LIMITS` in `schema.js`). One cap large enough
      > for a legitimately-huge v1 inline image would not constrain a project *name* at all, which
      > is the whole point of having one. Three tiers: ordinary strings 64 KiB, shader source
      > 1 MiB, data URLs 32 MiB.
      >
      > The node-type whitelist lives in its own `src/storage/nodeTypes.js`, assembled from
      > `NODE_DEFS` + `getRegisteredTypes()` + `COMPOUND` + legacy `TIME` rather than hand-written
      > (a hand-written list goes stale the first time someone adds a node, and the symptom is a
      > valid project refusing to open). Split out so `schema.js` stays importable by a Worker, a
      > test, and the future main process without dragging megabytes of GLSL string literals along;
      > overridable via `opts.knownNodeTypes`. **`COMPOUND` and `TIME` are both easy to miss and
      > both fatal:** `COMPOUND` has no `NODE_DEFS` entry at all (its sockets come from its own
      > sub-graph), and `TIME` is still present in saved projects until `migrateGraphNodes` rewrites
      > it — which happens *after* the point validation would run.
- [x] `src/storage/mediaRef.js`: `createRef`, `refKey`, type guards. Pure, no I/O.
      > `id` is **derived from the hash** (`mr_<hash>`), so importing the same file twice yields one
      > ref and therefore one stored copy — dedup falls out of the naming and there is no dedup
      > pass. `stripRefPath` is the single gate for `path`/`mtimeMs`/`sig`, and `createRef`
      > **throws** if a vault-mode ref is handed one: a path there would be a path with no reason to
      > exist, and the one place it could leak from is the place it should never have been.
- [x] Unit tests (add `node --test` or vitest — currently the repo has only eslint + smoke:shaders).
      Round-trip v1 → v2 → validate for a real saved project.
      > **`node --test`** — no new dependency, it is built into the Node the repo already requires.
      > `npm test` is kept separate from `npm run lint` so a failing unit test and a failing shader
      > smoke test stay distinguishable; a step was added to `.github/workflows/ci.yml` so they
      > don't rot. 50 tests.
      > `test/fixtures/v1Project.js` matches `serializeProject` field for field and carries the
      > awkward corners deliberately: a COMPOUND with an interior, a clip graph, a *transition*
      > graph under its synthetic `<clipId>::tr:<edge>` key, a compound library entry, a legacy
      > `TIME` node, and inline images at three different depths.
      > **Not yet run against a real project out of IndexedDB** — see Verify.

**Done when:** `npm run lint` passes, tests pass, the app behaves identically. Nothing is wired up.

> **All three confirmed 2026-08-26.** `npm run lint` — 0 errors, 2 pre-existing warnings
> (`NODE_COLORS` in `NodeCard.jsx`, one in `ActionContextMenu.jsx`); shader smoke test 65 + 35 OK.
> `npm test` — 50/50. `npm run build` — clean. Nothing is imported by the app yet except `hash.js`,
> which `fontRegistry` now uses and whose output is proven byte-identical.
>
> **Also checked live in `npm run dev`,** which is more than the "nothing is wired up" bar asked
> for and was worth it:
> - The app boots with **zero console errors** after the `fontRegistry` change, renders, and keeps
>   its WebGL canvas.
> - A project built through the **real store actions** (2 clips, a clip graph, a transition graph
>   under its `::tr:in` key, an `IMAGE_INPUT` with a data URL, keyframes, a marker) and serialised
>   by the **real `serializeProject`** validates clean at v1 **and** v2, with `untrusted: true` as
>   well — so the assembled node-type whitelist really does cover what the app produces.
>   `topLevelKeys` came back exactly `TOP_LEVEL_KEYS` minus `media`, which is the check that the
>   strict top-level rule is calibrated against the actual serializer rather than against the
>   fixture.
> - `replaceInlineImages` swapped **both** uses of one image — the clip's and the node's — to the
>   **same** ref id, leaving `imageName` intact and the source document untouched. That is the
>   content-addressing dedup working end to end on real data: two uses, one blob.
> - **`hashBytes` / `headTailSig` return identical values in Node and in Chromium** (checked
>   against the same inputs in both: `695fb69684bbdf7f0df7`, `e8881d835265fd410a43`). Worth
>   recording now — from phase 3 the trusted process hashes under Node and the renderer resolves
>   under Chromium, and if those two ever disagree every ref breaks at the boundary.
>
> Not checked: pixels. The browser pane still cannot composite (same limitation as the
> 2026-08-21 session), so the evidence is DOM + console + store state, not a screenshot.

**Verify:** load an existing project from IndexedDB, run it through `migrateV1toV2` + `validateProject`
in the console, confirm no data loss and no validation errors.

> **DONE 2026-08-26 — all 4 real projects on this machine pass, clean.** Zero errors and zero
> warnings at both v1 and v2. The hand-built fixture was representative after all; nothing in the
> real documents needed a validator change. Results table below.
> **How:** `npm run dev`, open the app in the browser you normally develop in (the projects live in
> *that* browser's IndexedDB for `localhost:5173` — no other browser can see them), F12 →
> **Console**, paste the block below, Enter.
>
> **It writes nothing.** `loadProject` only reads, `migrateV1toV2` returns a *new* object and
> mutates nothing, and no result is saved back. Verified: the stored document is byte-identical
> before and after, and stays `version: 1`.
>
> ```js
> const { listProjects, loadProject } = await import('/src/utils/projectSerializer.js')
> const { validateProject, migrateV1toV2, collectInlineImages } = await import('/src/storage/schema.js')
>
> const rows = []
> for (const p of await listProjects()) {
>   const doc = await loadProject(p.id)
>   const before = validateProject(doc)
>   const after  = validateProject(migrateV1toV2(doc))
>   const imgs   = collectInlineImages(doc)
>   rows.push({
>     name: p.name,
>     version: doc.version,
>     v1ok: before.ok,
>     v2ok: after.ok,
>     errors: [...before.errors, ...after.errors],
>     warnings: before.warnings,
>     inlineImages: imgs.length,
>     inlineImageChars: imgs.reduce((n, i) => n + i.dataUrl.length, 0),
>     docChars: JSON.stringify(doc).length,
>   })
> }
> console.table(rows)
> ```
>
> ⚠ **Use the app's own `projectSerializer` exports, not `idb-keyval` directly.** An earlier draft
> of this block opened with `await import('idb-keyval')` and **cannot work**: the DevTools console
> evaluates raw script, so it never goes through Vite's transform, and the browser cannot resolve a
> bare module specifier — `TypeError: Failed to resolve module specifier 'idb-keyval'`. Only paths
> Vite actually serves (`/src/...`) import cleanly from the console. Worth remembering for every
> future console-verification block in this file.
>
> **Reading the result:**
> - `v1ok` / `v2ok` **false**, or anything in `errors` → a **validator bug, not a project bug**.
>   Fix `schema.js`; do not "fix" the project.
> - `warnings` are expected and fine — a dangling ref or a clip on a missing track is recoverable
>   and deliberately does not block opening.
> - `inlineImageChars` is the number to **record here**. It is the baseline for phase 2's
>   autosave-speed measurement (every one of those characters is re-`JSON.stringify`'d and
>   rewritten to IndexedDB on a 2-second debounce, on every keystroke), and far cheaper to collect
>   now than to reconstruct after the images have moved to blobs.
>
> **Results, 2026-08-26** — real projects, read out of IndexedDB, `console.table` verbatim:
>
> | Project | version | v1ok | v2ok | errors | warnings | inlineImages | inlineImageChars | docChars | **% image** |
> |---|---|---|---|---|---|---|---|---|---|
> | Untitled Project | 1 | ✅ | ✅ | 0 | 0 | 6 | 125,702 | 169,333 | **74.2%** |
> | Streetlamp_vid_2108 | 1 | ✅ | ✅ | 0 | 0 | 1 | 389,367 | 401,065 | **97.1%** |
> | SOMS 3107 | 1 | ✅ | ✅ | 0 | 0 | 0 | 0 | 21,145 | — |
> | Untitled Project | 1 | ✅ | ✅ | 0 | 0 | 0 | 0 | 16,182 | — |
> | **total** | | | | **0** | **0** | **7** | **515,069** | **607,725** | **84.8%** |
>
> ### ⚠ The number that reframes phase 2
>
> **`Streetlamp_vid_2108` is 97.1% base64 image data — 389 KB of a 401 KB document, in ONE image.**
> Autosave re-`JSON.stringify`s and rewrites that entire document on a 2-second debounce, on every
> keystroke in a text field. So typing a caption in that project currently costs ~401 KB of
> serialise-and-write per two seconds, of which **~389 KB is one image that has not changed and
> never will**.
>
> Projected document sizes once phase 2 moves images to blobs (`imageSrc` → `imageRefId`, ~24 chars):
>
> | Project | now | after | shrink |
> |---|---|---|---|
> | Untitled Project | 169,333 | ~43,600 | **3.9×** |
> | Streetlamp_vid_2108 | 401,065 | ~11,700 | **34×** |
> | all four combined | 607,725 | ~92,700 | **6.6×** |
>
> Two things follow, and both are decisions rather than observations:
>
> 1. **This is the strongest argument yet for 0 → 2 → 1.** Phase 2 was chosen because media does not
>    survive a reload; it turns out to *also* be the single biggest available win on the app's
>    largest avoidable stall (§1 defect 2), and the measurement says that win is 3.9–34×, not the
>    few percent a guess would have assumed. Phase 1 — atomic writes, backups — makes each of those
>    oversized writes *safer*; phase 2 stops them being oversized. Doing phase 1 first would have
>    meant building backup rotation around documents that are 85% dead weight.
> 2. **The per-project spread is the actionable part.** Two of four projects carry no images at all
>    and are already small; the gain is entirely concentrated in image-carrying projects, where it
>    is enormous. So phase 2's "measure autosave before/after" step should be run **specifically on
>    `Streetlamp_vid_2108`**, not on an average — the average understates it by an order of
>    magnitude, and the worst case is what the user actually feels.
>
> Baseline for that measurement, to compare against after phase 2: **401,065 chars per autosave,
> 1 image, 389,367 of them image.**

---

### Phase 1 — Vault interface + OPFS backend for projects — **DONE 2026-08-26**

- [x] `webVault.js`: OPFS via `navigator.storage.getDirectory()`.
      Layout: `/projects/<id>/project.json`, `/projects/<id>/backups/`, `/blobs/<hash>`.
      > webVault gained a small **generic file API** (`readText` / `writeTextAtomic` / `copyFile` /
      > `list` / `remove`) rather than project-shaped methods, so it stays a dumb byte-mover and
      > all the orchestration lives in `projectStore`. Every path segment is regex-validated —
      > `getDirectoryHandle` would happily accept `..`, and ids come from project documents, which
      > are untrusted input.
- [x] ~~Writes go through a **dedicated Worker** using `createSyncAccessHandle`~~
      **DELIBERATELY NOT DONE — phase 2 removed the premise.** The Worker was justified by project
      writes being large. They are not any more: moving images to blobs took documents from 41,521
      to 8,159 characters (`Streetlamp_vid_2108` ~401 KB → ~12 KB), and a full autosave now
      measures **0.58 ms** on the main thread. A Worker to write 8 KB is complexity with nothing to
      buy, and it would put the atomic-write logic behind a message boundary for no gain. Revisit
      only if a measurement demands it — not on principle.
- [x] `projectStore.js`: atomic write (§5.4), backup rotation, `listBackups` / `restoreBackup`.
      > **Validation runs before any I/O** and a failing document is rejected, never written — that
      > ordering *is* the fix for "one bad serialise overwrites the only good copy". Backups are
      > rate-limited to one per 5 min so the 2-second autosave cannot mint one per keystroke, and
      > pruning keeps the last 10 **plus** one per day for 7 days: those answer two different
      > questions ("undo the last few saves" / "get back to Tuesday") and one count cannot serve
      > both. `restoreBackup` writes through `writeProject`, so restoring the wrong version is
      > itself undoable.
      > Backup filenames use ISO8601 with `:` and `.` replaced — colons are illegal in filenames on
      > Windows, and the desktop backend will use these same names against a real filesystem.
- [x] **Read-through migration:** on `listProjects`, read OPFS *and* the legacy `dalivid_project_*`
      IndexedDB keys. Anything found only in IDB is migrated to OPFS on first open, then the IDB key
      is deleted. Never delete before a successful OPFS write.
      > Implemented exactly in that order in `readProjectMigrating`: write OPFS → read it back →
      > only then `del` the IndexedDB key. An interruption anywhere leaves the project readable
      > from at least one of the two. Legacy rows are flagged `legacy: true` and badged in the UI.
- [x] `capabilities()` + `usage()` via `navigator.storage.estimate()`. *(landed in phase 2)*
- [x] **Handle `QuotaExceededError` explicitly.** Toast that names the problem and links to a manage-
      storage view. A silent autosave failure is worse than no autosave.
      > `VaultQuotaError` is raised by both `putBlob` and `writeTextAtomic`; the import path names
      > the file and points at Media Pool → Storage.
- [x] Surface persistence honestly: if `navigator.storage.persist()` is refused, say so in the UI
      rather than only `console.log`-ing it. *(landed in phase 2 — Storage tab)*
- [x] New **Project Browser** modal: open / duplicate / delete / restore-from-backup, with sizes.
      > **This closed the biggest remaining gap, and it was bigger than the checklist implies:**
      > `listProjects`, `loadProject` and `deleteProject` had **no call sites anywhere in the UI**.
      > Every explicit save wrote a project that nothing could ever reopen — the app restored the
      > *last* session and offered no route to any other. Saving many projects and being able to
      > reach exactly one of them was a large part of what "persistence is broken" meant.
      > Opening a project saves the current one first, then `clear()`s the media pool at that
      > deliberate boundary (the only safe moment to revoke playback URLs) before hydrating the
      > incoming one. Duplicating shares media by content hash — a copy costs one document, not
      > another copy of the footage.

**Done when:** projects live in OPFS, backups exist and restore, a mid-write kill (devtools → crash
the tab during autosave) never produces an unopenable project, and existing IDB projects migrate silently.

**Verify:**
1. Save a project, kill the tab mid-autosave 10× in a row, reopen each time. Zero corruption.
2. Fill the origin quota deliberately (write a few GB of junk blobs), confirm the failure is a clear
   toast and not a silent loss.
3. Restore a backup from 3 saves ago and confirm the edit matches.

> ### Results, 2026-08-26 — measured in `npm run dev`, real OPFS
>
> | Check | Result |
> |---|---|
> | atomic write + read back | ✅ `Phase1 v1` written, read back, no `.tmp` left behind |
> | **invalid document rejected** | ✅ `INVALID_PROJECT`, **and the good version survived untouched** |
> | backup rotation | ✅ 2nd write → `backedUp: true`, 1 backup holding the *previous* version |
> | restore | ✅ live went `v2` → `v1` |
> | legacy IDB → vault migration | ✅ migrated to v2, present in vault, **IndexedDB key removed**, `[legacy]` badge cleared |
> | traversal guard | ✅ `readProject('../../etc')` → `TypeError` |
> | Project Browser renders | ✅ 3 rows with sizes, backup counts, LEGACY badge, 4 actions each |
> | **switching projects** | ✅ clicked Open → app went `Untitled Project` → `Legacy Project`, modal closed |
>
> Item 2 (the rejected write leaving the previous version intact) is the one that matters most —
> it is the exact failure this phase exists to prevent, and it is now demonstrated rather than
> assumed.
>
> **NOT verified — needs manual work:**
> - **Verify item 1 properly: kill the tab mid-write 10×.** The atomic rename makes a torn write
>   structurally impossible, but that is an argument, not a measurement. DevTools → crash the tab
>   during a save, repeatedly.
> - **Quota exhaustion (item 2).** `VaultQuotaError` is raised and surfaced, but the path has never
>   run against a genuinely full origin. Write a few GB of junk blobs and confirm the toast.
> - Restoring a backup from *3 saves ago* specifically — only a 1-deep restore was exercised, and
>   backups are rate-limited to one per 5 minutes so building a deeper history takes real elapsed
>   time.
> - Backup **pruning** (keep 10 + one/day for 7 days) has not been exercised; it needs 10+ backups,
>   i.e. ~an hour of real saves.

---

### Phase 2 — Media vault on the web · **this is the phase that fixes the complaint** — **DONE 2026-08-26**

- [x] `putBlob` / `getPlaybackURL` / `gcBlobs` in `webVault`.
      > `src/storage/webVault.js`. Stores **bytes keyed by content hash and nothing else** — no
      > filename, MIME or duration, all of which live on the MediaRef in the project document. So
      > there is no sidecar index to corrupt or keep consistent with the files, and dedup is exact.
      > The consequence to remember: OPFS `File`s come back with `type: ''`, so `getPlaybackURL`
      > must be handed the MIME from the ref — some containers will not play from a typeless blob
      > URL. Writes go to `<hash>.part` and are renamed into place: a blob is named by its own
      > content, so a torn write would otherwise leave a *short file under the right name*, which
      > every future dedup check would then accept as valid forever.
- [x] Move Media Pool state out of `useState` in `MediaPool.jsx` into a `useMediaStore` backed by the
      vault. The pool becomes project state, serialised into `media.refs`.
      > Refs are **persistent**; `urls` (object URLs) and `status` are **runtime** and rebuilt by
      > `hydrate` on every open. Keeping them in separate fields is what stops a `blob:` URL ever
      > being written into a saved document, where it would be meaningless garbage that *looks*
      > like a working reference.
      >
      > **`hydrate` MERGES and does not revoke — fixed 2026-08-26, do not undo.** It originally
      > replaced the whole ref list and called `revokeAllPlaybackURLs()` first. Because it runs
      > inside the deliberately-async `restoreProjectMedia`, anything the user imported while it
      > was still in flight had its URL revoked and its ref dropped — and the GC above then
      > deleted those bytes as unreachable. Merging costs nothing (refs are content-addressed, so
      > an id collision *is* the same file) and removes the whole class of load race.
      > `revokeAllPlaybackURLs` now happens only in `clear()`, called at one explicit
      > project-close boundary (Toolbar's load path) where nothing can still be playing.
      >
      > Underlying reason both bugs were fatal rather than cosmetic: **an OPFS `File` is a
      > reference to bytes on disk, not a copy** — `new Blob([file])` does not read it. Delete or
      > rewrite the file and every `blob:` URL made from it fails with `ERR_FILE_NOT_FOUND`.
      > Added `ref.meta` (duration/width/height/fps) — facts about the *file*, not the project.
      > Without it a restored pool card renders `0:00`, because the numbers came from a probe that
      > only ran at import.
- [x] Import path change: `handleImportVideo` / `handleImportAudio` ingest bytes → `putBlob` → MediaRef,
      instead of `URL.createObjectURL(file)` alone. Metadata probe unchanged.
      > Screen **recordings** go through the same path, so a recording is persistent the moment it
      > stops, with no import step — which was a listed phase-5 goal and came free here.
- [x] **Per-import copy decision.** Below a threshold (suggest 2 GB total per import) copy silently.
      Above it, a modal: *"Add to project (uses N GB, survives reload)"* vs *"This session only"*.
      Session-only entries are marked in the pool and warn on close. Do not make a 40 GB copy
      decision on the user's behalf.
      > `COPY_PROMPT_THRESHOLD_BYTES` = 2 GB, agreed 2026-08-26 as a constant with a `TODO` to
      > become a user preference (Settings → Storage) in a later pass.
- [x] **Images off data URLs.** `prepareImageDataURL` → `putBlob` → `params.imageRefId`.
      Migrate existing `imageSrc` on load. Measure autosave time before/after and record it here.
      > **Measured — see the numbers below.** Migration is split into two *pure* halves
      > (`collectInlineImages` / `replaceInlineImages`) with the storage write in between, so
      > `schema.js` stays runnable in a Worker and in `node --test`. It is **safe to interrupt**:
      > `imageSrc` is only replaced once the bytes are committed, and the serializer only drops
      > `imageSrc` when an `imageRefId` sits beside it — so a half-finished migration leaves a
      > project that is part-migrated and entirely intact, and finishes next time.
- [x] Blob GC: on project save, `gcBlobs(reachableHashes)` for blobs no project references. Never GC
      during an export.
      > **⚠ This shipped WRONG and deleted a user's media mid-playback. Fixed 2026-08-26 — read
      > this before touching the GC.**
      >
      > "On project save" was implemented as *every* save, which includes the 2-second debounced
      > autosave. So a full OPFS scan-and-delete pass ran continuously while editing, and any
      > momentary gap in the reachable set became **permanent deletion of the user's media** a
      > couple of seconds after they imported it. Reported as: MP4 plays, stops a little way in,
      > console fills with `net::ERR_FILE_NOT_FOUND` on a `blob:` URL.
      >
      > Reproduced exactly, and the reproduction showed it was data loss and not merely a dead
      > URL: `{deleted: 3, freed: 275139, kept: 0}` with the bytes gone from disk.
      >
      > Three fixes, all of which should stay:
      > 1. **Explicit saves only** (`!silent`), plus the Storage tab's purge button. Reclaiming
      >    space is never urgent; deleting the wrong file is irreversible.
      > 2. **A blob with a live playback URL is never deleted, whatever the reachable set says**
      >    (`_urls.has(hash)`, reported as `pinned`). This is the backstop and it is *not*
      >    redundant with reachability — an object URL exists only because something asked to play
      >    those bytes, so it is a direct statement of "in use" that cannot go stale the way a
      >    derived set can.
      > 3. The `.part` sweep only removes files older than 5 minutes, because a `.part` is also
      >    what an in-flight import is writing into.
      >
      > The reachable set remains the pool's hashes **plus** a sweep of what clips and nodes
      > reference: a missed hash destroys media, a stale one merely wastes space until next sweep.
- [x] Storage management UI: per-project size, per-blob size, "media used by no project", purge button.
      > New **Storage** tab (`StorageTab.jsx`). Also states plainly whether `persist()` was granted
      > — a refusal was previously silent, which left the user's only copy evictable with no way to
      > know.
- [x] `beforeunload` warning updated — with real persistence it should fire far less often. Keep it
      for the session-only case.
      > Now fires **only** for session-only media. The old "you haven't downloaded a file"
      > condition fired on *every single reload* — and now that the project reopens itself and
      > media resolves from the vault, a reload loses nothing, so that warning was both constant
      > and untrue. A prompt that cries wolf on every refresh is how people learn to dismiss the
      > one that matters.

**⚠ Found and fixed along the way: `loadAutosave` had no call site.** Autosave has always written
to IndexedDB every two seconds and **nothing ever read it back** — the only route into a saved
project was importing its `.dalivid.json` by hand. That is why a reload appeared to lose
everything even though the edit was safely stored, and it is a large part of what "persistence is
broken" actually meant. `App.jsx` now restores the last session on boot (only when it has real
content, so "New Project" still lands on a clean slate). This was not on the phase-2 checklist,
but the phase's own "Done when" — *reload the tab → media is still there* — cannot even be
observed without it.

**Done when:** import media → reload the tab → media is still there, clips still play, **no relink
prompt**. Autosave on an image-heavy project is measurably faster.

**Verify:**
1. Import 5 videos + 3 images, build an edit, hard-reload. Everything plays. No prompt.
2. Same project in a fresh browser profile → refs all report missing → relink flow still works.
3. Measure autosave duration on a 10-image project before and after. Write the numbers in this file.
4. Delete a project, confirm its exclusive blobs are GC'd and shared ones are not.

> ### Results, 2026-08-26 — measured in `npm run dev`, real OPFS, real IndexedDB
>
> **1. The headline: media survives a reload.** Built a project through the real store actions
> (image clip + video clip + an `IMAGE_INPUT` node), autosaved, then **hard-reloaded**. With no
> user action at all:
>
> | | after reload |
> |---|---|
> | refs restored | **2 / 2**, both `ok` |
> | blobs in vault | 2 |
> | clips restored | 4 |
> | clips with a playable URL | 2 (both `blob:`) |
> | image clip | `imageRefId` intact, `imageSrc` → `blob:` |
> | **image actually decodes** | **yes — 64×64** |
> | `IMAGE_INPUT` node | resolved |
> | **relink prompt** | **none** |
>
> The pool card also came back reading `1920×1080 · 5.0s · 195.3 KB` — real metadata out of
> `ref.meta`. Before the restart it showed the clip-derived fallback (`10.0s · 0 B`), which is
> exactly the regression `meta` exists to prevent.
>
> **3. Autosave, before vs after** — same project, one inlined image, migrated in place:
>
> | | before (base64 inline) | after (blob + refId) | |
> |---|---|---|---|
> | document | 41,521 chars | 8,159 chars | **5.1× smaller** |
> | `JSON.stringify` | 0.13 ms | 0.08 ms | 1.6× |
> | **full autosave** (stringify + IndexedDB write) | **13.2 ms** | **0.58 ms** | **22.8× faster** |
>
> The autosave figure is the one that matters — the base64 cost is dominated by the *write*, not
> the stringify, which is why the document-size ratio understates it. Note this test image was
> only 33 KB of base64; **`Streetlamp_vid_2108`'s real image is 389 KB, ~11.6× more**, so its
> improvement should be larger still. That project lives in the user's own browser profile and was
> not measured directly here.
>
> **4. GC is exact.** Removed one ref and the clip using it, then collected:
> `{deleted: 1, freed: 305, kept: 2}` — the unreferenced blob gone, both in-use blobs untouched.
>
> **Also confirmed:** saved documents are `version: 2`, carry `media.refs` with **no `path`/`sig`
> on any ref**, and contain **no `data:image` anywhere**; `imageSrc` is stripped only where
> `imageRefId` exists. Storage tab renders real figures (220.2 KB in use, 0 B unused, 2.7 GB free)
> and states that persistence was *not* granted in this profile.
>
> **NOT verified — needs real footage and a real GPU:**
> - **Actual video playback from a vault blob.** The video test used synthetic bytes, which proves
>   the ref/blob/URL path but not decoding. Import a real MP4, scrub it, reload, scrub again.
> - Item 2 (fresh profile → all refs `missing` → relink) — the offline path is implemented and
>   `status` reports `missing`, but it has not been exercised end to end.
> - A large import crossing the 2 GB threshold, i.e. the copy-decision modal on real files.
> - Whether OPFS write throughput is acceptable for a multi-GB import (it is one `createWritable`
>   stream; the plan's phase-1 note about a Worker + `createSyncAccessHandle` applies here too if
>   it proves slow).
>
> **Method note, cost me real time — worth keeping.** Verifying from the DevTools console with
> `await import('/src/store/useMediaStore.js')` silently gives you a **different module instance**
> from the running app: Vite serves HMR'd modules as `/src/…js?t=<timestamp>`, and an import
> without that query is a different URL and therefore a separate Zustand store. The symptom is
> perfect-looking state in the console and zero refs in the saved document, which reads exactly
> like a serializer bug. Restart the dev server before console-verifying anything stateful, so no
> `?t=` variants exist — or drive the app through its own UI instead.

---

### Phase 3 — Electron shell, parity only · *no new features*

- [ ] `electron/` — `main.cjs`, `preload.cjs`, `ipc/` one module per namespace.
- [ ] Window + protocol config per §5.1. Serve the Vite bundle from `app://dalivid/`.
- [ ] `desktopVault.js` proxying to `window.dalivid.*`; `src/storage/index.js` picks the backend by
      `typeof window.dalivid !== 'undefined'`.
- [ ] `projectStore` and `mediaRef` run **in main** on desktop, against the same code. Vault root
      defaults to `app.getPath('userData')/vault`; `app:chooseVaultRoot` lets the user move it once
      (main stores the choice; the renderer never learns the path).
- [ ] Media stays **vault mode only** in this phase. Import copies into the vault. No link mode yet.
- [ ] Native menu bar, window state persistence, Ctrl+S / Ctrl+O wired to the real menu.
- [ ] "Import from DaliViD Web" first-run flow (§4 gotcha).
- [ ] Route the Google Fonts fetch through main; drop the two hosts from the renderer CSP.
- [ ] Dev ergonomics: `npm run dev:electron` pointing at the Vite dev server, prod at `app://`.

**Done when:** the desktop app is feature-identical to the web app, the renderer has zero fs access,
and a `.dalividpkg` exported from web imports cleanly into desktop.

**Verify:**
1. In devtools console: `window.require`, `window.process`, `window.ipcRenderer` are all undefined.
2. `window.dalivid` is frozen and exposes only the enumerated methods.
3. Every IPC handler rejects a path-shaped argument.
4. `will-navigate` to an external URL is blocked; `target=_blank` opens nothing.

---

### Phase 4 — Link mode + `dalivid-media://` streaming · *desktop only*

- [ ] `media:pick` opens a native dialog in main, hashes head/tail, registers refs, returns them
      **without paths**.
- [ ] Register `dalivid-media://` with full **Range** support (§3.4). This is the highest-risk task in
      the plan — budget real time for it.
- [ ] `media:stat` on project open: `ok` / `missing` / `changed`. Refs resolve by path, and the app
      **does not prompt** when they all resolve. That is the headline feature.
- [ ] Proper **media-offline** clip state in the timeline and preview (the standard NLE affordance —
      a coloured slug, not a black frame), replacing today's silent failure.
- [ ] `media:repair`: user picks a folder in main; main walks it, matches by `sig` first, then
      filename, and rewrites the refs. One dialog repairs an entire moved project.
- [ ] `media:adopt`: "Copy into project" per clip or per project — converts link → vault for handoff.
- [ ] Per-project preference: *Copy media into project* (safe, duplicates) vs *Reference in place*
      (fast, fragile). Ask once in the New Project modal, changeable later.
- [ ] **Project Media panel** listing every reference, its mode, its path, its status, with a per-ref
      "Forget". This is the revocation UI the old design lacked and is a requirement, not a nicety.

**Done when:** a project referencing 40 GB of footage opens instantly with zero prompts and zero
memory growth; moving the footage folder produces a clean offline state repaired by one dialog.

**Verify:**
1. Scrub aggressively through a 4 GB source. Seeking is responsive → Range works. Watch RSS: flat.
2. Rename the source folder → all refs `missing` → repair with one folder pick → all `ok`.
3. Replace a file with a *different* file of the same name and size → status `changed`, not `ok`.
4. `dalivid-media://` with a forged id, a traversal id (`mr_../../..`), and a valid id from a
   *different* project → all 404.

---

### Phase 5 — Native export sinks

- [ ] `sink:open/write/close/abort` in main; save dialog opens in main, returns an opaque `sinkId`.
- [ ] `ExportModal.jsx` writes muxer output through the sink instead of accumulating a Blob.
      Removes the current memory ceiling on long exports.
- [ ] `screenRecorder.js`: replace `showSaveFilePicker` (`openRecordingSink`) with the sink API on
      desktop; keep the existing picker on web. One call site, guarded by `capabilities()`.
- [ ] Recordings land in the vault as MediaRefs automatically — record, and the clip is already
      persistent with no import step.
- [ ] Crash-safety: an aborted export deletes its partial file rather than leaving a broken MP4.

**Done when:** a 30-minute 4K export completes with flat memory, and a screen recording appears in
the pool as a persistent ref with no user action.

---

### Phase 6 — Packaging & hardening

- [ ] `electron-builder`: NSIS (Windows), AppImage + deb (Linux), dmg (macOS if wanted).
- [ ] **Code signing.** Windows OV certs now require hardware tokens / cloud HSM — this has lead time
      and annual cost. Start it early; it is the longest-pole item here. Unsigned = SmartScreen wall.
- [ ] `asar` + `asarUnpack` only what genuinely must be on disk. Enable ASAR integrity.
- [ ] Disable auto-update entirely for the Steam build (Steam owns updates via depots). Keep a
      version check that *tells* the user, and never self-updates.
- [ ] Supply chain: `npm ci` only, lockfile committed, exact-pin the runtime deps, Dependabot on
      security updates only, `npm audit --omit=dev` gate in CI, and a manual review step for any new
      transitive dependency in a release build.
- [ ] Harden project-file ingest: enforce the phase-0 validator on **import**, cap document size,
      reject unknown node types rather than passing them to the compiler, and confirm no
      project-supplied string reaches a shader compile except through the existing whitelist.
- [ ] Crash reporting **off by default**, opt-in only, and never send project contents.

---

## 7. Decisions and non-goals

| Decision | Rationale |
|---|---|
| Electron, not Tauri | The export path depends on WebCodecs, VP9-with-alpha, `mp4-muxer`/`webm-muxer` and Opus. Bundling Chromium makes `isConfigSupported` answer identically on every machine. Tauri's system WebView2 makes it a per-user lottery. 200 MB is irrelevant on Steam. |
| One storage core, two backends | Web and desktop must not diverge. All logic is backend-agnostic; backends move bytes only. |
| Content-addressed blobs | Already proven by `fontRegistry`. Free dedup — the same clip in three projects costs one copy. |
| Head/tail signature, not full hash | Full-hashing multi-GB imports is unusable. O(2 MiB) drift detection is the right trade. |
| Paths never cross into the renderer | The one rule the whole security position rests on. |
| Link-mode paths not in the project file | A project file is a shareable, untrusted document. Paths are local machine state. |
| `filename` retained forever on clips | Downgrade path and relink fallback. Costs nothing. |
| No `showDirectoryPicker`, ever again | On web, OPFS gives persistence with zero authority. On desktop, refs give access with per-file authority. Neither needs a directory grant. |

**Non-goals:** cloud sync; multi-user projects; a proxy/optimised-media pipeline (worth doing later,
and it becomes easy once the vault exists — a proxy is just another blob keyed to the same ref);
mobile.

---

## Appendix A — Steam (context, not scope)

- **Steam Cloud does not solve persistence.** It is post-exit file sync against a quota you request
  from Valve, sized for saves and settings, not media. At most it syncs `.dalivid.json` project docs
  between machines. Media must never go near it. It also does nothing for the web build.
- Steam Direct is $100 per app. Non-game software is accepted (Aseprite, Cascadeur, Wallpaper
  Engine) but reviewed; the risk is a store page that reads like a wrapper around a website.
- The **Steam Overlay will not work** — it hooks the render surface and Electron's GPU-process
  compositing defeats it. No shift-tab, no Steam screenshots. Irrelevant for a creative tool, but
  know it before someone reports it as a bug.
- **Codec licensing.** Electron ships Chromium's full ffmpeg, so H.264/AAC encode works — but
  shipping a paid product makes you the distributor of an AVC encoder. Via LA's licence has a
  royalty-free unit threshold; small shops generally ship regardless. Worth an hour with someone
  qualified before you take money. The VP9/WebM path avoids it entirely.
- **Steam Deck / Linux** is nearly free from Electron, but a fill-rate-bound shader stack on that APU
  is its own performance conversation.

## Appendix B — GPU driver variance (separate backlog, but do not ignore)

Today, when a shader misbehaves on someone's Intel iGPU, they blame Chrome. Ship a binary and they
blame you, in a review, with a refund. Electron pins one Chromium + ANGLE, which fixes the
translation layer — the driver underneath is still theirs.

- [ ] Handle `webglcontextlost` / `webglcontextrestored`. Driver updates and sleep/resume both fire it.
      Currently an unhandled context loss is an unrecoverable black canvas.
- [ ] Surface `getShaderInfoLog` failures as a real UI error **naming the offending node**, not a
      black frame. Highest-value single change in this list.
- [ ] Startup GPU capability probe: renderer string, max texture size, float-texture support, max
      varyings. Show it in an About/Diagnostics panel — it is the first thing you will ask for in
      every support ticket.
- [ ] Audit `mediump` usage in generated shaders; fp16 on some hardware will band gradients and wrap
      loop accumulators that are exact on desktop NVIDIA.
- [ ] Watch for Windows TDR (~2 s per-draw budget). Heavy 4K stacks can trip it and take the context
      with them. Consider tiled rendering for export at high resolutions.
- [ ] Ship a "Safe mode" launch flag that disables the heaviest passes, for users who cannot get to
      the UI at all.

## Appendix C — Rough sequencing

Phases 0–2 are ~60% of the value and require no Electron decision. Phase 3 is the commitment point.
If the Steam plan stalls, stop cleanly after phase 2 and the web app is dramatically better for it.
