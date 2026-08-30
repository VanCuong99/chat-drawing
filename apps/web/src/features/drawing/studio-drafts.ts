const DATABASE_NAME = 'net-studio-drafts';
const STORE_NAME = 'drafts';

function openDraftDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Draft storage is unavailable.'));
  });
}

export async function readStudioDraft<T>(key: string): Promise<T | null> {
  const database = await openDraftDatabase();
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('Draft could not be read.'));
    });
  } finally {
    database.close();
  }
}

export async function saveStudioDraft<T>(key: string, value: T) {
  const database = await openDraftDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Draft could not be saved.'));
    });
  } finally {
    database.close();
  }
}

export async function deleteStudioDraft(key: string) {
  const database = await openDraftDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Draft could not be deleted.'));
    });
  } finally {
    database.close();
  }
}

export async function deleteStudioDraftsForPrefix(prefix: string) {
  const database = await openDraftDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const store = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
      const request = store.openKeyCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { resolve(); return; }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) store.delete(cursor.key);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error('Drafts could not be deleted.'));
    });
  } finally {
    database.close();
  }
}
