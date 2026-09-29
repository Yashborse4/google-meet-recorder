// src/popup.ts
// Extension Popup:
// - Orphan / Crash Recovery detection (MeetRecorderDB)
// - Microphone permission priming & verification
// - Manual Start / Stop tab recording controls
// - Manual Transcript download

import { recorderDB, SessionRecord } from './db';
import { fixWebmDuration } from './webmFix';

const saveBtn = document.getElementById('save') as HTMLButtonElement | null;
const micBtn = document.getElementById('enable-mic') as HTMLButtonElement | null;
const startBtn = document.getElementById('start-rec') as HTMLButtonElement | null;
const stopBtn = document.getElementById('stop-rec') as HTMLButtonElement | null;

const recoveryCard = document.getElementById('recovery-card') as HTMLDivElement | null;
const recoveryMsg = document.getElementById('recovery-msg') as HTMLParagraphElement | null;
const recoverBtn = document.getElementById('recover-btn') as HTMLButtonElement | null;
const discardBtn = document.getElementById('discard-btn') as HTMLButtonElement | null;

function setUI(recording: boolean) {
  if (!startBtn || !stopBtn) return;
  startBtn.disabled = recording;
  stopBtn.disabled = !recording;
}

function toast(msg: string) {
  console.log('[popup]', msg);
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
      micBtn.textContent =
        status.state === 'granted'
          ? 'Microphone Enabled ✓'
          : status.state === 'denied'
          ? 'Microphone Blocked'
          : 'Enable Microphone';
      micBtn.disabled = status.state === 'granted';
      if (status.state === 'granted') {
        micBtn.classList.add('success');
      } else {
        micBtn.classList.remove('success');
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
      pendingRecoverySession = orphaned[0]; // Recover most recent
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

    // Assemble Blob from IndexedDB chunks
    const rawBlob = await recorderDB.assembleSessionBlob(sess.sessionId, sess.mimeType || 'video/webm');
    // Patch EBML duration
    const seekableBlob = await fixWebmDuration(rawBlob, approxDurationMs);

    // Subtitle transcript
    const vttContent = await recorderDB.generateWebVTT(sess.sessionId);
    const vttBlob = new Blob([vttContent], { type: 'text/vtt' });

    const videoUrl = URL.createObjectURL(seekableBlob);
    const vttUrl = URL.createObjectURL(vttBlob);

    const suffix = sess.meetingId || 'recovered';
    const timestamp = Date.now();

    chrome.downloads.download({
      url: videoUrl,
      filename: `GoogleMeet-Recovered-${suffix}-${timestamp}.webm`,
      saveAs: true,
    });

    chrome.downloads.download({
      url: vttUrl,
      filename: `GoogleMeet-Recovered-Transcript-${suffix}-${timestamp}.vtt`,
      saveAs: false,
    });

    // Cleanup session from IndexedDB
    await recorderDB.deleteSession(sess.sessionId);
    if (recoveryCard) recoveryCard.style.display = 'none';
    pendingRecoverySession = null;
    toast('Orphaned recording successfully recovered and downloaded.');
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

// Init: sync recording state, check mic, and check for crashes
void (async () => {
  try {
    const st = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
    setUI(!!st?.recording);
  } catch {
    setUI(false);
  }
  refreshMicButton().catch(() => {});
  checkOrphanedRecordings().catch(() => {});
})();

// Listen for background state broadcasts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'RECORDING_STATE') setUI(!!msg.recording);
  if (msg?.type === 'RECORDING_SAVED') {
    toast(`Saved: ${msg.filename || 'recording.webm'}`);
    setUI(false);
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

// Manual transcript download (.txt)
saveBtn?.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TRANSCRIPT' }).catch(() => undefined);
  const transcript = (res as any)?.transcript as string | undefined;

  if (!transcript?.trim()) {
    toast('Transcript is empty');
    alert('Transcript is currently empty. Make sure Captions are turned on in Google Meet.');
    return;
  }

  const blob = new Blob([transcript], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const suffix = new URL(tab.url ?? 'https://meet.google.com').pathname.split('/').pop() || 'google-meet';

  chrome.downloads.download(
    { url, filename: `GoogleMeet-Transcript-${suffix}-${Date.now()}.txt`, saveAs: true },
    () => URL.revokeObjectURL(url)
  );
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
