# Google Meet Transcript & Video Recorder

[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript%205-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Webpack](https://img.shields.io/badge/Bundler-Webpack%205-8DD6F9?logo=webpack)](https://webpack.js.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-green.svg)](https://opensource.org/licenses/ISC)
[![Privacy First](https://img.shields.io/badge/Privacy-100%25%20Local-success)](#privacy--security)

A production-ready, privacy-first Google Chrome extension that records Google Meet sessions (video + two-way audio) and exports timestamped live caption transcripts (`.txt` and `.vtt`).

**100% client-side.** No third-party bots, no external servers, and zero cloud uploads. All audio processing, video encoding, chunk streaming, and transcript parsing happen directly in your browser.

---

## Table of Contents

- [Key Features](#key-features)
- [How It Works](#how-it-works)
- [Architecture Overview](#architecture-overview)
- [Quick Start](#quick-start)
  - [Prerequisites](#prerequisites)
  - [Installation & Build](#installation--build)
  - [Loading into Chrome](#loading-into-chrome)
- [User Guide](#user-guide)
  - [Recording a Meeting](#recording-a-meeting)
  - [Microphone Permissions](#microphone-permissions)
  - [Customizing Settings](#customizing-settings)
  - [Crash & Orphan Recovery](#crash--orphan-recovery)
- [Project Structure](#project-structure)
- [Technical Deep Dives](#technical-deep-dives)
  - [Smart Audio Routing & Speaker Passthrough](#smart-audio-routing--speaker-passthrough)
  - [Dynamic Microphone Hardware Release](#dynamic-microphone-hardware-release)
  - [IndexedDB Chunk Streaming (Zero OOM)](#indexeddb-chunk-streaming-zero-oom)
  - [EBML Duration & Seekability Patching](#ebml-duration--seekability-patching)
  - [MV3 Service Worker State Recovery](#mv3-service-worker-state-recovery)
- [Configuration & Settings](#configuration--settings)
- [Permissions Reference](#permissions-reference)
- [Troubleshooting & FAQ](#troubleshooting--faq)
- [Contributing](#contributing)
- [License](#license)

---

## Key Features

### 🎥 High-Definition Tab Recording
- **Isolated Tab Capture:** Records exclusively the Google Meet tab using Chrome's `tabCapture` API. Desktop notifications, system beeps, and other tabs will never leak into the recording.
- **Configurable Resolutions:** Choose between **1080p Full HD** (optimized for crisp text & screen sharing via `contentHint: 'detail'`), **720p HD**, or **Native/4K**.
- **Seekable WebM Files:** Out-of-the-box native duration and seekhead injection into WebM files using an integrated EBML patcher. Videos are instantly scrubbable and seekable in VLC, QuickTime, Chrome, and video editors without conversion.

### 🎙️ Two-Way Audio Mixing with Privacy Control
- **Unified Audio Track:** Combines participant voices (tab audio) and your voice (microphone) into a crystal-clear single audio track via Web Audio API.
- **Continuous Speaker Passthrough:** When Chrome captures tab audio, it auto-mutes the native tab. This extension routes meeting audio through an `AudioContext` directly to your speakers—and **preserves the passthrough after recording stops**, so meeting audio never goes silent.
- **Dynamic Mic Hardware Release:** When you mute yourself inside Google Meet (via UI or <kbd>Ctrl</kbd>+<kbd>D</kbd>), the extension automatically releases the microphone hardware stream. The browser/OS microphone recording indicator turns off completely while you are muted.
- **Sidetone Feedback Protection:** Your microphone is routed strictly to the recorder destination—never back to your own speakers—preventing echo loops and latency distractions.

### 📝 Resilient Transcript & Subtitle Export
- **Multi-Tier Scraper:** Observes Google Meet live captions using resilient multi-tier selectors (multilingual ARIA labels and structural observation) rather than fragile, minified class names.
- **Dual Format Output:**
  - **Plain Text (`.txt`):** Formatted, human-readable transcript with speaker names and timestamps.
  - **WebVTT (`.vtt`):** Standard subtitle file that can be loaded alongside the WebM video in media players.
- **Granular Download Toggles:** Configure whether video, `.txt`, or `.vtt` files download automatically upon stopping the recording (available in both the standard flow and crash recovery).

### 🛡️ Crash & OOM Resilience
- **5-Second Chunk Partitioning:** Media slices are flushed to local IndexedDB (`MeetRecorderDB`) every 5 seconds. The extension maintains a flat memory footprint, easily handling multi-hour meetings without hitting browser tab memory limits.
- **Crash Recovery UI:** If Chrome crashes, a tab closes abruptly, or a power outage occurs, the popup automatically detects the orphaned session in IndexedDB and offers one-click recovery and download.

### 🖥️ In-Meeting Native Integration
- **Persistent Viewport Badge:** Injects a sleek, draggable floating badge (`REC 00:00`) directly inside the Google Meet viewport with real-time duration and one-click stop. Stays visible even when controls auto-hide or in full-screen mode.
- **Screen Wake Lock:** Automatically requests screen wake lock during active recordings to prevent your display or system from sleeping mid-meeting.
- **Auto-Stop on Exit:** Automatically finalizes and downloads recordings when you leave the meeting or close the tab.

---

## How It Works

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Google Meet Browser Tab                         │
│                                                                        │
│   [Live Captions DOM]        [Mute / Controls Bar]     [Floating Badge]│
│            │                           │                      │        │
│            ▼                           ▼                      ▼        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │             Content Script (src/scrapingScript.ts)               │  │
│  └──────────────────┬──────────────────┬────────────────────────────┘  │
└─────────────────────┼──────────────────┼───────────────────────────────┘
                      │ (Captions/Mute)  │ (State Updates)
                      ▼                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 Background Service Worker (src/background.ts)          │
│  - Tab capture streamId coordination                                   │
│  - Session state persistence in chrome.storage.session                 │
│  - Port Keep-Alive management & downloads dispatcher                   │
└─────────────────────┬──────────────────┬───────────────────────────────┘
                      │                  │
                      │ (RPC via Port)   │ (Download Events)
                      ▼                  ▼
┌──────────────────────────────────────┐ ┌───────────────────────────────┐
│ Offscreen Document (offscreen.ts)    │ │ Browser Downloads API         │
│  - Web Audio Context & Gain routing  │ │  - GoogleMeet-Recording.webm  │
│  - MediaRecorder (5s time-slice)     │ │  - GoogleMeet-Transcript.txt  │
│  - Direct-to-IndexedDB streaming     │ │  - GoogleMeet-Transcript.vtt  │
│  - EBML Duration Patcher (webmFix.ts)│ └───────────────────────────────┘
└──────────────────┬───────────────────┘
                   │ (Write/Read Chunks)
                   ▼
┌──────────────────────────────────────┐
│ MeetRecorderDB (src/db.ts)           │
│  - Sessions / Chunks / Captions      │
└──────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites
- **Google Chrome** (or Chromium-based browser such as Brave, Edge, or Opera) version 109+ (supporting Manifest V3 & Offscreen Documents).
- **Node.js** 18.0.0 or higher.
- **npm** (comes with Node.js) or `pnpm` / `yarn`.

### Installation & Build

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Yashborse4/google-meet-recorder.git
   cd google-meet-recorder
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build the extension:**
   ```bash
   npm run build
   ```
   *This compiles the TypeScript code and bundles assets into the `./dist` directory.*

### Loading into Chrome

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button in the top-left corner.
4. Select the `./dist` folder from this project directory.
5. The extension icon will now appear in your browser toolbar (pin it for convenience).

---

## User Guide

### Recording a Meeting

1. Join or start any Google Meet meeting at `https://meet.google.com/...`.
2. Turn **Captions** on in Google Meet (keyboard shortcut: <kbd>C</kbd>) if you want transcripts to be recorded.
3. Click the **Google Meet Recorder** extension icon in your toolbar.
4. Click **Start Recording**.
   - A floating **REC 00:00** badge will appear in the top-left of your Google Meet tab.
   - The extension badge in the toolbar will indicate `REC`.
5. When finished, either click the **Stop & Save** button in the extension popup or click the floating badge inside the meeting.
6. The extension will automatically finalize the video, patch the headers, generate the transcripts, and save the files to your downloads folder.

### Microphone Permissions

To record your own voice alongside the meeting participants:
1. Open the extension popup and check the **Auto-Mix Microphone** toggle.
2. If prompted, click **Enable Microphone** or visit the built-in permission setup page (`micsetup.html`).
3. Once granted, your voice is automatically mixed into recordings.

### Customizing Settings

Click the gear icon (⚙️) in the top-right of the extension popup to access settings:

| Setting | Default | Description |
| :--- | :---: | :--- |
| **Video Recording (.webm)** | `ON` | Download the seekable `.webm` video recording on stop. |
| **Meeting Transcript (.txt)** | `ON` | Download the readable plain-text transcript with speaker tags. |
| **Subtitle Track (.vtt)** | `ON` | Download the WebVTT subtitle file for media players. |
| **Recording Quality** | `1080p` | Choose between **1080p (Full HD)**, **720p (HD)**, or **Native / 4K**. |
| **Auto-Mix Microphone** | `ON` | Include your own microphone audio in the recording. |
| **Echo & Noise Cancellation** | `ON` | Apply software noise suppression to microphone input. |
| **Auto-Stop on Exit** | `ON` | Automatically finalize and download when you leave or close the call. |

### Crash & Orphan Recovery

If your tab or browser closes unexpectedly mid-meeting:
1. Re-open Chrome and click the extension popup icon.
2. If incomplete chunks are found in local IndexedDB, an orange **Unsaved Recording Found** card will appear.
3. Click **Recover & Save Files** to compile the stored chunks and download the video and transcripts up to the point of interruption.
4. Alternatively, click **Clear Cached Sessions** in the settings view to discard old data.

---

## Project Structure

```
├── manifest.json              # Manifest V3 extension configuration
├── package.json               # Dependencies and build scripts
├── tsconfig.json              # TypeScript compilation configuration
├── webpack.config.js          # Webpack bundling and asset pipeline
├── popup.html                 # Extension popup interface & settings view
├── offscreen.html             # Host page for the offscreen recording engine
├── micsetup.html              # Dedicated user-facing microphone permission page
├── icons/                     # Extension icons (16px, 32px, 48px, 128px, svg)
├── src/
│   ├── background.ts          # MV3 Service Worker (keep-alive, port, state, downloads)
│   ├── offscreen.ts           # MediaRecorder, Web Audio graph, dynamic mic, streams
│   ├── scrapingScript.ts      # Content script (Meet captions, mute sync, floating UI)
│   ├── popup.ts               # Popup UI logic, crash recovery, settings management
│   ├── settings.ts            # Extension settings storage schema (sync/local fallback)
│   ├── db.ts                  # MeetRecorderDB IndexedDB engine (sessions, chunks, captions)
│   ├── webmFix.ts             # Zero-dependency EBML duration & seekhead patcher
│   └── micsetup.ts            # Permissions helper logic
└── dist/                      # Webpack production build output (loaded into Chrome)
```

---

## Technical Deep Dives

### Smart Audio Routing & Speaker Passthrough
When Chrome captures a tab via `chrome.tabCapture`, the browser automatically mutes native tab audio output to prevent double-playback. To ensure the user can hear other participants, the extension routes captured tab audio into an `AudioContext` connected to `audioContext.destination` (speakers).

**The Challenge:** Traditional extensions close the `AudioContext` and stop tab audio tracks when recording stops, causing the meeting tab to go completely silent for the remainder of the call.

**The Solution:** In `src/offscreen.ts`, `cleanupStreams(keepTabAudio)` selectively performs partial teardown. Recording-specific resources (MediaRecorder, mic stream, mixer destination) are closed, but the `tabAudio -> audioContext.destination` pipeline is preserved alive. A deferred track listener (`passThroughTrack.addEventListener('ended')`) automatically cleans up the remaining audio context only when the meeting tab is actually closed or navigated away.

### Dynamic Microphone Hardware Release
To respect user privacy and prevent confusion:
1. `src/scrapingScript.ts` observes the Google Meet microphone toggle button and shortcuts (<kbd>Ctrl</kbd>+<kbd>D</kbd>).
2. When the user mutes themselves in Google Meet, `MEET_MUTE_TOGGLED` is dispatched.
3. `src/offscreen.ts` halts the physical microphone stream via `track.stop()`. This causes the operating system and browser "microphone in use" recording indicator to disappear.
4. When unmuted, the extension seamlessly re-acquires `getUserMedia` and reconnects it to the audio mixing graph without causing audio buffer glitches.

### IndexedDB Chunk Streaming (Zero OOM)
Instead of buffering an entire recording in a JavaScript array in RAM (which crashes with Out-of-Memory on meetings longer than 45–60 minutes):
1. `MediaRecorder.start(5000)` delivers chunks every 5 seconds.
2. In `ondataavailable`, each chunk is immediately written to IndexedDB (`MeetRecorderDB`) and garbage-collected from V8 memory.
3. During finalization, chunks are retrieved sequentially using an `IDBCursor` and merged into a Blob.

### EBML Duration & Seekability Patching
By default, browser `MediaRecorder` outputs WebM streams with an unknown duration header (`-1` or missing `Duration`), making them unseekable in video players.
`src/webmFix.ts` parses the Matroska/EBML container structure of the first 2MB slice of the file and calculates the actual duration from the recorded timestamp deltas. It then dynamically injects an accurate `Duration` element into the `Segment -> Info` block without reading the full video into memory.

### MV3 Service Worker State Recovery
In Manifest V3, Chrome service workers can be suspended after idle periods.
- `src/background.ts` keeps a persistent port connection with the offscreen document and runs a 15-second heartbeat timer.
- The active recording `tabId` and session status are mirrored to `chrome.storage.session`.
- When Chrome dispatches events such as `chrome.tabs.onRemoved` (tab closed) while the service worker was suspended, the service worker immediately restores the `tabId` from session storage before evaluating auto-stop logic.

---

## Configuration & Settings

You can inspect or modify settings programmatically via `src/settings.ts`:

```typescript
export interface ExtensionSettings {
  saveVideo: boolean;           // Auto-download .webm video on stop
  saveTxtTranscript: boolean;   // Auto-download .txt transcript on stop
  saveVttSubtitles: boolean;    // Auto-download .vtt subtitles on stop
  videoQuality: '1080p' | '720p' | 'max'; // Capture resolution
  autoMixMic: boolean;          // Mix microphone audio
  noiseSuppression: boolean;    // Hardware/software noise cancellation
  autoStopOnExit: boolean;      // Stop recording when meeting tab closes
}
```

---

## Permissions Reference

| Permission | Purpose |
| :--- | :--- |
| `tabCapture` | Capture audio and video stream directly from the active Google Meet tab. |
| `desktopCapture` | Fallback screen capture mechanism if tab capture is unavailable. |
| `offscreen` | Spawn a hidden background document with DOM access for `MediaRecorder` and `AudioContext`. |
| `downloads` | Save the generated `.webm`, `.txt`, and `.vtt` files directly to your machine. |
| `storage` | Store user settings across sessions and persist session states. |
| `activeTab`, `tabs` | Identify Google Meet tabs, coordinate recording IDs, and detect tab closure. |
| `power` | Keep system and display awake during long active recordings. |
| `https://meet.google.com/*` | Restrict content script execution strictly to Google Meet URLs. |

---

## Troubleshooting & FAQ

#### Q: Why is my transcript file empty?
> **A:** Transcripts are generated from Google Meet's live captions. Make sure captions are turned **ON** in Google Meet (click the "CC" button in Meet or press <kbd>C</kbd> on your keyboard).

#### Q: Meeting audio went silent after stopping the recording.
> **A:** This was an issue in early versions caused by Chrome auto-muting the tab during tab capture. Make sure you are using the latest version from this repository, where tab audio passthrough is kept alive continuously.

#### Q: How do I change the download folder?
> **A:** Files are saved via Chrome's native Downloads system. You can change your default download destination in Chrome Settings under `chrome://settings/downloads`.

#### Q: Can I run this in development with auto-rebuild?
> **A:** Yes. Run:
> ```bash
> npm run watch
> ```
> Whenever you make a change, Webpack will automatically recompile. Then go to `chrome://extensions` and click the reload icon on the extension card.

---

## Contributing

Contributions, bug reports, and feature requests are welcome!

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/amazing-feature`.
3. Commit your changes: `git commit -m 'Add amazing feature'`.
4. Push to the branch: `git push origin feature/amazing-feature`.
5. Open a Pull Request.

---

## License

This project is licensed under the [ISC License](LICENSE).
