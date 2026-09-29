# Google Meet Screen & Audio Recorder – Requirements Specification
**Document Version:** 2.0  
**Target Environment:** Manifest V3 (Google Chrome / Chromium-based browsers)  
**Architecture:** Client-Side / Offscreen Document / Web Audio Mixing / Local IndexedDB Engine  

---

## 1. System Overview & Foundation
A local-first, privacy-respecting Chrome Extension engineered to capture Google Meet sessions with zero server-side infrastructure. The system leverages `chrome.tabCapture` to isolate meeting video and audio, mixes two-way voice via the Web Audio API, streams time-sliced media directly to a local IndexedDB instance to eliminate RAM exhaustion, and embeds native controls directly into the Google Meet UI.

---

## 2. Functional Requirements

### 2.1 UI Injection & Native Integration
* **FR-UI-1: Control Bar Button Injection**
  * The content script (`scrapingScript.ts`) dynamically injects a custom "Start/Stop Recording" button directly into Google Meet's bottom control bar.
  * Injected directly adjacent to Meet's primary action cluster (Microphone and Camera toggle buttons).
* **FR-UI-2: Resilient DOM Discovery & Observation**
  * Locate control bar injection points without referencing obfuscated, minified, or dynamic CSS class names.
  * Implement a `MutationObserver` targeting stable ARIA labels and attributes:
    * Selectors: `button[aria-label*="microphone" i]`, `button[aria-label*="camera" i]`, `button[data-is-muted]`, and their common flex parent.
  * Gracefully handle unmount and remount cycles (e.g., layout adjustments, entering/exiting full-screen, opening the chat/participant drawer).
* **FR-UI-3: Persistent Viewport Badge**
  * Inject an independent, floating recording pill/badge in the upper-left of the Meet viewport.
  * Remains visible even when the bottom control bar auto-hides or during full-screen presentation mode.
  * Features:
    * Pulsing red indicator.
    * Real-time elapsed duration counter (`HH:MM:SS`).
    * Clickable quick-action toggle to stop recording.
* **FR-UI-4: State Synchronization**
  * The injected control bar button, floating badge, and extension action popup must synchronize state bidirectionally with the background service worker and offscreen document via typed runtime messages (`RECORDING_STATE_UPDATE`).

---

### 2.2 Audio & Video Pipeline

```
[Tab Video Track] ──────────────────────────────────────────────┐
                                                                ▼
[Tab Audio Track] ───► [AudioContext] ───┬─► [Local Speakers] (audioContext.destination)
                                         │
                                         ├─► [Mixed Audio Destination] ──► [MediaRecorder]
                                         │   (createMediaStreamDestination)
[Mic Audio Track] ───► [Gain Node] ──────┘
                         ▲
                         │ (Toggled via Meet Mute Sync)
```

* **FR-AV-1: Strict Tab Isolation**
  * Isolate media capture strictly to the target Google Meet tab.
  * System alerts, OS notifications, and audio from neighboring browser tabs must not bleed into the recording.
  * Pipeline: Background script invokes `chrome.tabCapture.getMediaStreamId({ targetTabId })` and forwards the `streamId` to the offscreen document for consumption via `navigator.mediaDevices.getUserMedia()`.
* **FR-AV-2: Audio Topology & Sidetone Prevention**
  * Tab audio and microphone audio are unified inside the offscreen document via `AudioContext`.
  * **Routing Topology:**
    * Tab Audio Source connects to `audioContext.destination` (so the user can hear other participants).
    * Tab Audio Source connects to `MediaStreamAudioDestinationNode` (mixed recorder destination).
    * Microphone Source passes through a dedicated `GainNode` and connects **exclusively** to `MediaStreamAudioDestinationNode`.
    * **Safety Constraint:** Microphone input must **never** connect to `audioContext.destination`, preventing audio feedback loops and sidetone latency.
* **FR-AV-3: Google Meet Mute Synchronization (Privacy Protection)**
  * Content script monitors the Meet microphone toggle state (`button[data-is-muted]`).
  * When the user mutes themselves in Google Meet, the content script broadcasts `MEET_MUTE_TOGGLED`.
  * The offscreen engine toggles the microphone's `GainNode.gain.value = 0` (or `micTrack.enabled = false`), ensuring the local recording accurately reflects the user's intent to be muted.
* **FR-AV-4: Autoplay Policy & AudioContext Resumption**
  * Offscreen documents can initialize an `AudioContext` in a suspended state under Chromium autoplay rules.
  * Explicitly check `audioContext.state === 'suspended'` and execute `await audioContext.resume()` prior to initializing `MediaRecorder`.
* **FR-AV-5: Encoding Standards**
  * Capture video at native tab viewport resolution (up to 1080p, 30 FPS).
  * Combine mixed audio and video tracks into a unified `MediaStream`.
  * Encode via `MediaRecorder` using MIME type `video/webm;codecs=vp8,opus` (with fallback to `video/webm`).

---

### 2.3 Memory Management & Chunk Storage Engine
* **FR-MEM-1: 5-Second Time-Sliced Partitioning**
  * `MediaRecorder.start(5000)` delivers chunks every 5,000 milliseconds.
* **FR-MEM-2: Direct Offscreen-to-IndexedDB Persistence**
  * To avoid IPC serialization overhead across extension processes, the offscreen document must interface **directly** with IndexedDB (`MeetRecorderDB`).
  * On every `ondataavailable` event, write the chunk immediately to the `chunks` store and purge it from memory. The offscreen script must not retain chunks in an in-memory array.
* **FR-MEM-3: EBML Metadata Patching (Seekability / Duration Restoration)**
  * Standard `MediaRecorder` WebM outputs lack valid `Duration` and `SeekHead` headers.
  * During final assembly, the offscreen document must run a WebM metadata patch (e.g., using `ts-ebml` or `fix-webm-duration`) across the initial header chunks to insert true duration and cue points before triggering the download.
* **FR-MEM-4: Memory-Safe Blob Assembly & Download**
  * When recording completes:
    1. Read chunks sequentially from IndexedDB using an `IDBCursor` ordered by `sequence`.
    2. Patch the WebM container header with the correct duration.
    3. Generate an object URL and trigger `chrome.downloads.download({ saveAs: true, filename: 'GoogleMeet-Recording-[meetingId]-[timestamp].webm' })`.
    4. For sessions exceeding 1.5 GB, allocate the Blob via chunk batches to prevent V8 heap limits from triggering an out-of-memory crash.
* **FR-MEM-5: Storage Garbage Collection**
  * Following a verified download or explicit user purge, immediately delete all chunks and session records from `MeetRecorderDB`.

---

### 2.4 Caption Extraction & Subtitle Export
* **FR-CAP-1: Multi-Tier Heuristic Caption Discovery**
  * Monitor the Meet DOM using fallback tiers:
    * **Tier 1 (Known Classes):** `.ygicle`, `.NWpY1d`, `.nMcdL`.
    * **Tier 2 (Semantic Attributes):** `div[role="region"][aria-label*="Captions" i]`, `[data-participant-id]`.
    * **Tier 3 (Structural Heuristics):** Observe repeating participant caption nodes inside the active caption container.
* **FR-CAP-2: Caption Persistence**
  * Scraped captions (speaker name, formatted text, absolute timestamp, relative video offset) are streamed directly to the `captions` store in `MeetRecorderDB`.
* **FR-CAP-3: Automated Dual Transcript (.txt) & Subtitle (.vtt) Export**
  * Upon saving the video recording, automatically compile and download:
    1. Human-readable meeting transcript: `GoogleMeet-Transcript-[meetingId]-[timestamp].txt`
    2. Synchronized WebVTT subtitle track: `GoogleMeet-Transcript-[meetingId]-[timestamp].vtt`
  * Both the video recording and the meeting transcript are downloaded automatically in a single unified action, eliminating any need for separate manual export.

---

### 2.5 Resiliency, Crash Recovery & Edge Cases
* **FR-EDGE-1: Auto-Finalization on Meeting Exit**
  * Content script monitors for exit indicators:
    * UI elements displaying "You left the meeting", "Return to home screen", or "You've been removed".
    * URL changes navigating away from `meet.google.com/[a-z]{3}-[a-z]{4}-[a-z]{3}`.
    * `beforeunload` events on the Meet tab.
  * On detection, send an immediate `FINALIZE_RECORDING` message to the offscreen document to ensure all accumulated chunks are closed and preserved.
* **FR-EDGE-2: Browser Crash & Orphaned Session Recovery**
  * Every recording session is tagged in IndexedDB with `status: 'RECORDING'`.
  * If Chrome crashes, terminates, or the tab is closed abruptly, the recorded data remains safely stored in IndexedDB.
  * Upon opening the extension popup, query for sessions with `status === 'RECORDING'`.
  * If an orphaned session is detected:
    * Render a recovery banner: `"Incomplete recording detected from [timestamp] (~[chunkCount * 5]s)"`.
    * Provide action buttons: `[Recover & Download]` and `[Discard]`.
* **FR-EDGE-3: Network Disconnect Immunity**
  * If local internet drops, the extension continues capturing uninterrupted: video records the static Meet tab, microphone captures local audio, and chunks continue writing to IndexedDB.
* **FR-EDGE-4: Service Worker Keep-Alive**
  * MV3 service workers can terminate after 30 seconds of inactivity. Maintain an active `chrome.runtime.connect` port channel between the offscreen document and service worker during an active recording to prevent premature lifecycle termination.
* **FR-EDGE-5: Anti-Sleep & Tab Discard Prevention**
  * Prevents display sleep and system idle states during active recording via `chrome.power.requestKeepAwake('display')` and Web Screen Wake Lock (`navigator.wakeLock.request('screen')`).
  * Disables Chrome Memory Saver discarding on the Google Meet tab via `chrome.tabs.update(tabId, { autoDiscardable: false })` so background tabs are never discarded or throttled.
  * Runs a 15-second heartbeat ping over the offscreen port to keep the worker and audio pipeline running continuously.

---

## 3. Database Schema (`MeetRecorderDB`, Version 2)

### Object Store: `sessions`
* **KeyPath:** `sessionId` (String, UUID v4 / unique timestamp ID)
* **Indexes:** `by_status` on `status`
* **Record Structure:**
```typescript
interface SessionRecord {
  sessionId: string;
  meetingId: string;
  startedAt: number;        // Epoch timestamp (ms)
  endedAt: number | null;
  status: 'RECORDING' | 'FINALIZING' | 'COMPLETED' | 'PURGED';
  mimeType: string;
  chunkCount: number;
  totalBytes: number;
}
```

### Object Store: `chunks`
* **KeyPath:** `id` (Auto-incrementing Integer)
* **Indexes:**
  * `by_session` on `sessionId`
  * `by_session_seq` on `[sessionId, sequence]` (Unique)
* **Record Structure:**
```typescript
interface ChunkRecord {
  id?: number;
  sessionId: string;
  sequence: number;         // 0, 1, 2, ...
  timestamp: number;        // Monotonic recording offset (ms)
  data: Blob;               // 5-second WebM slice
  byteSize: number;
}
```

### Object Store: `captions`
* **KeyPath:** `id` (Auto-incrementing Integer)
* **Indexes:** `by_session` on `sessionId`
* **Record Structure:**
```typescript
interface CaptionRecord {
  id?: number;
  sessionId: string;
  relativeTimeMs: number;   // Video offset in milliseconds
  speaker: string;
  text: string;
}
```

---

## 4. Extension Configuration & Settings Architecture (`src/settings.ts`)

* **Storage Engine:** Chrome Sync Storage (`chrome.storage.sync`) with automatic fallback to Local Storage (`chrome.storage.local`).
* **Schema Definition:**
```typescript
interface ExtensionSettings {
  saveVideo: boolean;           // Automatically download video file on stop (default: true)
  saveTxtTranscript: boolean;   // Automatically download plain-text transcript on stop (default: true)
  saveVttSubtitles: boolean;    // Automatically download WebVTT subtitle track on stop (default: true)
  videoQuality: '1080p' | '720p' | 'max'; // Dynamic constraint & bitrate profiles
  autoMixMic: boolean;          // Auto-mix local microphone into recording stream
  noiseSuppression: boolean;    // Hardware echo cancellation & noise suppression
  autoStopOnExit: boolean;      // Auto-finalize recording on call disconnect or tab close
}
```
* **UI Integration:**
  * Embedded in-extension Configuration panel (`#view-settings`) accessible via header gear icon.
  * Direct toggle switches and quality dropdown with immediate reactive persistence.
  * Streamlined main popup UI with the redundant manual transcript button removed in favor of automated dual saving.
