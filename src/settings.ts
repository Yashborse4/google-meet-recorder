// src/settings.ts
// Configuration schema and storage manager for Meet Recorder extension.

export interface ExtensionSettings {
  saveVideo: boolean;
  saveTxtTranscript: boolean;
  saveVttSubtitles: boolean;
  videoQuality: '1080p' | '720p' | 'max';
  autoMixMic: boolean;
  noiseSuppression: boolean;
  autoStopOnExit: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  saveVideo: true,
  saveTxtTranscript: true,
  saveVttSubtitles: true,
  videoQuality: '1080p',
  autoMixMic: true,
  noiseSuppression: true,
  autoStopOnExit: true,
};

const STORAGE_KEY = 'meet_recorder_settings';

export async function getSettings(): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.sync?.get(STORAGE_KEY, (res) => {
        if (chrome.runtime.lastError || !res?.[STORAGE_KEY]) {
          chrome.storage?.local?.get(STORAGE_KEY, (localRes) => {
            resolve({ ...DEFAULT_SETTINGS, ...(localRes?.[STORAGE_KEY] || {}) });
          });
        } else {
          resolve({ ...DEFAULT_SETTINGS, ...res[STORAGE_KEY] });
        }
      });
    } catch {
      resolve(DEFAULT_SETTINGS);
    }
  });
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage?.sync?.set({ [STORAGE_KEY]: settings }, () => {
        chrome.storage?.local?.set({ [STORAGE_KEY]: settings }, () => {
          resolve();
        });
      });
    } catch {
      resolve();
    }
  });
}
