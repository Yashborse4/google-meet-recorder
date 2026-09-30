// src/popup.ts
// Extension Popup:
// - Orphan / Crash Recovery detection (MeetRecorderDB)
// - Microphone permission priming & verification
// - Manual Start / Stop tab recording controls
// - Real-time recording duration and session timer
// - In-extension settings & preferences configuration

import { recorderDB, SessionRecord } from './db';
import { fixWebmDuration } from './webmFix';
import { getSettings, saveSettings, ExtensionSettings } from './settings';

// Recording UI elements
const toggleMic = document.getElementById('toggle-mic-enable') as HTMLInputElement | null;
const micDesc = document.getElementById('mic-desc') as HTMLDivElement | null;
const startBtn = document.getElementById('start-rec') as HTMLButtonElement | null;
const pauseBtn = document.getElementById('pause-rec') as HTMLButtonElement | null;
const resumeBtn = document.getElementById('resume-rec') as HTMLButtonElement | null;
const stopBtn = document.getElementById('stop-rec') as HTMLButtonElement | null;

const statusPill = document.getElementById('status-pill') as HTMLDivElement | null;
const statusText = document.getElementById('status-text') as HTMLSpanElement | null;
const timerCard = document.getElementById('timer-card') as HTMLDivElement | null;
const timerDigits = document.getElementById('timer-digits') as HTMLDivElement | null;
const startTimeInfo = document.getElementById('start-time-info') as HTMLDivElement | null;

const recoveryCard = document.getElementById('recovery-card') as HTMLDivElement | null;
const recoveryMsg = document.getElementById('recovery-msg') as HTMLParagraphElement | null;
const recoverBtn = document.getElementById('recover-btn') as HTMLButtonElement | null;
const discardBtn = document.getElementById('discard-btn') as HTMLButtonElement | null;

// Settings & View Navigation elements
const viewMain = document.getElementById('view-main') as HTMLDivElement | null;
const viewSettings = document.getElementById('view-settings') as HTMLDivElement | null;
const btnSettingsToggle = document.getElementById('btn-settings-toggle') as HTMLButtonElement | null;
const btnSettingsBack = document.getElementById('btn-settings-back') as HTMLButtonElement | null;

const settingSaveVideo = document.getElementById('setting-save-video') as HTMLInputElement | null;
const settingSaveTxt = document.getElementById('setting-save-txt') as HTMLInputElement | null;
const settingSaveVtt = document.getElementById('setting-save-vtt') as HTMLInputElement | null;
const settingVideoQuality = document.getElementById('setting-video-quality') as HTMLSelectElement | null;
const settingAutoMic = document.getElementById('setting-auto-mic') as HTMLInputElement | null;
const settingNoiseSuppression = document.getElementById('setting-noise-suppression') as HTMLInputElement | null;
const settingAutoStop = document.getElementById('setting-auto-stop') as HTMLInputElement | null;
const btnClearCache = document.getElementById('btn-clear-cache') as HTMLButtonElement | null;

let liveTimerInterval: number | null = null;

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function setUI(recording: boolean, startedAt?: number, paused = false, realStart?: number) {
  if (!startBtn || !stopBtn) return;
  startBtn.disabled = recording;
  stopBtn.disabled = !recording;
  if (pauseBtn) pauseBtn.disabled = !recording || paused;
  if (resumeBtn) resumeBtn.disabled = !recording || !paused;

  if (recording) {
    startBtn.style.display = 'none';
    stopBtn.style.display = 'flex';
    if (pauseBtn) pauseBtn.style.display = paused ? 'none' : 'flex';
    if (resumeBtn) resumeBtn.style.display = paused ? 'flex' : 'none';

    if (statusPill) {
      statusPill.classList.add('recording');
      if (paused) statusPill.style.opacity = '0.7';
      else statusPill.style.opacity = '1';
    }
    if (statusText) statusText.textContent = paused ? 'PAUSED' : 'REC LIVE';
    if (timerCard) timerCard.classList.add('active');

    const effectiveStart = startedAt && startedAt > 0 ? startedAt : Date.now();
    const resolvedRealStart = realStart && realStart > 0 ? realStart : effectiveStart;
    if (startTimeInfo) {
      const timeStr = new Date(resolvedRealStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      startTimeInfo.innerHTML = `Started at: <strong>${timeStr}</strong>`;
    }

    const elapsed = Date.now() - effectiveStart;
    if (timerDigits) timerDigits.textContent = formatDuration(elapsed);

    if (!paused) {
      if (!liveTimerInterval) {
        liveTimerInterval = window.setInterval(() => {
          const curElapsed = Date.now() - effectiveStart;
          if (timerDigits) timerDigits.textContent = formatDuration(curElapsed);
        }, 1000);
      }
    } else if (liveTimerInterval) {
      clearInterval(liveTimerInterval);
      liveTimerInterval = null;
    }
  } else {
    startBtn.style.display = 'flex';
    stopBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (resumeBtn) resumeBtn.style.display = 'none';

    if (statusPill) {
      statusPill.classList.remove('recording');
      statusPill.style.opacity = '1';
    }
    if (statusText) statusText.textContent = 'Idle';
    if (timerCard) timerCard.classList.remove('active');
    if (timerDigits) timerDigits.textContent = '00:00';
    if (startTimeInfo) startTimeInfo.innerHTML = 'Started at: <strong>--:--</strong>';

    if (liveTimerInterval) {
      clearInterval(liveTimerInterval);
      liveTimerInterval = null;
    }
  }
}

function toast(msg: string) {
  console.log('[popup]', msg);
}

// Navigation between Main and Settings Views
function showSettings(show: boolean) {
  if (show) {
    viewMain?.classList.add('hidden');
    viewSettings?.classList.remove('hidden');
  } else {
    viewSettings?.classList.add('hidden');
    viewMain?.classList.remove('hidden');
  }
}

btnSettingsToggle?.addEventListener('click', () => {
  const isSettingsVisible = !viewSettings?.classList.contains('hidden');
  showSettings(!isSettingsVisible);
});

btnSettingsBack?.addEventListener('click', () => {
  showSettings(false);
});

function updateMicDescription(enabled: boolean) {
  if (!micDesc) return;
  if (!enabled) {
    micDesc.textContent = 'Microphone disabled (not recorded)';
    micDesc.style.color = 'var(--text-muted)';
  } else {
    micDesc.textContent = 'Only records when mic is open in Meet';
    micDesc.style.color = '#81c995';
  }
}

// Settings synchronization
async function initSettings() {
  const current = await getSettings();

  if (toggleMic) toggleMic.checked = current.autoMixMic;
  updateMicDescription(current.autoMixMic);

  if (settingSaveVideo) settingSaveVideo.checked = current.saveVideo;
  if (settingSaveTxt) settingSaveTxt.checked = current.saveTxtTranscript;
  if (settingSaveVtt) settingSaveVtt.checked = current.saveVttSubtitles;
  if (settingVideoQuality) settingVideoQuality.value = current.videoQuality;
  if (settingAutoMic) settingAutoMic.checked = current.autoMixMic;
  if (settingNoiseSuppression) settingNoiseSuppression.checked = current.noiseSuppression;
  if (settingAutoStop) settingAutoStop.checked = current.autoStopOnExit;

  const saveCurrent = async () => {
    const updated: ExtensionSettings = {
      saveVideo: settingSaveVideo ? settingSaveVideo.checked : true,
      saveTxtTranscript: settingSaveTxt ? settingSaveTxt.checked : true,
      saveVttSubtitles: settingSaveVtt ? settingSaveVtt.checked : true,
      videoQuality: (settingVideoQuality?.value as any) || '1080p',
      autoMixMic: settingAutoMic ? settingAutoMic.checked : true,
      noiseSuppression: settingNoiseSuppression ? settingNoiseSuppression.checked : true,
      autoStopOnExit: settingAutoStop ? settingAutoStop.checked : true,
    };
    await saveSettings(updated);
    if (toggleMic && settingAutoMic) {
      toggleMic.checked = settingAutoMic.checked;
      updateMicDescription(settingAutoMic.checked);
      chrome.runtime.sendMessage({ type: 'MIC_SETTING_TOGGLED', enabled: settingAutoMic.checked }).catch(() => {});
    }
    toast('Settings saved');
  };

  [settingSaveVideo, settingSaveTxt, settingSaveVtt, settingAutoMic, settingNoiseSuppression, settingAutoStop].forEach(
    (el) => el?.addEventListener('change', saveCurrent)
  );
  settingVideoQuality?.addEventListener('change', saveCurrent);

  btnClearCache?.addEventListener('click', async () => {
    if (confirm('Clear all cached session recordings from local storage?')) {
      try {
        const orphaned = await recorderDB.getOrphanedSessions();
        for (const s of orphaned) {
          await recorderDB.deleteSession(s.sessionId);
        }
        if (recoveryCard) recoveryCard.style.display = 'none';
        pendingRecoverySession = null;
        if (btnClearCache) btnClearCache.textContent = '✓ Cache Cleared';
        setTimeout(() => {
          if (btnClearCache) btnClearCache.textContent = '🗑️ Clear Cached Sessions';
        }, 2000);
      } catch (e) {
        alert(`Error clearing cache: ${e}`);
      }
    }
  });
}

// Open full tab to grant mic permissions
async function openMicSetupTab() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('micsetup.html') });
}

// Synchronize microphone permission and toggle state
async function syncMicState() {
  const current = await getSettings();
  if (toggleMic) toggleMic.checked = current.autoMixMic;
  updateMicDescription(current.autoMixMic);
}

// FR-EDGE-2: Orphaned Session & Crash Recovery Check
let pendingRecoverySession: SessionRecord | null = null;

async function checkOrphanedRecordings() {
  try {
    const orphaned = await recorderDB.getOrphanedSessions();
    if (orphaned.length > 0) {
      pendingRecoverySession = orphaned[0];
      const dateStr = new Date(pendingRecoverySession.startedAt).toLocaleTimeString();
      const approxDurationSec = (pendingRecoverySession.chunkCount || 1) * 5;

      if (recoveryCard && recoveryMsg) {
        recoveryMsg.textContent = `Incomplete recording detected from ${dateStr} (~${approxDurationSec}s, ${pendingRecoverySession.chunkCount} chunks).`;
        recoveryCard.style.display = 'block';
      }
    }
  } catch (err) {
    console.error('[popup] Error checking orphaned recordings:', err);
  }
}

recoverBtn?.addEventListener('click', async () => {
  if (!pendingRecoverySession || !recoverBtn) return;
  recoverBtn.disabled = true;
  recoverBtn.textContent = 'Assembling…';

  try {
    const sess = pendingRecoverySession;
    const approxDurationMs = Math.max(1000, (sess.chunkCount || 1) * 5000);

    const mime = sess.mimeType || 'video/webm';
    const rawBlob = await recorderDB.assembleSessionBlob(sess.sessionId, mime);

    let seekableBlob = rawBlob;
    if (mime.includes('webm')) {
      seekableBlob = await fixWebmDuration(rawBlob, approxDurationMs);
    }

    // Subtitle transcript & Plain Text transcript
    const vttContent = await recorderDB.generateWebVTT(sess.sessionId);
    const vttBlob = new Blob([vttContent], { type: 'text/vtt' });

    const txtContent = await recorderDB.generatePlainText(sess.sessionId);
    const txtBlob = new Blob([txtContent], { type: 'text/plain' });

    const videoUrl = URL.createObjectURL(seekableBlob);
    const vttUrl = URL.createObjectURL(vttBlob);
    const txtUrl = URL.createObjectURL(txtBlob);

    const suffix = sess.meetingId || 'recovered';
    const timestamp = Date.now();
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';

    chrome.downloads.download({
      url: videoUrl,
      filename: `GoogleMeet-Recovered-${suffix}-${timestamp}.${ext}`,
      saveAs: true,
    }, () => {
      chrome.downloads.download({
        url: txtUrl,
        filename: `GoogleMeet-Recovered-Transcript-${suffix}-${timestamp}.txt`,
        saveAs: false,
      });

      chrome.downloads.download({
        url: vttUrl,
        filename: `GoogleMeet-Recovered-Transcript-${suffix}-${timestamp}.vtt`,
        saveAs: false,
      });
    });

    // Cleanup session from IndexedDB after downloads initiate
    setTimeout(async () => {
      await recorderDB.deleteSession(sess.sessionId);
    }, 10000);

    if (recoveryCard) recoveryCard.style.display = 'none';
    pendingRecoverySession = null;
    toast('Orphaned recording and transcript successfully recovered.');
  } catch (err) {
    console.error('[popup] Recovery failed:', err);
    alert(`Could not recover recording: ${err}`);
  } finally {
    recoverBtn.disabled = false;
    recoverBtn.textContent = 'Recover & Download';
  }
});

discardBtn?.addEventListener('click', async () => {
  if (!pendingRecoverySession) return;
  try {
    await recorderDB.deleteSession(pendingRecoverySession.sessionId);
    if (recoveryCard) recoveryCard.style.display = 'none';
    pendingRecoverySession = null;
    toast('Orphaned recording discarded.');
  } catch (err) {
    console.error('[popup] Discard failed:', err);
  }
});

// Init: sync recording state, check mic, settings, and check for crashes
void (async () => {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
    setUI(!!st?.recording, st?.startedAt, !!st?.paused, st?.realStartTime);
  } catch {
    setUI(false);
  }
  syncMicState().catch(() => {});
  checkOrphanedRecordings().catch(() => {});
  initSettings().catch(() => {});
})();

// Listen for background state broadcasts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'RECORDING_STATE') setUI(!!msg.recording, msg.startedAt, !!msg.paused, msg.realStartTime);
  if (msg?.type === 'RECORDING_SAVED') {
    toast(`Video saved: ${msg.filename || 'recording.webm'}`);
    setUI(false);
  }
  if (msg?.type === 'TRANSCRIPT_SAVED') {
    toast(`Transcript saved: ${msg.filename || 'transcript.txt'}`);
  }
  if (msg?.type === 'MIC_PERMISSION_GRANTED') {
    if (toggleMic) toggleMic.checked = true;
    if (settingAutoMic) settingAutoMic.checked = true;
    updateMicDescription(true);
    void (async () => {
      const cur = await getSettings();
      cur.autoMixMic = true;
      await saveSettings(cur);
      chrome.runtime.sendMessage({ type: 'MIC_SETTING_TOGGLED', enabled: true }).catch(() => {});
    })();
  }
});

// Microphone toggle switch handler (allows enabling and disabling mic anytime)
toggleMic?.addEventListener('change', async () => {
  const shouldEnable = !!toggleMic.checked;
  if (shouldEnable) {
    let hasPermission = false;
    try {
      if ('permissions' in navigator) {
        // @ts-ignore
        const p = await (navigator as any).permissions.query({ name: 'microphone' });
        hasPermission = p.state === 'granted';
      }
    } catch {}

    if (!hasPermission) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        hasPermission = true;
        await chrome.storage.local.set({ micPermissionGranted: true });
      } catch {
        // Fallback to dedicated mic setup popup if popup getUserMedia is denied
        await openMicSetupTab();
        toggleMic.checked = false;
        updateMicDescription(false);
        return;
      }
    }
  }

  const currentSettings = await getSettings();
  currentSettings.autoMixMic = shouldEnable;
  await saveSettings(currentSettings);

  if (settingAutoMic) settingAutoMic.checked = shouldEnable;
  updateMicDescription(shouldEnable);

  chrome.runtime.sendMessage({ type: 'MIC_SETTING_TOGGLED', enabled: shouldEnable }).catch(() => {});
  toast(shouldEnable ? 'Microphone enabled' : 'Microphone disabled');
});

let inFlight = false;

// Start recording button
startBtn?.addEventListener('click', async () => {
  if (!startBtn || !stopBtn || inFlight) return;
  inFlight = true;
  startBtn.disabled = true;

  try {
    // Pre-flight: check if a recording is already active before attempting tab capture
    try {
      const preCheck = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
      if (preCheck?.recording) {
        // Recording is active — just fix the UI to match reality
        setUI(true, preCheck.startedAt, !!preCheck.paused, preCheck.realStartTime);
        return;
      }
    } catch {}

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found.');

    if (tab.url && !tab.url.includes('meet.google.com')) {
      throw new Error('Please switch to your Google Meet call tab before starting recording.');
    }

    // Reset content script transcript buffer
    await chrome.tabs.sendMessage(tab.id, { type: 'RESET_TRANSCRIPT' }).catch(() => {});

    // Obtain mediaStreamId directly under user gesture in the popup
    let streamId: string | undefined;
    let source: 'tab' | 'desktop' = 'tab';

    try {
      streamId = await new Promise<string>((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id?: string) => {
          const err = chrome.runtime.lastError;
          if (err || !id) {
            return reject(err ? new Error(err.message) : new Error('No streamId returned by tabCapture'));
          }
          resolve(id);
        });
      });
      source = 'tab';
    } catch (tabErr: any) {
      console.warn('[popup] tabCapture.getMediaStreamId failed, trying desktopCapture prompt:', tabErr);
      streamId = await new Promise<string>((resolve, reject) => {
        chrome.desktopCapture.chooseDesktopMedia(['tab', 'audio'], tab, (id?: string) => {
          const err = chrome.runtime.lastError;
          if (err) return reject(new Error(err.message));
          if (!id) return reject(new Error('Sharing was cancelled'));
          resolve(id);
        });
      });
      source = 'desktop';
    }

    const resp = await chrome.runtime.sendMessage({
      type: 'START_RECORDING',
      tabId: tab.id,
      streamId,
      source,
    });

    if (!resp) throw new Error('No response from background service worker');
    // If background says already recording, fix UI silently
    if (resp.alreadyRecording) {
      setUI(true, resp.startedAt, !!resp.paused, resp.realStartTime);
      return;
    }
    if (resp.ok === false) throw new Error(resp.error || 'Failed to start recording');

    setUI(true);
    toast('Recording started');
  } catch (e: any) {
    console.error('[popup] START_RECORDING error', e);
    setUI(false);
    alert(`Failed to start recording:\n${e?.message || e}`);
  } finally {
    inFlight = false;
  }
});

// Stop recording button
stopBtn?.addEventListener('click', async () => {
  if (!startBtn || !stopBtn || inFlight) return;
  inFlight = true;
  stopBtn.disabled = true;

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
    if (!resp) throw new Error('No response from background service worker');
    if (resp.ok === false) throw new Error(resp.error || 'Failed to stop recording');
    toast('Stopping and compiling recording…');
  } catch (e: any) {
    console.error('[popup] STOP_RECORDING error', e);
    alert(`Failed to stop recording:\n${e?.message || e}`);
    setUI(false);
  } finally {
    inFlight = false;
  }
});

pauseBtn?.addEventListener('click', async () => {
  if (inFlight) return;
  inFlight = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING' });
    if (!resp?.ok) throw new Error(resp?.error || 'Failed to pause');
  } catch (e) {
    console.error(e);
  } finally {
    inFlight = false;
  }
});

resumeBtn?.addEventListener('click', async () => {
  if (inFlight) return;
  inFlight = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'RESUME_RECORDING' });
    if (!resp?.ok) throw new Error(resp?.error || 'Failed to resume');
  } catch (e) {
    console.error(e);
  } finally {
    inFlight = false;
  }
});
