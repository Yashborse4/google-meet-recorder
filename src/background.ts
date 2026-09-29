// src/background.ts
// Manifest V3 Service Worker:
// - Keep-Alive connection port with offscreen document
// - Tab capture streamId coordination
// - Dual file downloads (WebM video + WebVTT subtitles)
// - Google Meet state forwarding (Mute Sync, Captions, Disconnect)
// - Auto-finalization when recorded tab closes

let offscreenPort: chrome.runtime.Port | null = null;
let offscreenReady = false;
let lastKnownRecording = false;
let activeRecordingTabId: number | null = null;
let activeRecordingSessionId: string | null = null;
let activeRecordingStartTime = 0;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function bglog(...a: any[]) {
  console.log('[background]', ...a);
}

function setBadge(recording: boolean) {
  try {
    chrome.action.setBadgeText({ text: recording ? 'REC' : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#EA4335' });
  } catch {}
}

let heartbeatTimer: any = null;

function broadcastState(recording: boolean, extra?: Record<string, any>) {
  lastKnownRecording = recording;
  setBadge(recording);

  // Power & Sleep prevention: Keep display & system awake, prevent tab discarding
  try {
    if (recording) {
      chrome.power?.requestKeepAwake('display');
      if (activeRecordingTabId) {
        chrome.tabs.update(activeRecordingTabId, { autoDiscardable: false }).catch(() => {});
      }
      if (!heartbeatTimer) {
        heartbeatTimer = setInterval(() => {
          if (lastKnownRecording && offscreenPort) {
            try { offscreenPort.postMessage({ type: 'HEARTBEAT' }); } catch {}
          }
        }, 15000);
      }
    } else {
      chrome.power?.releaseKeepAwake();
      if (activeRecordingTabId) {
        chrome.tabs.update(activeRecordingTabId, { autoDiscardable: true }).catch(() => {});
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  } catch (e) {
    bglog('Power / sleep-prevention error:', e);
  }

  const payload = {
    type: 'RECORDING_STATE',
    recording,
    tabId: activeRecordingTabId,
    sessionId: activeRecordingSessionId,
    startedAt: activeRecordingStartTime,
    ...extra,
  };

  // Broadcast to popup / extension contexts
  chrome.runtime.sendMessage(payload).catch(() => {});

  // Broadcast to all Google Meet tabs for native UI feedback
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    tabs.forEach((t) => {
      if (t.id) chrome.tabs.sendMessage(t.id, payload).catch(() => {});
    });
  });
}

async function hasOffscreenContext(): Promise<boolean> {
  try {
    const getContexts = (chrome.runtime as any).getContexts as
      | ((q: { contextTypes: ('OFFSCREEN_DOCUMENT' | string)[] }) => Promise<any[]>)
      | undefined;
    if (getContexts) {
      const ctx = await getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
      return Array.isArray(ctx) && ctx.length > 0;
    }
  } catch {}
  try {
    return !!(await (chrome.offscreen as any).hasDocument?.());
  } catch {
    return false;
  }
}

async function ensureOffscreen(): Promise<void> {
  const have = await hasOffscreenContext();
  if (!have) {
    bglog('Creating offscreen document…');
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'],
      justification: 'Record tab audio+video in offscreen using MediaRecorder and Web Audio API',
    });
  }

  for (let i = 0; i < 15 && !(offscreenPort && offscreenReady); i++) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' });
      if (res?.ok) {
        bglog('Offscreen responded to PING');
        break;
      }
    } catch {}
    await wait(100);
  }

  if (!(offscreenPort && offscreenReady)) {
    try {
      await chrome.runtime.sendMessage({ type: 'OFFSCREEN_CONNECT' });
    } catch {}
  }

  for (let i = 0; i < 50; i++) {
    if (offscreenPort && offscreenReady) return;
    await wait(100);
  }
  throw new Error('Offscreen document did not become ready in time');
}

// Service Worker Port Keep-Alive
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'offscreen') return;
  bglog('Offscreen connected via port');
  offscreenPort = port;
  offscreenReady = false;

  port.onMessage.addListener((msg: any) => {
    if (msg?.type === 'OFFSCREEN_READY') {
      offscreenReady = true;
      bglog('Offscreen is READY (Port)');
    }

    if (msg?.type === 'RECORDING_STATE') {
      lastKnownRecording = !!msg.recording;
      if (msg.sessionId) activeRecordingSessionId = msg.sessionId;
      if (msg.startedAt) activeRecordingStartTime = msg.startedAt;
      if (!lastKnownRecording) {
        activeRecordingTabId = null;
        activeRecordingSessionId = null;
        activeRecordingStartTime = 0;
      }
      broadcastState(lastKnownRecording, msg);
    }

    // Dual file downloads (Video WebM + WebVTT subtitles)
    if (msg?.type === 'OFFSCREEN_SAVE') {
      const sanitize = (name: string) => name.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '_');
      const videoFilename = sanitize(msg.videoFilename || `GoogleMeet-Recording-${Date.now()}.webm`);
      const vttFilename = sanitize(msg.vttFilename || `GoogleMeet-Transcript-${Date.now()}.vtt`);

      bglog('OFFSCREEN_SAVE received:', videoFilename);

      if (msg.videoBlobUrl) {
        chrome.downloads.download(
          {
            url: msg.videoBlobUrl,
            filename: videoFilename,
            saveAs: true,
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              bglog('Video download error:', chrome.runtime.lastError.message);
            } else {
              bglog(`Video download initiated, id=${downloadId}`);
              chrome.runtime.sendMessage({ type: 'RECORDING_SAVED', filename: videoFilename }).catch(() => {});
            }
          }
        );
      }

      if (msg.vttBlobUrl) {
        chrome.downloads.download(
          {
            url: msg.vttBlobUrl,
            filename: vttFilename,
            saveAs: false,
          },
          (vttDownloadId) => {
            if (chrome.runtime.lastError) {
              bglog('VTT download error:', chrome.runtime.lastError.message);
            } else {
              bglog(`VTT download initiated, id=${vttDownloadId}`);
            }
          }
        );
      }

      // Allow download to initiate before signaling URL revocation and DB cleanup
      setTimeout(() => {
        try {
          offscreenPort?.postMessage({
            type: 'REVOKE_BLOB_URL',
            sessionId: msg.sessionId,
            videoBlobUrl: msg.videoBlobUrl,
            vttBlobUrl: msg.vttBlobUrl,
          });
        } catch {}
      }, 15000);
    }
  });

  port.onDisconnect.addListener(() => {
    bglog('Offscreen disconnected');
    offscreenPort = null;
    offscreenReady = false;
    broadcastState(false);
  });
});

function postToOffscreen(msg: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!offscreenPort) return reject(new Error('Offscreen port not connected'));
    const id = Math.random().toString(36).slice(2);
    msg.__id = id;

    const listener = (m: any) => {
      if (m && m.__respFor === id) {
        offscreenPort!.onMessage.removeListener(listener);
        resolve(m.payload);
      }
    };

    offscreenPort.onMessage.addListener(listener);
    offscreenPort.postMessage(msg);

    setTimeout(() => {
      try {
        offscreenPort!.onMessage.removeListener(listener);
      } catch {}
      reject(new Error('Offscreen response timeout'));
    }, 15000);
  });
}

async function getStreamIdForTab(tabId: number): Promise<{ streamId: string, source: 'tab' | 'desktop' }> {
  // 1. Try direct tabCapture.getMediaStreamId (succeeds when initiated via extension gesture like popup or command)
  try {
    const directId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id?: string) => {
        const err = chrome.runtime.lastError;
        if (err || !id) {
          return reject(err ? new Error(err.message) : new Error('Empty streamId'));
        }
        resolve(id);
      });
    });
    return { streamId: directId, source: 'tab' };
  } catch (err: any) {
    bglog('tabCapture.getMediaStreamId not invoked via extension gesture; falling back to desktopCapture:', err?.message || err);
  }

  // 2. Fallback: desktopCapture.chooseDesktopMedia(['tab', 'audio'])
  // Works when initiated from in-page buttons without activeTab restrictions!
  const tab = await chrome.tabs.get(tabId);
  return new Promise<{ streamId: string, source: 'tab' | 'desktop' }>((resolve, reject) => {
    try {
      chrome.desktopCapture.chooseDesktopMedia(['tab', 'audio'], tab, (streamId?: string) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!streamId) return reject(new Error('Tab sharing was cancelled'));
        resolve({ streamId, source: 'desktop' });
      });
    } catch (e) {
      reject(e as any);
    }
  });
}

// Keyboard shortcut (Alt+R) invokes activeTab directly
chrome.commands?.onCommand.addListener(async (command) => {
  if (command === 'toggle-recording') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.includes('meet.google.com')) return;
    if (lastKnownRecording) {
      if (offscreenPort) await postToOffscreen({ type: 'OFFSCREEN_STOP' });
    } else {
      try {
        await ensureOffscreen();
        const captureInfo = await getStreamIdForTab(tab.id);
        const r = await postToOffscreen({ type: 'OFFSCREEN_START', streamId: captureInfo.streamId, source: captureInfo.source, meetingId: 'google-meet' });
        if (r?.ok) {
          activeRecordingTabId = tab.id;
          broadcastState(true);
        }
      } catch (err) {
        bglog('Shortcut start recording error:', err);
      }
    }
  }
});

// Runtime message router
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // 1. Start Recording (from popup or injected Meet button)
    if (msg?.type === 'START_RECORDING') {
      const targetTabId = typeof msg.tabId === 'number' ? msg.tabId : sender.tab?.id;
      if (typeof targetTabId !== 'number') {
        sendResponse({ ok: false, error: 'Target tabId not provided' });
        return;
      }

      bglog('START_RECORDING requested for tabId', targetTabId);
      try {
        await ensureOffscreen();
      } catch (e: any) {
        sendResponse({ ok: false, error: `Offscreen document setup failed: ${e?.message || e}` });
        return;
      }

      try {
        const captureInfo = await getStreamIdForTab(targetTabId);
        let meetingId = 'google-meet';
        try {
          const tab = await chrome.tabs.get(targetTabId);
          if (tab.url) {
            const pathParts = new URL(tab.url).pathname.split('/');
            meetingId = pathParts[pathParts.length - 1] || 'google-meet';
          }
        } catch {}

        const r = await postToOffscreen({ type: 'OFFSCREEN_START', streamId: captureInfo.streamId, source: captureInfo.source, meetingId });
        if (r?.ok) {
          activeRecordingTabId = targetTabId;
          activeRecordingSessionId = r.sessionId;
          activeRecordingStartTime = Date.now();
          broadcastState(true);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: r?.error || 'Failed to start in offscreen' });
        }
      } catch (e: any) {
        bglog('START_RECORDING failed:', e);
        sendResponse({ ok: false, error: `START_RECORDING failed: ${e?.message || e}` });
      }
      return;
    }

    // 2. Stop Recording (from popup, injected Meet button, or auto-disconnect)
    if (msg?.type === 'STOP_RECORDING' || msg?.type === 'FINALIZE_RECORDING') {
      bglog('STOP_RECORDING requested');
      try {
        if (offscreenPort && lastKnownRecording) {
          const r = await postToOffscreen({ type: 'OFFSCREEN_STOP' });
          bglog('OFFSCREEN_STOP response', r);
        }
        sendResponse({ ok: true });
      } catch (e: any) {
        sendResponse({ ok: false, error: `Stop failed: ${e?.message || e}` });
      }
      return;
    }

    // 3. Query status
    if (msg?.type === 'GET_RECORDING_STATUS') {
      sendResponse({
        recording: lastKnownRecording,
        tabId: activeRecordingTabId,
        sessionId: activeRecordingSessionId,
        startedAt: activeRecordingStartTime,
      });
      return;
    }

    // 4. Relay Google Meet mute toggle to offscreen GainNode
    if (msg?.type === 'MEET_MUTE_TOGGLED') {
      if (offscreenPort) {
        offscreenPort.postMessage(msg);
      }
      sendResponse({ ok: true });
      return;
    }

    // 5. Relay Caption record to offscreen for IndexedDB persistence
    if (msg?.type === 'CAPTION_RECORD') {
      if (offscreenPort) {
        offscreenPort.postMessage(msg);
      }
      sendResponse({ ok: true });
      return;
    }
  })().catch((err) => {
    console.error('[background] Error handling runtime message', err);
    sendResponse({ ok: false, error: String(err) });
  });

  return true;
});

// Auto-finalize recording if user closes the active recorded Meet tab
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === activeRecordingTabId && lastKnownRecording) {
    bglog(`Recorded tab ${tabId} was closed. Auto-stopping recording...`);
    try {
      if (offscreenPort) {
        await postToOffscreen({ type: 'OFFSCREEN_STOP' });
      }
    } catch (e) {
      bglog('Failed to auto-stop on tab close:', e);
    }
  }
});

// Extension suspension cleanup
chrome.runtime.onSuspend?.addListener(async () => {
  try {
    if (offscreenPort) await postToOffscreen({ type: 'OFFSCREEN_STOP' });
  } catch {}
  setBadge(false);
});
