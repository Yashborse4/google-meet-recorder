// src/scrapingScript.ts
// Production-Ready Google Meet Content Script:
// - Control bar button injection (stable ARIA selectors, native Meet geometry)
// - In-viewport persistent floating badge & live timer (full-screen feedback)
// - Google Meet Mute Sync (monitors mic button -> sends MEET_MUTE_TOGGLED)
// - Multi-tier resilient caption scraper & telemetry (persists to MeetRecorderDB via CAPTION_RECORD)
// - Auto-stop on call exit / disconnect ("You left the meeting" detection & beforeunload)
// - Offline resilience (network dropout immunity)

// --- State Variables ---
let isRecording = false;
let recordingStartTime = 0;
let timerInterval: number | null = null;
let lastKnownMuteState: boolean | null = null;

// In-memory transcript buffer for manual popup export compatibility
const transcriptBuffer: string[] = [];

// --- Helper Functions ---
function formatDuration(elapsedMs: number): string {
  const totalSec = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// --- Screen Wake Lock: Keeps display & Meet tab awake while recording ---
let screenWakeLock: any = null;

async function requestScreenWakeLock() {
  try {
    if ('wakeLock' in navigator && (navigator as any).wakeLock) {
      screenWakeLock = await (navigator as any).wakeLock.request('screen');
      screenWakeLock.addEventListener('release', () => {
        screenWakeLock = null;
        if (isRecording) {
          requestScreenWakeLock().catch(() => {});
        }
      });
      console.log('[MeetContentScript] Screen Wake Lock acquired (display will not sleep)');
    }
  } catch (err) {
    console.log('[MeetContentScript] Screen Wake Lock error or denied:', err);
  }
}

function releaseScreenWakeLock() {
  try {
    if (screenWakeLock) {
      screenWakeLock.release().catch(() => {});
      screenWakeLock = null;
      console.log('[MeetContentScript] Screen Wake Lock released');
    }
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isRecording && !screenWakeLock) {
    requestScreenWakeLock().catch(() => {});
  }
});

// --- 1. In-Viewport Floating Badge ---
let floatingBadge: HTMLDivElement | null = null;
let floatingTimerEl: HTMLSpanElement | null = null;
let floatingLabelEl: HTMLSpanElement | null = null;
let floatingDotEl: HTMLSpanElement | null = null;

function createFloatingBadge() {
  if (document.getElementById('gmeet-rec-floating-badge')) return;

  floatingBadge = document.createElement('div');
  floatingBadge.id = 'gmeet-rec-floating-badge';
  floatingBadge.style.cssText = `
    position: fixed;
    top: 18px;
    left: 20px;
    z-index: 2147483647;
    display: none;
    align-items: center;
    gap: 8px;
    background: rgba(32, 33, 36, 0.92);
    border: 1px solid rgba(234, 67, 53, 0.6);
    color: #ffffff;
    padding: 6px 14px;
    border-radius: 24px;
    font-family: 'Google Sans', Roboto, Arial, sans-serif;
    font-size: 13px;
    font-weight: 500;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    cursor: pointer;
    user-select: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
  `;

  // Pulsing red dot
  floatingDotEl = document.createElement('span');
  floatingDotEl.style.cssText = `
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background-color: #ea4335;
    display: inline-block;
    box-shadow: 0 0 8px #ea4335;
    animation: gmeet-rec-pulse 1.4s infinite;
  `;

  // Inject CSS animation
  if (!document.getElementById('gmeet-rec-styles')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'gmeet-rec-styles';
    styleEl.textContent = `
      @keyframes gmeet-rec-pulse {
        0% { transform: scale(0.95); opacity: 0.8; box-shadow: 0 0 0 0 rgba(234, 67, 53, 0.7); }
        70% { transform: scale(1.15); opacity: 1; box-shadow: 0 0 0 8px rgba(234, 67, 53, 0); }
        100% { transform: scale(0.95); opacity: 0.8; box-shadow: 0 0 0 0 rgba(234, 67, 53, 0); }
      }
      @keyframes gmeet-rec-slide-in {
        from { transform: translateY(-12px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
      .gmeet-rec-btn-hover:hover {
        background-color: rgba(234, 67, 53, 0.15) !important;
      }
    `;
    document.head.appendChild(styleEl);
  }

  floatingLabelEl = document.createElement('span');
  floatingLabelEl.textContent = 'REC';
  floatingLabelEl.style.cssText = 'color: #ea4335; font-weight: 700; letter-spacing: 0.5px;';

  floatingTimerEl = document.createElement('span');
  floatingTimerEl.textContent = '00:00';

  const stopHint = document.createElement('span');
  stopHint.textContent = '✕';
  stopHint.title = 'Stop recording';
  stopHint.style.cssText = 'margin-left: 6px; font-size: 11px; opacity: 0.7;';

  floatingBadge.appendChild(floatingDotEl);
  floatingBadge.appendChild(floatingLabelEl);
  floatingBadge.appendChild(floatingTimerEl);
  floatingBadge.appendChild(stopHint);

  floatingBadge.addEventListener('click', () => {
    if (isRecording) {
      flushPendingCaptions();
      chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {});
    }
  });

  document.body.appendChild(floatingBadge);
}

// --- 2. Google Meet Recording State & WakeLock Management ---
let isPaused = false;
function updateRecordingUI(recording: boolean, paused: boolean = false) {
  isRecording = recording;
  isPaused = paused;

  if (recording && !paused) {
    requestScreenWakeLock().catch(() => {});
  } else {
    releaseScreenWakeLock();
  }

  if (floatingBadge) {
    floatingBadge.style.display = recording ? 'flex' : 'none';
    if (paused) {
      floatingBadge.style.opacity = '0.7';
      if (floatingLabelEl) {
        floatingLabelEl.textContent = 'PAUSED';
        floatingLabelEl.style.color = '#f59e0b';
      }
      if (floatingDotEl) {
        floatingDotEl.style.backgroundColor = '#f59e0b';
        floatingDotEl.style.boxShadow = 'none';
        floatingDotEl.style.animation = 'none';
      }
    } else {
      floatingBadge.style.opacity = '1';
      if (floatingLabelEl) {
        floatingLabelEl.textContent = 'REC';
        floatingLabelEl.style.color = '#ea4335';
      }
      if (floatingDotEl) {
        floatingDotEl.style.backgroundColor = '#ea4335';
        floatingDotEl.style.boxShadow = '0 0 8px #ea4335';
        floatingDotEl.style.animation = 'gmeet-rec-pulse 1.4s infinite';
      }
    }
  }

  if (recording) {
    if (!recordingStartTime) recordingStartTime = Date.now();
    const elapsed = Date.now() - recordingStartTime;
    if (floatingTimerEl) floatingTimerEl.textContent = formatDuration(elapsed);

    if (!paused) {
      if (!timerInterval) {
        timerInterval = window.setInterval(() => {
          const curElapsed = Date.now() - recordingStartTime;
          const formatted = formatDuration(curElapsed);
          if (floatingTimerEl) floatingTimerEl.textContent = formatted;
        }, 1000);
      }
    } else if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  } else {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    recordingStartTime = 0;
  }
}

// --- 3. Google Meet Mute Sync Observer ("Hot Mic" Privacy Protection) ---
function checkMeetMuteState() {
  const micBtn =
    document.querySelector<HTMLElement>('button[data-is-muted]') ||
    document.querySelector<HTMLElement>('button[aria-label*="microphone" i]');

  if (!micBtn) return;

  // Google Meet sets data-is-muted="true" | "false", or aria-label="Turn on microphone" (meaning it is currently off/muted)
  const isMutedAttr = micBtn.getAttribute('data-is-muted');
  const ariaLabel = (micBtn.getAttribute('aria-label') || '').toLowerCase();

  let isMuted = false;
  if (isMutedAttr !== null) {
    isMuted = isMutedAttr === 'true';
  } else if (ariaLabel.includes('turn on microphone') || ariaLabel.includes('unmute')) {
    isMuted = true;
  }

  if (lastKnownMuteState !== isMuted) {
    lastKnownMuteState = isMuted;
    chrome.runtime.sendMessage({ type: 'MEET_MUTE_TOGGLED', isMuted }).catch(() => {});
    console.log(`[MeetContentScript] Detected Google Meet mute state change: isMuted=${isMuted}`);
  }
}

// --- 4. Resilient Multi-Tier Caption Scraper ---
interface Chunk {
  startTime: number;
  endTime: number;
  speaker: string;
  text: string;
}
type OpenChunk = Chunk & { timer: number };

const CHUNK_GRACE_MS = 2000;
const prior = new Map<string, OpenChunk>();
const lastSeen = new Map<string, string>();

const normalize = (pre: string) =>
  pre.toLowerCase().replace(/[.,?!'"\u2019]/g, '').replace(/\s+/g, ' ').trim();

function handleCaption(speakerKey: string, speakerName: string, rawText: string) {
  if (isPaused) return; // Do not record captions while paused
  const text = rawText.trim();
  if (!text) return;

  const norm = normalize(text);
  const prev = lastSeen.get(speakerKey);
  if (prev === norm) return;
  lastSeen.set(speakerKey, norm);

  const now = Date.now();
  const existing = prior.get(speakerKey);

  if (!existing) {
    const timer = window.setTimeout(() => commit(speakerKey), CHUNK_GRACE_MS);
    prior.set(speakerKey, {
      startTime: now,
      endTime: now,
      speaker: speakerName,
      text,
      timer,
    });
    return;
  }

  existing.endTime = now;
  existing.text = text;
  existing.speaker = speakerName;

  clearTimeout(existing.timer);
  existing.timer = window.setTimeout(() => commit(speakerKey), CHUNK_GRACE_MS);
}

function commit(key: string) {
  const entry = prior.get(key);
  if (!entry) return;

  const startTS = new Date(entry.startTime).toISOString();
  const endTS = new Date(entry.endTime).toISOString();
  const line = `[${startTS}] [${endTS}] ${entry.speaker} : ${entry.text}`.trim();
  transcriptBuffer.push(line);

  // Relay to background/offscreen for MeetRecorderDB persistence
  chrome.runtime.sendMessage({
    type: 'CAPTION_RECORD',
    speaker: entry.speaker,
    text: entry.text,
  }).catch(() => {});

  clearTimeout(entry.timer);
  prior.delete(key);
}

function flushPendingCaptions() {
  [...prior.keys()].forEach(commit);
}

// Multi-Tier Selectors
const KNOWN_CAPTION_TEXT_CLASSES = ['.ygicle', '.nMcdL .ygicle'];
const KNOWN_SPEAKER_CLASSES = ['.NWpY1d'];
const KNOWN_CAPTION_CONTAINER_CLASSES = ['.nMcdL'];

// Track per-node MutationObservers to prevent leaks during long meetings
const captionNodeObservers: Set<MutationObserver> = new Set();

function scanCaptionNode(cl: HTMLElement) {
  let txtNode: HTMLElement | null = null;
  let speakerName = 'Speaker';

  // Tier 1: Known classes
  for (const sel of KNOWN_CAPTION_TEXT_CLASSES) {
    const found = cl.querySelector<HTMLElement>(sel);
    if (found) {
      txtNode = found;
      break;
    }
  }

  for (const sel of KNOWN_SPEAKER_CLASSES) {
    const s = cl.querySelector<HTMLElement>(sel);
    if (s?.textContent?.trim()) {
      speakerName = s.textContent.trim();
      break;
    }
  }

  // Tier 2: Semantic / Data-attribute heuristics
  if (!txtNode) {
    txtNode = cl.querySelector<HTMLElement>('[data-participant-id] + div') ||
              cl.querySelector<HTMLElement>('div[jsname]') ||
              (cl.childElementCount > 0 ? (cl.lastElementChild as HTMLElement) : null);
  }

  if (speakerName === 'Speaker') {
    const partId = cl.getAttribute('data-participant-id');
    const avatarImg = cl.querySelector<HTMLImageElement>('img[alt]');
    speakerName = avatarImg?.alt?.trim() || partId || 'Speaker';
  }

  if (!txtNode) {
    console.warn('[MeetCaptionScraper] Warning: Caption container found but text node could not be resolved.');
    return;
  }

  const key = cl.getAttribute('data-participant-id') || speakerName;

  const push = () => {
    const trimmed = txtNode?.textContent?.trim() ?? '';
    if (trimmed) handleCaption(key, speakerName, trimmed);
  };

  push();
  const obs = new MutationObserver(push);
  obs.observe(txtNode, { childList: true, subtree: true, characterData: true });
  captionNodeObservers.add(obs);
}

let captionRegionObserver: MutationObserver | null = null;

function launchCaptionRegionObserver(region: HTMLElement) {
  captionRegionObserver?.disconnect();

  // Disconnect all existing per-node observers to prevent accumulation
  captionNodeObservers.forEach((obs) => { try { obs.disconnect(); } catch {} });
  captionNodeObservers.clear();

  captionRegionObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) {
          // Check known container or any block element inside the region
          let matched = false;
          for (const sel of KNOWN_CAPTION_CONTAINER_CLASSES) {
            if (node.matches(sel) || node.querySelector(sel)) {
              scanCaptionNode(node.matches(sel) ? node : (node.querySelector(sel) as HTMLElement));
              matched = true;
              break;
            }
          }
          if (!matched && node.childElementCount > 0) {
            scanCaptionNode(node);
          }
        }
      });
    });
  });

  captionRegionObserver.observe(region, { childList: true, subtree: true });
  console.log('[MeetCaptionScraper] Caption region observer attached successfully.');

  // Initial scan
  region.querySelectorAll<HTMLElement>('.nMcdL').forEach(scanCaptionNode);
}

// --- 5. Auto-Stop on Disconnect / Call Exit ---
function checkForMeetingExit() {
  if (!isRecording) return;

  const textContent = document.body.innerText || '';
  const exitPhrases = [
    'You left the meeting',
    'Return to home screen',
    'You have been removed from the meeting',
    'You’ve been removed from the meeting',
    'The meeting has ended for everyone',
  ];

  for (const phrase of exitPhrases) {
    if (textContent.includes(phrase)) {
      console.log(`[MeetContentScript] Detected exit phrase: "${phrase}". Auto-finalizing recording...`);
      flushPendingCaptions();
      chrome.runtime.sendMessage({ type: 'FINALIZE_RECORDING' }).catch(() => {});
      updateRecordingUI(false);
      break;
    }
  }
}

// Tab navigation / unload listener
window.addEventListener('beforeunload', () => {
  if (isRecording) {
    flushPendingCaptions();
    chrome.runtime.sendMessage({ type: 'FINALIZE_RECORDING' }).catch(() => {});
  }
});

// Offline / Network disconnect resilience
window.addEventListener('offline', () => {
  console.warn('[MeetContentScript] Internet connection dropped. Recording will continue locally.');
  if (floatingBadge) {
    floatingBadge.style.borderColor = '#F59E0B'; // Orange for warning
    floatingBadge.title = 'Offline - Recording locally';
  }
});
window.addEventListener('online', () => {
  console.log('[MeetContentScript] Internet connection restored.');
  if (floatingBadge) {
    floatingBadge.style.borderColor = 'rgba(234, 67, 53, 0.6)'; // Restore red
    floatingBadge.title = '';
  }
});

// --- Master DOM Observer ---
let _throttleMute: number | null = null;
let _throttleExit: number | null = null;

const rootObserver = new MutationObserver((mutations) => {
  // Skip mutations caused by our own injected elements
  const allOurs = mutations.every((m) => {
    const target = m.target as Node;
    return (
      target === floatingBadge ||
      floatingBadge?.contains(target) ||
      Array.from(m.addedNodes).every((n) => n === floatingBadge)
    );
  });
  if (allOurs) return;

  // 1. Monitor mute state (throttled 300ms)
  if (!_throttleMute) {
    _throttleMute = window.setTimeout(() => {
      _throttleMute = null;
      checkMeetMuteState();
    }, 300);
  }

  // 2. Monitor caption region (Multi-Tier ARIA region supporting all languages)
  const captionRegion =
    document.querySelector<HTMLElement>('div[role="region"][aria-label*="caption" i]') ||
    document.querySelector<HTMLElement>('div[role="region"][aria-label*="subtítulo" i]') ||
    document.querySelector<HTMLElement>('div[role="region"][aria-label*="legenda" i]') ||
    document.querySelector<HTMLElement>('div[role="region"][aria-label*="untertitel" i]') ||
    document.querySelector<HTMLElement>('div[role="region"][aria-label*="sous-titre" i]') ||
    document.querySelector<HTMLElement>('div[role="region"][aria-label*="sottotitoli" i]') ||
    document.querySelector<HTMLElement>('div[role="region"][aria-label*="transcription" i]') ||
    document.querySelector<HTMLElement>('div[role="region"][aria-label*="字幕" i]');

  if (captionRegion && !captionRegion.dataset.observerAttached) {
    captionRegion.dataset.observerAttached = 'true';
    launchCaptionRegionObserver(captionRegion);
  }

  // 3. Auto-stop on disconnect (throttled 300ms)
  if (!_throttleExit) {
    _throttleExit = window.setTimeout(() => {
      _throttleExit = null;
      checkForMeetingExit();
    }, 300);
  }
});

// --- Mic Permission Guidance on Meet link open ---
let micBannerDismissed = false;

function showMicPermissionBanner() {
  if (micBannerDismissed || document.getElementById('gmeet-rec-mic-prompt')) return;

  const banner = document.createElement('div');
  banner.id = 'gmeet-rec-mic-prompt';
  banner.style.cssText = `
    position: fixed;
    top: 18px;
    right: 20px;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 12px;
    background: #202124;
    border: 1px solid rgba(234, 67, 53, 0.7);
    color: #ffffff;
    padding: 10px 16px;
    border-radius: 10px;
    font-family: 'Google Sans', Roboto, Arial, sans-serif;
    font-size: 13px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    animation: gmeet-rec-slide-in 0.25s ease-out;
  `;

  banner.innerHTML = `
    <span style="font-size: 18px;">🎙️</span>
    <div style="display: flex; flex-direction: column; gap: 2px;">
      <span style="font-weight: 600; color: #ffffff;">Record your voice</span>
      <span style="font-size: 11px; color: #9aa0a6;">Allow microphone access for Meet Recorder</span>
    </div>
    <button id="gmeet-rec-btn-allow-mic" style="
      background: #ea4335;
      color: #ffffff;
      border: none;
      padding: 6px 14px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      white-space: nowrap;
      margin-left: 4px;
    ">Allow Mic</button>
    <button id="gmeet-rec-btn-dismiss-mic" style="
      background: transparent;
      color: #9aa0a6;
      border: none;
      font-size: 16px;
      cursor: pointer;
      padding: 2px 6px;
      line-height: 1;
    " title="Dismiss">✕</button>
  `;

  document.body.appendChild(banner);

  document.getElementById('gmeet-rec-btn-allow-mic')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'REQUEST_MIC_PERMISSION' }).catch(() => {});
  });

  document.getElementById('gmeet-rec-btn-dismiss-mic')?.addEventListener('click', () => {
    micBannerDismissed = true;
    banner.remove();
  });
}

function removeMicPermissionBanner() {
  const b = document.getElementById('gmeet-rec-mic-prompt');
  if (b) {
    b.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
    b.style.opacity = '0';
    b.style.transform = 'translateY(-10px)';
    setTimeout(() => b.remove(), 300);
  }
}

function checkAndPromptMicPermission() {
  const path = window.location.pathname;
  const isMeetCall = path.length > 5 && path !== '/' && !path.startsWith('/landing');
  if (!isMeetCall) return;

  chrome.runtime.sendMessage({ type: 'CHECK_MIC_PERMISSION' }, (res) => {
    if (chrome.runtime.lastError) return;
    if (!res?.granted) {
      showMicPermissionBanner();
    }
  });
}

// Init on DOM ready
function init() {
  createFloatingBadge();

  rootObserver.observe(document.body, { childList: true, subtree: true });

  // Immediately detect mute state so we don't assume unmuted if user joins already muted
  checkMeetMuteState();

  // Prompt for microphone permission if user opened a Meet call and hasn't granted yet
  checkAndPromptMicPermission();

  // Query background for active recording state
  try {
    chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' }, (res) => {
      if (chrome.runtime.lastError) {
        // Prevent "Unchecked runtime.lastError" in console
        return;
      }
      if (res?.recording) {
        if (res.startedAt) recordingStartTime = res.startedAt;
        updateRecordingUI(true, !!res.paused);
      }
    });
  } catch {}

  console.log('[MeetContentScript] Content script initialized.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Runtime messaging listener
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'RECORDING_STATE') {
    if (msg.startedAt) recordingStartTime = msg.startedAt;
    updateRecordingUI(!!msg.recording, !!msg.paused);
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'MIC_PERMISSION_GRANTED') {
    removeMicPermissionBanner();
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'GET_TRANSCRIPT' || msg?.type === 'FLUSH_CAPTIONS') {
    flushPendingCaptions();
    sendResponse({ ok: true, transcript: transcriptBuffer.join('\n') });
    return false;
  }

  if (msg?.type === 'RESET_TRANSCRIPT') {
    prior.clear();
    lastSeen.clear();
    transcriptBuffer.length = 0;
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

