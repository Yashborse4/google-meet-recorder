// src/background.ts
// Manifest V3 Service Worker:
// - Keep-Alive connection port with offscreen document
// - Tab capture streamId coordination
// - Dual file downloads (WebM video + WebVTT subtitles)
// - Google Meet state forwarding (Mute Sync, Captions, Disconnect)
// - Auto-finalization when recorded tab closes

import { getSettings } from './settings';

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
      reasons: ['BLOBS', 'AUDIO_PLAYBACK', 'USER_MEDIA'] as any[],
      justification: 'Record tab audio+video in offscreen using MediaRecorder and Web Audio API',
    });
  }

  for (let i = 0; i < 30 && !(offscreenPort && offscreenReady); i++) {
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

  for (let i = 0; i < 100; i++) {
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

    // Multi-file downloads (Video WebM/MP4 + Plain Text .txt transcript + WebVTT subtitles)
    if (msg?.type === 'OFFSCREEN_SAVE') {
      const sanitize = (name: string) => name.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '_');
      const videoFilename = sanitize(msg.videoFilename || `GoogleMeet-Recording-${Date.now()}.webm`);
      const txtFilename = sanitize(msg.txtFilename || `GoogleMeet-Transcript-${Date.now()}.txt`);
      const vttFilename = sanitize(msg.vttFilename || `GoogleMeet-Transcript-${Date.now()}.vtt`);

      bglog('OFFSCREEN_SAVE received: video =', videoFilename, ', transcript =', txtFilename);

      void (async () => {
        const settings = await getSettings();

        const downloadTranscripts = () => {
          // 1. Download readable plain-text transcript (.txt)
          // Prefer blob URL: data URLs can exceed Chromium's ~2MB limit on long meetings
          const txtUrl = msg.txtBlobUrl || msg.txtDataUrl;
          if (txtUrl && settings.saveTxtTranscript) {
            chrome.downloads.download(
              {
                url: txtUrl,
                filename: txtFilename,
                saveAs: false,
              },
              (txtId) => {
                if (chrome.runtime.lastError) {
                  bglog('TXT transcript download error:', chrome.runtime.lastError.message);
                  // Retry with data URL fallback if blob URL failed
                  if (msg.txtDataUrl && txtUrl !== msg.txtDataUrl) {
                    bglog('Retrying TXT download with data URL fallback...');
                    chrome.downloads.download(
                      { url: msg.txtDataUrl, filename: txtFilename, saveAs: false },
                      (retryId) => {
                        if (chrome.runtime.lastError) {
                          bglog('TXT data URL fallback also failed:', chrome.runtime.lastError.message);
                        } else {
                          bglog(`TXT transcript download (fallback) initiated, id=${retryId}`);
                          chrome.runtime.sendMessage({ type: 'TRANSCRIPT_SAVED', filename: txtFilename }).catch(() => {});
                        }
                      }
                    );
                  }
                } else {
                  bglog(`TXT transcript download initiated, id=${txtId}`);
                  chrome.runtime.sendMessage({ type: 'TRANSCRIPT_SAVED', filename: txtFilename }).catch(() => {});
                }
              }
            );
          }

          // 2. Download WebVTT subtitle track (.vtt)
          // Prefer blob URL: data URLs can exceed Chromium's ~2MB limit on long meetings
          const vttUrl = msg.vttBlobUrl || msg.vttDataUrl;
          if (vttUrl && settings.saveVttSubtitles) {
            chrome.downloads.download(
              {
                url: vttUrl,
                filename: vttFilename,
                saveAs: false,
              },
              (vttId) => {
                if (chrome.runtime.lastError) {
                  bglog('VTT subtitle download error:', chrome.runtime.lastError.message);
                  // Retry with data URL fallback if blob URL failed
                  if (msg.vttDataUrl && vttUrl !== msg.vttDataUrl) {
                    bglog('Retrying VTT download with data URL fallback...');
                    chrome.downloads.download(
                      { url: msg.vttDataUrl, filename: vttFilename, saveAs: false },
                      (retryId) => {
                        if (chrome.runtime.lastError) {
                          bglog('VTT data URL fallback also failed:', chrome.runtime.lastError.message);
                        } else {
                          bglog(`VTT subtitle download (fallback) initiated, id=${retryId}`);
                        }
                      }
                    );
                  }
                } else {
                  bglog(`VTT subtitle download initiated, id=${vttId}`);
                }
              }
            );
          }
        };

        let activeDownloadId: number | null = null;
        const cleanupSession = () => {
          try {
            offscreenPort?.postMessage({
              type: 'REVOKE_BLOB_URL',
              sessionId: msg.sessionId,
              videoBlobUrl: msg.videoBlobUrl,
              txtBlobUrl: msg.txtBlobUrl,
              vttBlobUrl: msg.vttBlobUrl,
            });
          } catch {}
        };

        if (msg.videoBlobUrl && settings.saveVideo) {
          chrome.downloads.download(
            {
              url: msg.videoBlobUrl,
              filename: videoFilename,
              saveAs: true,
            },
            (downloadId) => {
              if (chrome.runtime.lastError) {
                bglog('Video download error or cancelled:', chrome.runtime.lastError.message);
              } else {
                activeDownloadId = downloadId ?? null;
                bglog(`Video download initiated, id=${downloadId}`);
                chrome.runtime.sendMessage({ type: 'RECORDING_SAVED', filename: videoFilename }).catch(() => {});
              }
              // Automatically download transcript when saving video
              downloadTranscripts();
            }
          );
        } else {
          downloadTranscripts();
        }

        // Track completion for safe memory cleanup
        if (chrome.downloads?.onChanged) {
          const downloadListener = (delta: chrome.downloads.DownloadDelta) => {
            if (activeDownloadId && delta.id === activeDownloadId) {
              if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
                setTimeout(cleanupSession, 10000);
                chrome.downloads.onChanged.removeListener(downloadListener);
              }
            }
          };
          chrome.downloads.onChanged.addListener(downloadListener);
        }

        // Fallback cleanup timer (5 minutes)
        setTimeout(cleanupSession, 300000);
      })();
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

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      try {
        offscreenPort?.onMessage.removeListener(listener);
      } catch {}
    };

    const listener = (m: any) => {
      if (m && m.__respFor === id) {
        cleanup();
        resolve(m.payload);
      }
    };

    offscreenPort.onMessage.addListener(listener);

    try {
      offscreenPort.postMessage(msg);
    } catch (e) {
      cleanup();
      reject(new Error(`Failed to post to offscreen: ${e}`));
      return;
    }

    // 30s timeout: getUserMedia + AudioContext + MediaRecorder.start() can take
    // a while on first use or slower machines (permission dialogs, cold start)
    setTimeout(() => {
      cleanup();
      reject(new Error('Offscreen response timeout'));
    }, 30000);
  });
}

async function getStreamIdForTab(tabId: number, preferDesktop: boolean = false): Promise<{ streamId: string, source: 'tab' | 'desktop' }> {
  // 1. Try direct tabCapture.getMediaStreamId (ONLY valid when initiated via extension gesture like popup or command)
  if (!preferDesktop) {
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
  }

  // 2. Fallback / in-page button initiator: desktopCapture.chooseDesktopMedia(['tab', 'audio'])
  // Works cleanly when initiated from in-page buttons without activeTab restrictions!
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
      if (tab?.id) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'FLUSH_CAPTIONS' });
          await wait(150);
        } catch {}
      }
      if (offscreenPort) await postToOffscreen({ type: 'OFFSCREEN_STOP' });
    } else {
      try {
        await ensureOffscreen();
        const captureInfo = await getStreamIdForTab(tab.id);
        let meetingId = 'google-meet';
        if (tab.url) {
          const pathParts = new URL(tab.url).pathname.split('/');
          meetingId = pathParts[pathParts.length - 1] || 'google-meet';
        }
        const r = await postToOffscreen({ type: 'OFFSCREEN_START', streamId: captureInfo.streamId, source: captureInfo.source, meetingId });
        if (r?.ok) {
          activeRecordingTabId = tab.id;
          activeRecordingStartTime = Date.now();
          activeRecordingSessionId = r.sessionId;
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
  // 1. Synchronous handlers
  if (msg?.type === 'GET_RECORDING_STATUS') {
    sendResponse({
      recording: lastKnownRecording,
      tabId: activeRecordingTabId,
      sessionId: activeRecordingSessionId,
      startedAt: activeRecordingStartTime,
    });
    return false;
  }

  if (msg?.type === 'MEET_MUTE_TOGGLED') {
    if (offscreenPort) {
      offscreenPort.postMessage(msg);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'CAPTION_RECORD') {
    if (offscreenPort) {
      offscreenPort.postMessage(msg);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'CHECK_MIC_PERMISSION') {
    chrome.storage.local.get('micPermissionGranted', (res) => {
      sendResponse({ granted: !!res?.micPermissionGranted });
    });
    return true;
  }

  if (msg?.type === 'REQUEST_MIC_PERMISSION') {
    const setupUrl = chrome.runtime.getURL('micsetup.html');
    try {
      chrome.windows.create({
        url: setupUrl,
        type: 'popup',
        width: 440,
        height: 380,
        focused: true,
      });
    } catch {
      chrome.tabs.create({ url: setupUrl });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg?.type === 'MIC_PERMISSION_GRANTED') {
    chrome.storage.local.set({ micPermissionGranted: true }).catch(() => {});
    chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
      tabs.forEach((t) => {
        if (t.id) chrome.tabs.sendMessage(t.id, { type: 'MIC_PERMISSION_GRANTED' }).catch(() => {});
      });
    });
    sendResponse({ ok: true });
    return false;
  }

  // 2. Asynchronous handlers (return true to keep message port open)
  if (msg?.type === 'START_RECORDING') {
    handleStartRecording(msg, sender, sendResponse);
    return true;
  }

  if (msg?.type === 'STOP_RECORDING' || msg?.type === 'FINALIZE_RECORDING') {
    handleStopRecording(msg, sendResponse);
    return true;
  }

  // 3. Fallthrough: not handled by background, return false immediately so port is not held open
  return false;
});

async function handleStartRecording(msg: any, sender: chrome.runtime.MessageSender, sendResponse: (res: any) => void) {
  try {
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
      let streamId = msg.streamId as string | undefined;
      let source = (msg.source as 'tab' | 'desktop') || 'tab';

      if (!streamId) {
        const isFromInPage = typeof sender.tab?.id === 'number';
        const captureInfo = await getStreamIdForTab(targetTabId, isFromInPage);
        streamId = captureInfo.streamId;
        source = captureInfo.source;
      }

      let meetingId = 'google-meet';
      try {
        const tab = await chrome.tabs.get(targetTabId);
        if (tab.url) {
          const pathParts = new URL(tab.url).pathname.split('/');
          meetingId = pathParts[pathParts.length - 1] || 'google-meet';
        }
      } catch {}

      const r = await postToOffscreen({ type: 'OFFSCREEN_START', streamId, source, meetingId });
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
  } catch (err: any) {
    console.error('[background] Error handling START_RECORDING', err);
    sendResponse({ ok: false, error: String(err) });
  }
}

async function handleStopRecording(msg: any, sendResponse: (res: any) => void) {
  try {
    bglog('STOP_RECORDING / FINALIZE requested:', msg.type);
    if (msg.type === 'FINALIZE_RECORDING') {
      const settings = await getSettings();
      if (!settings.autoStopOnExit) {
        bglog('FINALIZE_RECORDING ignored as autoStopOnExit is false in settings');
        sendResponse({ ok: true });
        return;
      }
    }

    if (activeRecordingTabId) {
      try {
        await chrome.tabs.sendMessage(activeRecordingTabId, { type: 'FLUSH_CAPTIONS' });
        await wait(150);
      } catch {}
    }
    if (offscreenPort && lastKnownRecording) {
      const r = await postToOffscreen({ type: 'OFFSCREEN_STOP' });
      bglog('OFFSCREEN_STOP response', r);
    }
    sendResponse({ ok: true });
  } catch (e: any) {
    console.error('[background] Error handling STOP_RECORDING', e);
    sendResponse({ ok: false, error: `Stop failed: ${e?.message || e}` });
  }
}

// Auto-finalize recording if user closes the active recorded Meet tab
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === activeRecordingTabId && lastKnownRecording) {
    const settings = await getSettings();
    if (!settings.autoStopOnExit) {
      bglog(`Recorded tab ${tabId} was closed, but autoStopOnExit is disabled in settings.`);
      return;
    }
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

// Auto-finalize recording and release microphone if recorded tab navigates away from Google Meet
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (tabId === activeRecordingTabId && lastKnownRecording && changeInfo.url) {
    if (!changeInfo.url.includes('meet.google.com')) {
      bglog(`Recorded tab ${tabId} navigated away from Google Meet (${changeInfo.url}). Auto-stopping recording and releasing mic...`);
      try {
        if (offscreenPort) {
          await postToOffscreen({ type: 'OFFSCREEN_STOP' });
        }
      } catch (e) {
        bglog('Failed to auto-stop on tab navigation:', e);
      }
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
