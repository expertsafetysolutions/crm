import { openDB } from 'idb';

const DB_NAME = 'expert_safety_pwa_db';
const STORE_NAME = 'offline_queue';

async function initDB() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    }
  });
}

/**
 * Add an offline action to IndexedDB queue
 * @param {string} type - 'ADVANCE_STAGE' | 'RESCHEDULE' | 'ACTIVITY_LOG'
 * @param {object} payload - action parameters
 */
export async function enqueueOfflineAction(type, payload) {
  const db = await initDB();
  const id = `action_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const item = {
    id,
    type,
    payload,
    timestamp: new Date().toISOString()
  };
  await db.put(STORE_NAME, item);
  return item;
}

export async function getOfflineQueue() {
  const db = await initDB();
  return db.getAll(STORE_NAME);
}

export async function removeOfflineAction(id) {
  const db = await initDB();
  return db.delete(STORE_NAME, id);
}

export async function clearOfflineQueue() {
  const db = await initDB();
  return db.clear(STORE_NAME);
}

/**
 * Flush all pending offline actions to backend API
 * @param {string} token - JWT auth token
 */
export async function flushOfflineQueue(token) {
  const queue = await getOfflineQueue();
  if (!queue || queue.length === 0) {
    return { synced: 0 };
  }

  try {
    const res = await fetch('/api/sync/batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ actions: queue })
    });

    if (!res.ok) {
      throw new Error(`Batch sync failed with HTTP ${res.status}`);
    }

    const data = await res.json();
    // Successfully synced items can be cleared from IndexedDB
    if (data.results) {
      for (const itemResult of data.results) {
        if (itemResult.status === 'SUCCESS') {
          await removeOfflineAction(itemResult.id);
        }
      }
    }

    return { synced: data.processedCount || queue.length, details: data };
  } catch (err) {
    console.error('Offline queue flush failed:', err);
    throw err;
  }
}
