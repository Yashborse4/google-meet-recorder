// src/micsetup.ts

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('enable') as HTMLButtonElement | null;
  const statusEl = document.getElementById('status') as HTMLDivElement | null;

  if (!btn || !statusEl) return;

  async function requestMic() {
    if (btn) btn.disabled = true;
    statusEl!.className = '';
    statusEl!.textContent = 'Requesting microphone permission…';

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Immediately release hardware mic tracks so the microphone is NOT kept open
      stream.getTracks().forEach((t) => t.stop());

      // Save granted state in extension storage
      try {
        await chrome.storage.local.set({ micPermissionGranted: true });
      } catch {}

      // Notify background and Meet tabs that permission was granted
      try {
        await chrome.runtime.sendMessage({ type: 'MIC_PERMISSION_GRANTED' });
      } catch {}

      statusEl!.className = 'success';
      statusEl!.textContent = '✓ Microphone enabled! Closing this window…';
      if (btn) {
        btn.textContent = '✓ Allowed';
        btn.style.background = '#23a55a';
      }

      // Automatically close the setup window after a short delay
      setTimeout(() => {
        try {
          window.close();
        } catch {}
      }, 1200);
    } catch (e: any) {
      if (btn) btn.disabled = false;
      statusEl!.className = 'error';
      statusEl!.textContent = `Permission denied: ${e?.name || e}. Please allow microphone in Chrome site settings.`;
      console.error('[micsetup] getUserMedia error:', e);
    }
  }

  btn.addEventListener('click', requestMic);

  // Auto-attempt permission request on page load
  requestMic().catch(() => {});
});