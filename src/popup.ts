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
const micBtn = document.getElementById('enable-mic') as HTMLButtonElement | null;
const micDesc = document.getElementById('mic-desc') as HTMLDivElement | null;
const startBtn = document.getElementById('start-rec') as HTMLButtonElement | null;
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

function setUI(recording: boolean, startedAt?: number) {
  if (!startBtn || !stopBtn) return;
  startBtn.disabled = recording;
  stopBtn.disabled = !recording;

  if (recording) {
    startBtn.style.display = 'none';
    stopBtn.style.display = 'flex';
    if (statusPill) statusPill.classList.add('recording');
    if (statusText) statusText.textContent = 'REC LIVE';
    if (timerCard) timerCard.classList.add('active');

    const effectiveStart = startedAt && startedAt > 0 ? startedAt : Date.now();
    if (startTimeInfo) {
      const timeStr = new Date(effectiveStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      startTimeInfo.innerHTML = `Started at: <strong>${timeStr}</strong>`;
    }

    if (!liveTimerInterval) {
      const updateTimer = () => {
        const elapsed = Date.now() - effectiveStart;
        if (timerDigits) timerDigits.textContent = formatDuration(elapsed);
      };
      updateTimer();
      liveTimerInterval = window.setInterval(updateTimer, 1000);
    }
  } else {
    startBtn.style.display = 'flex';
    stopBtn.style.display = 'none';
    if (statusPill) statusPill.classList.remove('recording');
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

// Settings synchronization
async function initSettings() {
  const current = await getSettings();

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

// Check microphone status and update button state
async function refreshMicButton() {
  if (!micBtn || !('permissions' in navigator)) return;
  try {
    // @ts-ignore
    const status = await (navigator as any).permissions.query({ name: 'microphone' });
    const set = () => {
      const granted = status.state === 'granted';
      micBtn.textContent = granted ? '✓ Active' : status.state === 'denied' ? 'Blocked' : 'Enable';
      micBtn.disabled = granted;
      if (granted) {
        micBtn.classList.add('granted');
        if (micDesc) micDesc.textContent = 'Your voice is recorded & mixed';
      } else {
        micBtn.classList.remove('granted');
        if (micDesc) micDesc.textContent = 'Permission needed to record your voice';
      }
    };
    set();
    status.onchange = set;
  } catch {}
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
    setUI(!!st?.recording, st?.startedAt);
  } catch {
    setUI(false);
  }
  refreshMicButton().catch(() => {});
  checkOrphanedRecordings().catch(() => {});
  initSettings().catch(() => {});
})();

// Listen for background state broadcasts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'RECORDING_STATE') setUI(!!msg.recording, msg.startedAt);
  if (msg?.type === 'RECORDING_SAVED') {
    toast(`Video saved: ${msg.filename || 'recording.webm'}`);
    setUI(false);
  }
  if (msg?.type === 'TRANSCRIPT_SAVED') {
    toast(`Transcript saved: ${msg.filename || 'transcript.txt'}`);
  }
});

// Microphone permission priming
micBtn?.addEventListener('click', async () => {
  try {
    if ('permissions' in navigator) {
      // @ts-ignore
      const p = await (navigator as any).permissions.query({ name: 'microphone' });
      if (p.state === 'granted') {
        alert('Microphone is already enabled for this extension.');
        await refreshMicButton();
        return;
      }
      if (p.state === 'denied') {
        await openMicSetupTab();
        return;
      }
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      alert('Microphone enabled for the extension.');
      await refreshMicButton();
    } catch {
      await openMicSetupTab();
    }
  } catch (e) {
    console.error('[popup] mic enable flow error', e);
    alert('Could not open the microphone setup page. Please try again.');
  }
});

let inFlight = false;

// Start recording button
startBtn?.addEventListener('click', async () => {
  if (!startBtn || !stopBtn || inFlight) return;
  inFlight = true;
  startBtn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found. Please navigate to a Google Meet call.');

    // Reset content script transcript buffer
    await chrome.tabs.sendMessage(tab.id, { type: 'RESET_TRANSCRIPT' }).catch(() => {});

    const resp = await chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: tab.id });
    if (!resp) throw new Error('No response from background service worker');
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
