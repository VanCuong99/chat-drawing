const DATABASE_NAME = 'net-message-outbox';
const STORE_NAME = 'blobs';

function openOutboxDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Outbox storage is unavailable.'));
  });
}

export async function saveOutboxBlob(key: string, blob: Blob) {
  const database = await openOutboxDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(blob, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Attachment could not be saved.'));
    });
  } finally {
    database.close();
  }
}

export async function readOutboxBlob(key: string) {
  const database = await openOutboxDatabase();
  try {
    return await new Promise<Blob | null>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => reject(request.error ?? new Error('Attachment could not be read.'));
    });
  } finally {
    database.close();
  }
}

export async function deleteOutboxBlob(key: string) {
  const database = await openOutboxDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error('Attachment could not be removed.'));
    });
  } finally {
    database.close();
  }
}

export async function deleteOutboxBlobsForPrefix(prefix: string) {
  const database = await openOutboxDatabase();
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
      request.onerror = () => reject(request.error ?? new Error('Attachments could not be removed.'));
    });
  } finally {
    database.close();
  }
}
