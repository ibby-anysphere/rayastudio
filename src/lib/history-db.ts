const DB_NAME = "riya-history";
const DB_VERSION = 1;
const STORE_NAME = "images";

interface StoredHistoryImage {
  id: string;
  blob: Blob;
}

function openHistoryDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("History storage is unavailable"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open history storage"));
  });
}

export async function saveHistoryImage(id: string, blob: Blob): Promise<void> {
  const database = await openHistoryDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ id, blob } satisfies StoredHistoryImage);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save history image"));
    };
  });
}

export async function loadHistoryImage(id: string): Promise<Blob | null> {
  const database = await openHistoryDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => {
      resolve((request.result as StoredHistoryImage | undefined)?.blob ?? null);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Could not load history image"));
    transaction.oncomplete = () => database.close();
  });
}

export async function removeHistoryImage(id: string): Promise<void> {
  const database = await openHistoryDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not remove history image"));
    };
  });
}

export async function clearHistoryImages(): Promise<void> {
  const database = await openHistoryDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not clear history images"));
    };
  });
}
