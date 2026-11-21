// 기록 저장(IndexedDB). 원본 영상은 저장하지 않고 분석 수치(JSON)와 4구간 스냅샷 JPG(Blob)만 저장한다.

const DB_NAME = 'swing-analyzer';
const DB_VERSION = 1;
const STORE = 'records';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('이 브라우저는 기록 저장(IndexedDB)을 지원하지 않아요.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('저장소를 열지 못했어요.'));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('저장이 취소됐어요(용량 부족일 수 있어요).'));
  }));
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export function saveRecord(record) {
  return tx('readwrite', (s) => reqP(s.put(record)));
}

export function listRecords() {
  return tx('readonly', (s) => reqP(s.getAll())).then((rows) => rows.sort((a, b) => b.createdAt - a.createdAt));
}

export function deleteRecord(id) {
  return tx('readwrite', (s) => reqP(s.delete(id)));
}

/** 대략적인 저장 용량 사용량(지원 브라우저만) */
export async function storageEstimate() {
  try {
    if (navigator.storage?.estimate) return await navigator.storage.estimate();
  } catch { /* 무시 */ }
  return null;
}
