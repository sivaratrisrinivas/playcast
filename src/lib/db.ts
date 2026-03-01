export interface SavedGame {
  id: string;
  date: number;
  title: string;
  videoBlob: Blob;
  summary: string;
  highlights: { time: number; text: string }[];
}

const DB_NAME = 'PlaycastDB';
const STORE_NAME = 'games';

export const initDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const saveGame = async (game: SavedGame) => {
  const db = await initDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  tx.objectStore(STORE_NAME).put(game);
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
  });
};

export const getGames = async (): Promise<SavedGame[]> => {
  const db = await initDB();
  return new Promise((resolve) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result.sort((a: SavedGame, b: SavedGame) => b.date - a.date));
  });
};
