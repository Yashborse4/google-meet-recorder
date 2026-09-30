// src/offscreen.ts
// Production-Ready Offscreen Recording Engine:
// - Direct IndexedDB 5s chunk streaming (MeetRecorderDB)
// - Strict Web Audio routing topology (no sidetone, tab audio to local speakers)
// - Google Meet mute sync via GainNode
// - Zero-dependency EBML duration patching (scrubbable WebM)
// - WebVTT subtitle export alongside video
// - AudioContext autoplay suspension protection

import { recorderDB } from './db';
import { fixWebmDuration } from './webmFix';
import { getSettings } from './settings';

const WANT_MIC_MIX = true;

window.addEventListener('error', (e) => {
  console.error('[offscreen] window.onerror', e?.message, e?.error);
});
window.addEventListener('unhandledrejection', (e: any) => {
  console.error('[offscreen] unhandledrejection', e?.reason || e);
});
window.addEventListener('beforeunload', () => {
  cleanupStreams();
});
console.log('[offscreen] script loaded');

// Port plumbing
let portRef: chrome.runtime.Port | null = null;
function log(...a: any[]) {
  console.log('[offscreen]', ...a);
}

let portReconnectTimer: ReturnType<typeof setTimeout> | null = null;

function connectPort(): chrome.runtime.Port {
  try {
    portRef?.disconnect();
  } catch {}
  const p: chrome.runtime.Port = chrome.runtime.connect({ name: 'offscreen' });
  p.onDisconnect.addListener(() => {
    log('Port disconnected');
    portRef = null;
    // Auto-reconnect after a short delay if still active
    if (capturing && !portReconnectTimer) {
      portReconnectTimer = setTimeout(() => {
        portReconnectTimer = null;
        log('Auto-reconnecting port after disconnect...');
        try { connectPort(); } catch (e) { log('Port auto-reconnect failed:', e); }
      }, 1000);
    }
  });
  // Small delay to let background's onConnect listener attach its message handler
  // before we send OFFSCREEN_READY
  setTimeout(() => {
    try {
      p.postMessage({ type: 'OFFSCREEN_READY' });
      log('READY signaled via Port');
    } catch (e) {
      log('Failed to signal READY:', e);
    }
  }, 50);
  portRef = p;
  attachRpcListener(p);
  return p;
}

function getPort(): chrome.runtime.Port {
  return portRef ?? connectPort();
}

function respond(req: any, payload: any) {
  getPort().postMessage({ __respFor: req?.__id, payload });
}

function pushState(recording: boolean, extra?: Record<string, any>) {
  try {
    (chrome.storage as any)?.session?.set?.({ recording }).catch?.(() => {});
  } catch {}
  getPort().postMessage({ type: 'RECORDING_STATE', recording, ...extra });
}

function inferSuffixFromActiveTabUrl(url?: string | null): string {
  try {
    if (!url) return 'google-meet';
    const u = new URL(url);
    const last = u.pathname.split('/').pop() || 'google-meet';
    return last;
  } catch {
    return 'google-meet';
  }
}

// Active recording state variables
let mediaRecorder: MediaRecorder | null = null;
let activeSessionId: string | null = null;
let sessionStartTime = 0;
let chunkSequence = 0;
let capturing = false;
let isPaused = false;

let audioContext: AudioContext | null = null;
let micGainNode: GainNode | null = null;
let currentMicTrack: MediaStreamTrack | null = null;
let currentMixedStream: MediaStream | null = null;

// Default to MUTED (closed): never capture mic until Google Meet explicitly confirms mic is open!
let isMeetMuted = true;
let isMicEnabledBySetting = true;

function updateMicState() {
  const shouldRecordMic = isMicEnabledBySetting && !isMeetMuted;
  if (micGainNode && audioContext) {
    micGainNode.gain.setValueAtTime(shouldRecordMic ? 1.0 : 0.0, audioContext.currentTime);
  }
  if (currentMicTrack) {
    currentMicTrack.enabled = shouldRecordMic;
  }
  log(`Mic state updated: recording=${shouldRecordMic} (settingEnabled=${isMicEnabledBySetting}, meetMuted=${isMeetMuted})`);
}

// Microphone capture
async function maybeGetMicStream(): Promise<MediaStream | null> {
  if (!WANT_MIC_MIX) return null;
  const settings = await getSettings();
  if (!settings.autoMixMic) return null;

  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: settings.noiseSuppression,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.noiseSuppression,
      },
    });
    const t = mic.getAudioTracks()[0];
    log('Mic stream acquired:', !!t, 'muted:', t?.muted, 'enabled:', t?.enabled);
    return mic;
  } catch (e) {
    log('Mic getUserMedia failed (continuing tab-only):', e);
    return null;
  }
}

/**
 * Strict Web Audio routing topology:
 * Tab Audio -> audioContext.destination (Speakers, so user hears remote participants)
 * Tab Audio -> MediaStreamAudioDestinationNode (Recorder mixed destination)
 * Mic Audio -> GainNode -> MediaStreamAudioDestinationNode (Recorder ONLY)
 *
 * CRITICAL PRIVACY & COMFORT CONSTRAINT:
 * Mic audio is NEVER connected to audioContext.destination to prevent sidetone feedback loops.
 *
 * ECHO PREVENTION:
 * When source is 'desktop', Chrome does NOT mute the tab's native audio output,
 * so we must NOT route tab audio to audioContext.destination (speakers) — only to the recorder.
 * When source is 'tab', Chrome auto-mutes the tab, so we route to speakers so user can hear.
 */
async function setupAudioMixing(tabStream: MediaStream, micStream: MediaStream | null, source: 'tab' | 'desktop' = 'tab'): Promise<MediaStream> {
  const tabAudio = tabStream.getAudioTracks()[0];
  const videoTracks = tabStream.getVideoTracks();

  if (!tabAudio && !micStream) {
    return tabStream;
  }

  const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
  audioContext = new AC();

  // Autoplay Policy & Suspension Protection
  if (audioContext.state === 'suspended') {
    log('AudioContext suspended on init; attempting resume...');
    await audioContext.resume().catch((err) => log('AudioContext resume failed:', err));
  }
  audioContext.onstatechange = () => {
    if (audioContext && audioContext.state === 'suspended' && capturing) {
      log('AudioContext auto-resuming from suspended state');
      audioContext.resume().catch(() => {});
    }
  };

  const mixedDest = audioContext.createMediaStreamDestination();

  // 1. Route Tab Audio
  if (tabAudio) {
    try {
      const tabSource = audioContext.createMediaStreamSource(new MediaStream([tabAudio]));
      // Only route to local speakers when using tabCapture (Chrome auto-mutes the tab).
      // With desktopCapture, the tab still plays audio natively — routing to speakers would echo.
      if (source === 'tab') {
        tabSource.connect(audioContext.destination);
        log('Tab audio connected to speakers (tabCapture: tab is auto-muted by Chrome)');
      } else {
        log('Tab audio NOT connected to speakers (desktopCapture: tab still plays natively, would echo)');
      }
      // Always route to recorder destination
      tabSource.connect(mixedDest);
      log('Tab audio connected to recorder destination');
    } catch (err) {
      log('Tab audio source connection failed; using raw tab audio', err);
      return tabStream;
    }
  }

  // 2. Route Mic Audio through dedicated GainNode for Mute Sync
  if (micStream) {
    const micTrack = micStream.getAudioTracks()[0];
    if (micTrack) {
      currentMicTrack = micTrack;
      try {
        const micSource = audioContext.createMediaStreamSource(new MediaStream([micTrack]));
        micGainNode = audioContext.createGain();

        // Enforce settings and Google Meet mute status
        const settings = await getSettings();
        isMicEnabledBySetting = !!settings.autoMixMic;
        updateMicState();

        micSource.connect(micGainNode);
        // Connect exclusively to recorder destination. NEVER connect to audioContext.destination!
        micGainNode.connect(mixedDest);
        log(`Mic audio connected (sidetone prevented, initial state: ${!isMeetMuted && isMicEnabledBySetting ? 'OPEN' : 'MUTED/SILENCED'})`);
      } catch (err) {
        log('Mic audio routing failed:', err);
      }
    }
  }

  return new MediaStream([...videoTracks, ...mixedDest.stream.getAudioTracks()]);
}

function makeConstraints(streamId: string, source: 'tab' | 'desktop', quality: '1080p' | '720p' | 'max' = '1080p'): MediaStreamConstraints {
  const mandatory = { chromeMediaSource: source, chromeMediaSourceId: streamId } as any;
  let maxWidth = 1920;
  let maxHeight = 1080;
  let maxFrameRate = 30;

  if (quality === '720p') {
    maxWidth = 1280;
    maxHeight = 720;
    maxFrameRate = 30;
  } else if (quality === 'max') {
    maxWidth = 3840;
    maxHeight = 2160;
    maxFrameRate = 60;
  }

  return {
    audio: {
      mandatory,
    } as any,
    video: {
      mandatory: {
        ...mandatory,
        maxWidth,
        maxHeight,
        maxFrameRate,
      },
    } as any,
  };
}

async function captureWithStreamId(streamId: string, source: 'tab' | 'desktop'): Promise<MediaStream> {
  const settings = await getSettings();
  log(`Capturing getUserMedia with streamId=${streamId} source=${source} quality=${settings.videoQuality}`);
  try {
    return await navigator.mediaDevices.getUserMedia(makeConstraints(streamId, source, settings.videoQuality));
  } catch (err: any) {
    log(`[gUM] Primary capture failed:`, err?.message || err);
    log(`[gUM] Retrying without audio constraints (user may have forgotten to check 'Share tab audio')...`);
    try {
      const videoOnlyConstraints = makeConstraints(streamId, source, settings.videoQuality);
      videoOnlyConstraints.audio = false;
      return await navigator.mediaDevices.getUserMedia(videoOnlyConstraints);
    } catch (err2: any) {
      throw new Error(`Capture failed. Primary: ${err.message}. Video-only fallback: ${err2.message}.`);
    }
  }
}

async function prepareAndRecord(baseStream: MediaStream, meetingId: string, source: 'tab' | 'desktop' = 'tab'): Promise<void> {
  const videoTracks = baseStream.getVideoTracks();
  if (!videoTracks.length) throw new Error('No video track found in captured stream');

  // CRITICAL: Set contentHint = 'detail' on all video tracks so that Chrome's
  // video encoder prioritizes text, fine lines, and slide presentations over motion smoothing
  for (const track of videoTracks) {
    if ('contentHint' in track) {
      (track as any).contentHint = 'detail';
      log('Video track contentHint set to "detail" (presentation and text clarity optimized)');
    }
  }

  const settings = await getSettings();
  const micStream = await maybeGetMicStream();
  const mixedStream = await setupAudioMixing(baseStream, micStream, source);
  currentMixedStream = mixedStream;

  // Final check on AudioContext
  if (audioContext && audioContext.state === 'suspended') {
    await audioContext.resume().catch(() => {});
  }

  // Audio-aware Codec Selection
  const hasAudio = mixedStream.getAudioTracks().length > 0;
  let mime = 'video/webm';
  if (hasAudio) {
    // Priority: VP9 (sharp slides/text) -> MP4 (H.264) -> VP8
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
      mime = 'video/webm;codecs=vp9,opus';
    } else if (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')) {
      mime = 'video/mp4;codecs=avc1,mp4a.40.2';
    } else if (MediaRecorder.isTypeSupported('video/mp4')) {
      mime = 'video/mp4';
    } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) {
      mime = 'video/webm;codecs=vp8,opus';
    }
  } else {
    // Video-only stream fallback: omit audio codecs to prevent MediaRecorder initialization failure
    log('Stream has no audio tracks; selecting video-only container codec');
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
      mime = 'video/webm;codecs=vp9';
    } else if (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')) {
      mime = 'video/mp4;codecs=avc1';
    } else if (MediaRecorder.isTypeSupported('video/webm')) {
      mime = 'video/webm';
    }
  }

  // Initialize unique session in MeetRecorderDB
  activeSessionId = crypto.randomUUID();
  sessionStartTime = Date.now();
  chunkSequence = 0;

  await recorderDB.createSession(activeSessionId, meetingId, mime);
  log(`Created recording session in IndexedDB: ${activeSessionId} (${mime}, hasAudio=${hasAudio})`);

  const bitRates: Record<string, number> = {
    '720p': 2_500_000,
    '1080p': 8_000_000,
    'max': 14_000_000,
  };
  const videoBitsPerSecond = bitRates[settings.videoQuality] || 8_000_000;

  const recorderOptions: MediaRecorderOptions = {
    mimeType: mime,
    videoBitsPerSecond,
  };
  if (hasAudio) {
    recorderOptions.audioBitsPerSecond = 192_000;
  }

  mediaRecorder = new MediaRecorder(mixedStream, recorderOptions);

  // Track pending IndexedDB chunk write promises to guarantee 100% data integrity on stop
  const pendingChunkWrites = new Set<Promise<void>>();

  const started = new Promise<void>((resolve, reject) => {
    const startTimeout = setTimeout(() => reject(new Error('MediaRecorder did not start (timeout)')), 5000);

    mediaRecorder!.onstart = () => {
      clearTimeout(startTimeout);
      capturing = true;
      isPaused = false;
      pushState(true, { sessionId: activeSessionId, startedAt: sessionStartTime, paused: false });
      log('MediaRecorder started with 5s timeslice chunking');
      resolve();
    };

    mediaRecorder!.onerror = (e: any) => {
      clearTimeout(startTimeout);
      log('MediaRecorder error', e);
      cleanupStreams();
      capturing = false;
      pushState(false);
      reject(new Error(e?.name || 'MediaRecorder error'));
    };

    // FR-MEM-1 & FR-MEM-2: Direct write to IndexedDB every 5 seconds.
    // Chunks are NOT retained in heap memory!
    mediaRecorder!.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0 && activeSessionId) {
        const seq = chunkSequence++;
        const currentId = activeSessionId;
        const writePromise = recorderDB.writeChunk(currentId, seq, e.data);
        pendingChunkWrites.add(writePromise);
        writePromise
          .catch((err) => {
            log(`Failed to write chunk seq=${seq} to IndexedDB:`, err);
          })
          .finally(() => {
            pendingChunkWrites.delete(writePromise);
          });
      }
    };

    mediaRecorder!.onstop = async () => {
      log('MediaRecorder stopped. Finalizing session...');
      const finishedSessionId = activeSessionId;
      const durationMs = Math.max(1000, Date.now() - sessionStartTime);

      try {
        if (!finishedSessionId) throw new Error('No active session ID on stop');

        // CRITICAL: Await all in-flight chunk writes so final seconds are never truncated
        if (pendingChunkWrites.size > 0) {
          log(`Flushing ${pendingChunkWrites.size} in-flight chunk write(s) before assembly...`);
          await Promise.all(Array.from(pendingChunkWrites));
          log('All chunk writes committed to IndexedDB');
        }

        await recorderDB.updateSessionStatus(finishedSessionId, 'FINALIZING', Date.now());

        // 1. Memory-safe chunk assembly from IndexedDB
        log('Assembling video blob via IndexedDB cursor...');
        const rawBlob = await recorderDB.assembleSessionBlob(finishedSessionId, mime);
        
        // 2. Format-aware duration / seekability handling
        let finalVideoBlob = rawBlob;
        const isWebm = mime.includes('webm');
        if (isWebm) {
          log(`Patching EBML duration for WebM (${durationMs}ms)...`);
          finalVideoBlob = await fixWebmDuration(rawBlob, durationMs);
          log(`EBML patched: seekable blob size=${finalVideoBlob.size} bytes`);
        } else {
          log(`MP4 container assembled: size=${finalVideoBlob.size} bytes`);
        }

        // 3. Subtitle and Plain Text Transcript compilation
        const vttContent = await recorderDB.generateWebVTT(finishedSessionId);
        const vttBlob = new Blob([vttContent], { type: 'text/vtt' });

        const txtContent = await recorderDB.generatePlainText(finishedSessionId);
        const txtBlob = new Blob([txtContent], { type: 'text/plain' });

        // Filenames
        let suffix = meetingId || 'google-meet';
        try {
          const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
          if (tabs[0]?.url) suffix = inferSuffixFromActiveTabUrl(tabs[0].url);
        } catch {}

        const timestamp = Date.now();
        const ext = mime.includes('mp4') ? 'mp4' : 'webm';
        const videoFilename = `GoogleMeet-Recording-${suffix}-${timestamp}.${ext}`;
        const txtFilename = `GoogleMeet-Transcript-${suffix}-${timestamp}.txt`;
        const vttFilename = `GoogleMeet-Transcript-${suffix}-${timestamp}.vtt`;

        const videoBlobUrl = URL.createObjectURL(finalVideoBlob);
        const txtBlobUrl = URL.createObjectURL(txtBlob);
        const vttBlobUrl = URL.createObjectURL(vttBlob);

        // Data URLs as bulletproof fallback that survives context isolation
        const txtDataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(txtContent)}`;
        const vttDataUrl = `data:text/vtt;charset=utf-8,${encodeURIComponent(vttContent)}`;

        await recorderDB.updateSessionStatus(finishedSessionId, 'COMPLETED', Date.now());

        // Transmit save instructions to background
        getPort().postMessage({
          type: 'OFFSCREEN_SAVE',
          sessionId: finishedSessionId,
          videoBlobUrl,
          videoFilename,
          txtBlobUrl,
          txtDataUrl,
          txtFilename,
          txtContent,
          vttBlobUrl,
          vttDataUrl,
          vttFilename,
          vttContent,
        });

        log('OFFSCREEN_SAVE dispatched for video, text transcript, and subtitles');
      } catch (err) {
        log('Finalization error:', err);
      } finally {
        pendingChunkWrites.clear();
        cleanupStreams();
        capturing = false;
        isPaused = false;
        activeSessionId = null;
        pushState(false);
      }
    };
  });

  // Start with 5-second interval
  mediaRecorder.start(5000);

  // Auto-stop if video track ends (tab navigated / closed)
  videoTracks[0]?.addEventListener('ended', () => {
    log('Captured tab video track ended');
    if (mediaRecorder && capturing) {
      try {
        if (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused') {
          try { mediaRecorder.requestData(); } catch {}
          mediaRecorder.stop();
        }
      } catch {}
    }
  });

  await started;
}

function cleanupStreams() {
  try {
    currentMixedStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  try {
    currentMicTrack?.stop();
  } catch {}
  try {
    audioContext?.close().catch?.(() => {});
  } catch {}

  currentMixedStream = null;
  currentMicTrack = null;
  micGainNode = null;
  audioContext = null;
  mediaRecorder = null;
  isMeetMuted = true;
}

function stopRecording() {
  if (!mediaRecorder) {
    log('Stop called but no mediaRecorder instance exists');
    return;
  }
  try {
    if (mediaRecorder.state === 'recording' || mediaRecorder.state === 'paused') {
      try { mediaRecorder.requestData(); } catch {}
      mediaRecorder.stop();
      log('mediaRecorder.stop() successfully executed');
    } else {
      log(`stopRecording called but mediaRecorder state is already ${mediaRecorder.state}`);
    }
  } catch (e) {
    log('Error stopping mediaRecorder', e);
    throw e;
  }
}

// Port RPC listener — attached to every new port (including reconnections)
function attachRpcListener(port: chrome.runtime.Port): void {
  port.onMessage.addListener(async (msg: any) => {
    try {
      if (msg?.type === 'OFFSCREEN_START') {
        const streamId = msg.streamId as string | undefined;
        const source = msg.source as 'tab' | 'desktop' | undefined;
        const meetingId = (msg.meetingId as string | undefined) || 'google-meet';
        if (!streamId || !source) return respond(msg, { ok: false, error: 'Missing streamId or source' });

        try {
          if (capturing) {
            return respond(msg, { ok: false, error: 'Already recording' });
          }
          const baseStream = await captureWithStreamId(streamId, source);
          await prepareAndRecord(baseStream, meetingId, source);
          return respond(msg, { ok: true, sessionId: activeSessionId });
        } catch (e: any) {
          return respond(msg, { ok: false, error: `${e?.name || 'Error'}: ${e?.message || e}` });
        }
      }

      if (msg?.type === 'OFFSCREEN_STOP') {
        try {
          stopRecording();
          return respond(msg, { ok: true });
        } catch (e: any) {
          return respond(msg, { ok: false, error: String(e?.message || e) });
        }
      }

      if (msg?.type === 'OFFSCREEN_PAUSE') {
        try {
          if (!mediaRecorder || mediaRecorder.state !== 'recording') throw new Error('Not recording');
          mediaRecorder.pause();
          isPaused = true;
          pushState(true, { sessionId: activeSessionId, startedAt: sessionStartTime, paused: true });
          log('mediaRecorder.pause() executed');
          return respond(msg, { ok: true });
        } catch (e: any) {
          return respond(msg, { ok: false, error: String(e?.message || e) });
        }
      }

      if (msg?.type === 'OFFSCREEN_RESUME') {
        try {
          if (!mediaRecorder || mediaRecorder.state !== 'paused') throw new Error('Not paused');
          mediaRecorder.resume();
          isPaused = false;
          pushState(true, { sessionId: activeSessionId, startedAt: sessionStartTime, paused: false });
          log('mediaRecorder.resume() executed');
          return respond(msg, { ok: true });
        } catch (e: any) {
          return respond(msg, { ok: false, error: String(e?.message || e) });
        }
      }

      if (msg?.type === 'OFFSCREEN_STATUS') {
        return respond(msg, {
          recording: capturing,
          paused: isPaused,
          sessionId: activeSessionId,
          startedAt: sessionStartTime,
        });
      }

      // FR-AV-3: Google Meet Mute Sync
      if (msg?.type === 'MEET_MUTE_TOGGLED') {
        const isMuted = !!msg.isMuted;
        isMeetMuted = isMuted;
        log(`Meet mute event received: ${isMuted ? 'MUTED' : 'UNMUTED'}`);
        updateMicState();
        return;
      }

      if (msg?.type === 'MIC_SETTING_TOGGLED') {
        isMicEnabledBySetting = !!msg.enabled;
        log(`Mic setting event received: enabled=${isMicEnabledBySetting}`);
        updateMicState();
        return;
      }

      // FR-CAP-2: Scraped Caption Ingestion
      if (msg?.type === 'CAPTION_RECORD' && activeSessionId) {
        const relativeTimeMs = Math.max(0, Date.now() - sessionStartTime);
        recorderDB.writeCaption(activeSessionId, relativeTimeMs, msg.speaker || 'Speaker', msg.text || '').catch(() => {});
        return;
      }

      // Storage Garbage Collection on confirmed download
      if (msg?.type === 'REVOKE_BLOB_URL') {
        if (typeof msg.videoBlobUrl === 'string') {
          try {
            URL.revokeObjectURL(msg.videoBlobUrl);
          } catch {}
        }
        if (typeof msg.txtBlobUrl === 'string') {
          try {
            URL.revokeObjectURL(msg.txtBlobUrl);
          } catch {}
        }
        if (typeof msg.vttBlobUrl === 'string') {
          try {
            URL.revokeObjectURL(msg.vttBlobUrl);
          } catch {}
        }
        if (typeof msg.sessionId === 'string') {
          log(`Storage cleanup for session ${msg.sessionId}`);
          recorderDB.deleteSession(msg.sessionId).catch((err) => log('Cleanup error:', err));
        }
        return;
      }

      if (msg?.type === 'HEARTBEAT') {
        if (audioContext && audioContext.state === 'suspended') {
          audioContext.resume().catch(() => {});
        }
        return;
      }
    } catch (e) {
      console.error('[offscreen] Port message handler error', e);
      respond(msg, { ok: false, error: String(e) });
    }
  });
}

// Establish initial port (attachRpcListener is called inside connectPort)
getPort();

// Broadcast listener
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    if (msg?.type === 'OFFSCREEN_PING') {
      sendResponse({ ok: true, via: 'onMessage' });
      return false;
    }
    if (msg?.type === 'OFFSCREEN_CONNECT') {
      connectPort();
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'MEET_MUTE_TOGGLED') {
      const isMuted = !!msg.isMuted;
      isMeetMuted = isMuted;
      updateMicState();
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'MIC_SETTING_TOGGLED') {
      isMicEnabledBySetting = !!msg.enabled;
      updateMicState();
      sendResponse({ ok: true });
      return false;
    }
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
    return false;
  }
  return false;
});

