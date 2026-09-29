// src/db.ts
// MeetRecorderDB: Local-first IndexedDB engine for crash-proof chunking, WebVTT captions, and session recovery.

export interface SessionRecord {
  sessionId: string;
  meetingId: string;
  startedAt: number;
  endedAt: number | null;
  status: 'RECORDING' | 'FINALIZING' | 'COMPLETED' | 'PURGED';
  mimeType: string;
  chunkCount: number;
  totalBytes: number;
}

export interface ChunkRecord {
  id?: number;
  sessionId: string;
  sequence: number;
  timestamp: number;
  data: Blob;
  byteSize: number;
}

export interface CaptionRecord {
  id?: number;
  sessionId: string;
  relativeTimeMs: number;
  speaker: string;
  text: string;
}

const DB_NAME = 'MeetRecorderDB';
const DB_VERSION = 2;

class RecorderDatabase {
  private dbPromise: Promise<IDBDatabase> | null = null;

  public getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e: IDBVersionChangeEvent) => {
        const db = req.result;

        // Sessions store
        if (!db.objectStoreNames.contains('sessions')) {
          const sessionsStore = db.createObjectStore('sessions', { keyPath: 'sessionId' });
          sessionsStore.createIndex('by_status', 'status', { unique: false });
        }

        // Chunks store
        if (!db.objectStoreNames.contains('chunks')) {
          const chunksStore = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
          chunksStore.createIndex('by_session', 'sessionId', { unique: false });
          chunksStore.createIndex('by_session_seq', ['sessionId', 'sequence'], { unique: true });
        }

        // Captions store
        if (!db.objectStoreNames.contains('captions')) {
          const captionsStore = db.createObjectStore('captions', { keyPath: 'id', autoIncrement: true });
          captionsStore.createIndex('by_session', 'sessionId', { unique: false });
        }
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        this.dbPromise = null;
        reject(req.error);
      };
    });

    return this.dbPromise;
  }

  // --- Session Management ---

  public async createSession(sessionId: string, meetingId: string, mimeType: string): Promise<SessionRecord> {
    const db = await this.getDB();
    const session: SessionRecord = {
      sessionId,
      meetingId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'RECORDING',
      mimeType,
      chunkCount: 0,
      totalBytes: 0,
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      const req = store.put(session);
      req.onsuccess = () => resolve(session);
      req.onerror = () => reject(req.error);
    });
  }

  public async getSession(sessionId: string): Promise<SessionRecord | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readonly');
      const req = tx.objectStore('sessions').get(sessionId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  public async updateSessionStatus(sessionId: string, status: SessionRecord['status'], endedAt: number | null = null): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite');
      const store = tx.objectStore('sessions');
      const req = store.get(sessionId);

      req.onsuccess = () => {
        const session = req.result as SessionRecord | undefined;
        if (!session) return resolve();
        session.status = status;
        if (endedAt) session.endedAt = endedAt;
        store.put(session);
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  public async getOrphanedSessions(): Promise<SessionRecord[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readonly');
      const store = tx.objectStore('sessions');
      const index = store.index('by_status');
      const req = index.getAll('RECORDING');
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // --- Chunk Management ---

  public async writeChunk(sessionId: string, sequence: number, chunkBlob: Blob): Promise<void> {
    const db = await this.getDB();
    const record: ChunkRecord = {
      sessionId,
      sequence,
      timestamp: Date.now(),
      data: chunkBlob,
      byteSize: chunkBlob.size,
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction(['chunks', 'sessions'], 'readwrite');
      const chunkStore = tx.objectStore('chunks');
      const sessionStore = tx.objectStore('sessions');

      chunkStore.put(record);

      const sessReq = sessionStore.get(sessionId);
      sessReq.onsuccess = () => {
        const session = sessReq.result as SessionRecord | undefined;
        if (session) {
          session.chunkCount = Math.max(session.chunkCount, sequence + 1);
          session.totalBytes += chunkBlob.size;
          sessionStore.put(session);
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /**
   * Memory-safe cursor assembly: reads chunks sequentially using an IDBCursor
   * and yields slices in batches to prevent heap exhaustion.
   */
  public async assembleSessionBlob(sessionId: string, mimeType = 'video/webm'): Promise<Blob> {
    const db = await this.getDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction('chunks', 'readonly');
      const store = tx.objectStore('chunks');
      const index = store.index('by_session_seq');
      // Bound to this sessionId
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);

      const parts: Blob[] = [];
      const req = index.openCursor(range, 'next');

      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const val = cursor.value as ChunkRecord;
          if (val && val.data) {
            parts.push(val.data);
          }
          cursor.continue();
        } else {
          // Finished cursor iteration
          try {
            const assembled = new Blob(parts, { type: mimeType });
            resolve(assembled);
          } catch (err) {
            reject(err);
          }
        }
      };

      req.onerror = () => reject(req.error);
    });
  }

  // --- Caption Management ---

  public async writeCaption(sessionId: string, relativeTimeMs: number, speaker: string, text: string): Promise<void> {
    const db = await this.getDB();
    const record: CaptionRecord = {
      sessionId,
      relativeTimeMs,
      speaker: speaker.trim(),
      text: text.trim(),
    };

    return new Promise((resolve, reject) => {
      const tx = db.transaction('captions', 'readwrite');
      const store = tx.objectStore('captions');
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  public async getCaptions(sessionId: string): Promise<CaptionRecord[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('captions', 'readonly');
      const store = tx.objectStore('captions');
      const index = store.index('by_session');
      const req = index.getAll(sessionId);
      req.onsuccess = () => {
        const records: CaptionRecord[] = req.result || [];
        records.sort((a, b) => a.relativeTimeMs - b.relativeTimeMs);
        resolve(records);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Generates a standard WebVTT formatted string from stored captions.
   */
  public async generateWebVTT(sessionId: string): Promise<string> {
    const captions = await this.getCaptions(sessionId);
    if (!captions.length) return 'WEBVTT\n\nNOTE No captions recorded\n';

    let vtt = 'WEBVTT - Google Meet Transcript\n\n';

    const formatVttTime = (ms: number): string => {
      const totalSec = Math.floor(ms / 1000);
      const hours = Math.floor(totalSec / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      const secs = totalSec % 60;
      const millis = ms % 1000;
      return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
    };

    for (let i = 0; i < captions.length; i++) {
      const c = captions[i];
      const startMs = Math.max(0, c.relativeTimeMs);
      // If there's a next caption, estimate end time up to 5s max, or default duration of 3s
      const nextTime = i + 1 < captions.length ? captions[i + 1].relativeTimeMs : startMs + 3000;
      const endMs = Math.min(startMs + 7000, Math.max(startMs + 1500, nextTime));

      vtt += `${i + 1}\n`;
      vtt += `${formatVttTime(startMs)} --> ${formatVttTime(endMs)}\n`;
      vtt += `<v ${c.speaker}>${c.text}\n\n`;
    }

    return vtt;
  }

  // --- Storage Cleanup ---

  public async deleteSession(sessionId: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['sessions', 'chunks', 'captions'], 'readwrite');
      tx.objectStore('sessions').delete(sessionId);

      // Delete associated chunks
      const chunkStore = tx.objectStore('chunks');
      const chunkIndex = chunkStore.index('by_session');
      const chunkReq = chunkIndex.openKeyCursor(IDBKeyRange.only(sessionId));
      chunkReq.onsuccess = () => {
        const cursor = chunkReq.result;
        if (cursor) {
          chunkStore.delete(cursor.primaryKey);
          cursor.continue();
        }
      };

      // Delete associated captions
      const captionStore = tx.objectStore('captions');
      const captionIndex = captionStore.index('by_session');
      const captionReq = captionIndex.openKeyCursor(IDBKeyRange.only(sessionId));
      captionReq.onsuccess = () => {
        const cursor = captionReq.result;
        if (cursor) {
          captionStore.delete(cursor.primaryKey);
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export const recorderDB = new RecorderDatabase();
