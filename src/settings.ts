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
    // Safety timeout: resolve with defaults if storage is completely broken
    const fallbackTimer = setTimeout(() => resolve({ ...DEFAULT_SETTINGS }), 3000);

    const resolveWith = (data: any) => {
      clearTimeout(fallbackTimer);
      resolve({ ...DEFAULT_SETTINGS, ...(data || {}) });
    };

    try {
      if (chrome.storage?.sync?.get) {
        chrome.storage.sync.get(STORAGE_KEY, (res) => {
          if (chrome.runtime.lastError || !res?.[STORAGE_KEY]) {
            // Fallback to local storage
            try {
              if (chrome.storage?.local?.get) {
                chrome.storage.local.get(STORAGE_KEY, (localRes) => {
                  if (chrome.runtime.lastError) {
                    resolveWith(null);
                  } else {
                    resolveWith(localRes?.[STORAGE_KEY]);
                  }
                });
              } else {
                resolveWith(null);
              }
            } catch {
              resolveWith(null);
            }
          } else {
            resolveWith(res[STORAGE_KEY]);
          }
        });
      } else if (chrome.storage?.local?.get) {
        chrome.storage.local.get(STORAGE_KEY, (localRes) => {
          if (chrome.runtime.lastError) {
            resolveWith(null);
          } else {
            resolveWith(localRes?.[STORAGE_KEY]);
          }
        });
      } else {
        resolveWith(null);
      }
    } catch {
      resolveWith(null);
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
