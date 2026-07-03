import type { StudioAsset } from "@/lib/studio-types";

const DB_NAME = "riya-atelier";
const DB_VERSION = 1;
const STORE_NAME = "wardrobe";

function openWardrobeDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
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
    request.onerror = () => reject(request.error ?? new Error("Could not open wardrobe"));
  });
}

export async function loadWardrobeAssets(): Promise<StudioAsset[]> {
  const database = await openWardrobeDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();

    request.onsuccess = () => {
      const assets = (request.result as StudioAsset[]).sort(
        (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
      );
      resolve(assets);
    };
    request.onerror = () => reject(request.error ?? new Error("Could not load wardrobe"));
    transaction.oncomplete = () => database.close();
  });
}

export async function saveWardrobeAsset(asset: StudioAsset): Promise<void> {
  const database = await openWardrobeDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(asset);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save wardrobe asset"));
    };
  });
}

export async function removeWardrobeAsset(id: string): Promise<void> {
  const database = await openWardrobeDb();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not remove wardrobe asset"));
    };
  });
}
