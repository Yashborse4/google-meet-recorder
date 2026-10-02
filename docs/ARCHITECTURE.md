# Technical Architecture & Internal Specifications

## Overview
**Google Meet Transcript & Video Recorder** is an architectural implementation of a zero-cloud, client-side recording solution built on Google Chrome's **Manifest V3** specification. 

This document details the internal subsystems, audio mixing graph, IndexedDB streaming storage engine, IPC communication model, and EBML metadata patching pipeline.

---

## 1. Subsystem Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Google Meet Web Page                            │
│                                                                        │
│   [Meet Captions DOM]       [Microphone Mute State]   [Floating Badge] │
│            │                           │                     ▲         │
│            ▼                           ▼                     │         │
│  ┌───────────────────────────────────────────────────────────┴──────┐  │
│  │                    src/scrapingScript.ts                         │  │
│  │    MutationObserver (Captions, Mute buttons, Meeting exit)       │  │
│  └───────────────────────────────┬──────────────────────────────────┘  │
└──────────────────────────────────┼─────────────────────────────────────┘
                                   │ chrome.runtime.sendMessage
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 Background Service Worker (src/background.ts)          │
│  - Tab capture streamId acquisition (chrome.tabCapture)                │
│  - Offscreen document lifecycle management                             │
│  - Dual state mirroring (Memory + chrome.storage.session)              │
│  - Port Keep-Alive heartbeat timer (15s interval)                      │
│  - Chrome Downloads API dispatch                                       │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ chrome.runtime.Port ('offscreen')
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 Offscreen Document (src/offscreen.ts)                  │
│  - Web Audio API (AudioContext, GainNode, MediaStreamDestination)      │
│  - Dynamic Hardware Mic acquisition & release                          │
│  - MediaRecorder (5,000ms time slice)                                  │
│  - Smart Tab Audio Passthrough preservation                            │
│  - Direct IndexedDB chunk writes                                       │
└────────────────────────┬───────────────────┬───────────────────────────┘
                         │                   │
                         ▼                   ▼
┌────────────────────────────────┐ ┌────────────────────────────────────┐
│      MeetRecorderDB (db.ts)    │ │      EBML Patcher (webmFix.ts)     │
│ - ObjectStores:                │ │ - Binary search for Info & Segment │
│   • sessions                   │ │ - Injects Duration & SeekHead tags │
│   • chunks                     │ │ - Zero-dependency Matroska parser  │
│   • captions                   │ └────────────────────────────────────┘
└────────────────────────────────┘
```

---

## 2. Web Audio Topology & Routing Pipeline

Chromium's `tabCapture` API automatically mutes the captured tab's native audio output to avoid double playback. The extension creates an internal Web Audio graph in `src/offscreen.ts` that accomplishes three goals:
1. Mixes tab audio with microphone input for the recording.
2. Plays tab audio back to the user's speakers so participants remain audible.
3. Prevents microphone audio from looping back to the user's speakers (sidetone feedback prevention).

### Audio Graph Diagram

```
[Google Meet Tab Audio] ───────────────┬───────────────────────────────┐
                                       ▼                               ▼
                           [tabAudioSourceNode]              [audioContext.destination]
                                       │                        (User Speakers)
                                       ▼
                       [mixedDestNode (AudioDestination)]
                                       ▲
                                       │ (1.0 when open / Disconnected when muted)
                                [micGainNode]
                                       ▲
                                       │
                              [micAudioSourceNode]
                                       ▲
                                       │
                            [User Microphone Stream]
                          (getUserMedia / Dynamic HW)
```

### Critical Constraints
- **Sidetone Elimination:** `micAudioSourceNode` connects solely to `micGainNode -> mixedDestNode`. It is **never** connected to `audioContext.destination`.
- **Continuous Tab Passthrough:** When a recording session finishes, `cleanupStreams(keepTabAudio = true)` closes only the MediaRecorder, mic stream, and mixer destination. The `tabAudioSourceNode -> audioContext.destination` connection remains active so meeting audio continues uninterrupted.

---

## 3. Dynamic Microphone Hardware Release

Most extensions hold an open microphone stream for the entire duration of a recording and simply set `micTrack.enabled = false` or `gainNode.gain.value = 0` when muted. However, holding an open hardware track causes Chrome and the host operating system to display a persistent red "microphone in use" indicator, raising user privacy concerns.

### Lifecycle Model

1. **State Detection (`src/scrapingScript.ts`):**
   - Monitors the primary Google Meet microphone button (`button[data-is-muted]` or aria-labels containing `Ctrl+D` / `⌘+D`).
   - Detects shortcut keypresses (<kbd>Ctrl</kbd>+<kbd>D</kbd>).
   - Throttles mutations and dispatches `MEET_MUTE_TOGGLED` with `{ isMuted: boolean }`.
2. **Hardware Deallocation (`src/offscreen.ts`):**
   - When `isMuted === true`:
     - Disconnects `micAudioSourceNode` and `micGainNode`.
     - Calls `track.stop()` on all microphone tracks.
     - Destroys references so the OS indicator dismisses.
3. **Dynamic Re-Acquisition:**
   - When `isMuted === false`:
     - Invokes `navigator.mediaDevices.getUserMedia({ audio: ... })`.
     - Recreates the source node and connects it back into `mixedDestNode`.
   - Concurrency locks (`isMicStateUpdating` and `pendingMicStateUpdate`) prevent race conditions if the user rapidly toggles mute.

---

## 4. IndexedDB Streaming Engine (`src/db.ts`)

### Why IndexedDB instead of Memory Arrays?
In standard browser environments, buffering hours of 1080p video in a JavaScript array (`const chunks = []`) causes the V8 heap to exceed its memory ceiling (~2GB to 4GB), crashing the renderer process and losing the entire recording.

### Storage Scheme
- **Database:** `MeetRecorderDB` (Version 2)
- **Stores:**
  - `sessions`: Session metadata (sessionId, startedAt, endedAt, status, chunkCount).
  - `chunks`: Keyed by `[sessionId, sequence]`. Stores individual binary `Blob` objects.
  - `captions`: Keyed by `[sessionId, timestamp]`. Stores scraped caption dialogue lines.

### Pipeline:
1. `MediaRecorder.start(5000)` produces slices every 5 seconds.
2. In `ondataavailable`, each slice is asynchronously committed to `MeetRecorderDB` via an IndexedDB transaction.
3. Once written, the chunk reference is deleted from offscreen RAM.
4. On stop, chunks are assembled sequentially using an `IDBCursor` ordered by `sequence`.
5. If the tab crashes mid-session, the chunks remain intact in IndexedDB and can be recovered via the popup interface.

---

## 5. EBML Duration & Seekability Patcher (`src/webmFix.ts`)

Standard `MediaRecorder` WebM output is structured for live streaming; it writes `-1` or omits duration fields because the total length is unknown when recording starts. As a result, media players cannot seek or scrub through the video.

### Patch Algorithm:
1. Slices the first 2MB of the assembled WebM file without loading the entire video into RAM.
2. Reads EBML element IDs and Variable-Size Integers (VINT).
3. Locates the `Segment` (ID `0x18538067`) and `Info` (ID `0x1549A966`) blocks.
4. Inspects `TimecodeScale` (defaults to 1,000,000 ns).
5. If a `Duration` element exists, updates its IEEE-754 float bytes.
6. If missing, injects a new 11-byte `Duration` element (`0x4489` + `0x88` + 8-byte double).
7. Rebuilds the header and joins it with the remainder of the video blob using lazy slice references:
   ```typescript
   return new Blob([before, durationElement, after, blob.slice(sliceSize)], { type: blob.type });
   ```

---

## 6. Manifest V3 Service Worker Lifecycle Persistence

Chrome Manifest V3 terminates background service workers after 30 seconds of inactivity or after 5 minutes of continuous operation.

### Mitigation Strategies:
1. **Port Keep-Alive:** The offscreen document maintains an open `chrome.runtime.Port` connection to the service worker.
2. **Heartbeat Pings:** The service worker runs an interval timer sending `HEARTBEAT` messages every 15 seconds.
3. **Session Storage Fallback:** Global state variables (such as `activeRecordingTabId`, `sessionId`, and `recording`) are mirrored to `chrome.storage.session`.
4. **Wakeup State Recovery:** If the service worker wakes up from suspension to process an event (such as `chrome.tabs.onRemoved` when a user closes a meeting tab), it loads the active `tabId` from session storage before executing the auto-finalize sequence.
