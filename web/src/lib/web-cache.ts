import type { AccountItem } from "../types";

const WEB_CACHE_DB_NAME = "cpa_codex_quota_cache";
const WEB_CACHE_DB_VERSION = 2;
const WEB_PAYLOAD_STORE_NAME = "payload-cache";
const WEB_QUOTA_SNAPSHOT_STORE_NAME = "quota-snapshots";
const WEB_PAYLOAD_RECORD_ID = "latest";

interface WebPayloadCacheRecord {
  id: typeof WEB_PAYLOAD_RECORD_ID;
  payload: unknown;
  updatedAt: string;
}

export interface QuotaSnapshotRecord {
  auth_index: string;
  name: string;
  email: string;
  expired: string | null;
  status: AccountItem["status"];
  windows: AccountItem["windows"];
  additional_windows: AccountItem["additional_windows"];
  error: string;
  timings_ms: Record<string, number>;
  last_query_at: string | null;
  quota_reset_at: string | null;
  quota_reset_label: string | null;
  quota_updated_at: string | null;
}

const ACCOUNT_STATUSES = new Set<AccountItem["status"]>(["healthy", "low", "exhausted", "error", "unknown"]);

function getIndexedDBFactory(): IDBFactory | null {
  const globalValue = globalThis as typeof globalThis & { indexedDB?: IDBFactory };
  if (globalValue.indexedDB) {
    return globalValue.indexedDB;
  }
  if (typeof window !== "undefined" && window.indexedDB) {
    return window.indexedDB;
  }
  return null;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

async function openWebCacheDatabase(): Promise<IDBDatabase | null> {
  const factory = getIndexedDBFactory();
  if (!factory) {
    return null;
  }
  return new Promise((resolve, reject) => {
    const request = factory.open(WEB_CACHE_DB_NAME, WEB_CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WEB_PAYLOAD_STORE_NAME)) {
        db.createObjectStore(WEB_PAYLOAD_STORE_NAME, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(WEB_QUOTA_SNAPSHOT_STORE_NAME)) {
        db.createObjectStore(WEB_QUOTA_SNAPSHOT_STORE_NAME, { keyPath: "auth_index" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

async function runStoreRequest<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const db = await openWebCacheDatabase();
  if (!db) {
    return null;
  }
  try {
    const transaction = db.transaction(storeName, mode);
    return await requestToPromise(operation(transaction.objectStore(storeName)));
  } finally {
    db.close();
  }
}

function readPayloadFromRecord(record: unknown): unknown | null {
  if (!record || typeof record !== "object") {
    return null;
  }
  const payload = (record as Partial<WebPayloadCacheRecord>).payload;
  return payload ?? null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeStatus(value: unknown): AccountItem["status"] {
  return typeof value === "string" && ACCOUNT_STATUSES.has(value as AccountItem["status"]) ? (value as AccountItem["status"]) : "unknown";
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readQuotaSnapshotRecord(record: unknown): QuotaSnapshotRecord | null {
  const raw = readObject(record);
  const authIndex = cleanString(raw.auth_index);
  if (!authIndex) {
    return null;
  }
  return {
    auth_index: authIndex,
    name: cleanString(raw.name),
    email: cleanString(raw.email),
    expired: normalizeTimestamp(raw.expired),
    status: normalizeStatus(raw.status),
    windows: Array.isArray(raw.windows) ? (raw.windows as AccountItem["windows"]) : [],
    additional_windows: Array.isArray(raw.additional_windows) ? (raw.additional_windows as AccountItem["additional_windows"]) : [],
    error: cleanString(raw.error),
    timings_ms: readObject(raw.timings_ms) as Record<string, number>,
    last_query_at: normalizeTimestamp(raw.last_query_at),
    quota_reset_at: normalizeTimestamp(raw.quota_reset_at),
    quota_reset_label: normalizeTimestamp(raw.quota_reset_label) ?? normalizeTimestamp(raw.quota_updated_at),
    quota_updated_at: normalizeTimestamp(raw.quota_updated_at),
  };
}

export async function loadWebPayloadCache(): Promise<unknown | null> {
  try {
    const record = await runStoreRequest<WebPayloadCacheRecord | undefined>(WEB_PAYLOAD_STORE_NAME, "readonly", (store) => store.get(WEB_PAYLOAD_RECORD_ID));
    return readPayloadFromRecord(record);
  } catch {
    return null;
  }
}

export async function saveWebPayloadCache(payload: unknown): Promise<boolean> {
  try {
    const key = await runStoreRequest<IDBValidKey>(WEB_PAYLOAD_STORE_NAME, "readwrite", (store) =>
      store.put({ id: WEB_PAYLOAD_RECORD_ID, payload, updatedAt: new Date().toISOString() }),
    );
    return key === WEB_PAYLOAD_RECORD_ID;
  } catch {
    return false;
  }
}

export async function clearWebPayloadCache(): Promise<boolean> {
  try {
    await runStoreRequest<undefined>(WEB_PAYLOAD_STORE_NAME, "readwrite", (store) => store.delete(WEB_PAYLOAD_RECORD_ID));
    return true;
  } catch {
    return false;
  }
}

export async function loadWebQuotaSnapshot(authIndex: string): Promise<QuotaSnapshotRecord | null> {
  if (!authIndex) {
    return null;
  }
  try {
    const record = await runStoreRequest<QuotaSnapshotRecord | undefined>(WEB_QUOTA_SNAPSHOT_STORE_NAME, "readonly", (store) => store.get(authIndex));
    return readQuotaSnapshotRecord(record);
  } catch {
    return null;
  }
}

export async function loadWebQuotaSnapshots(authIndexes: string[]): Promise<Map<string, QuotaSnapshotRecord>> {
  const uniqueAuthIndexes = Array.from(new Set(authIndexes.filter(Boolean)));
  const snapshots = new Map<string, QuotaSnapshotRecord>();
  if (!uniqueAuthIndexes.length) {
    return snapshots;
  }
  try {
    const db = await openWebCacheDatabase();
    if (!db) {
      return snapshots;
    }
    try {
      const store = db.transaction(WEB_QUOTA_SNAPSHOT_STORE_NAME, "readonly").objectStore(WEB_QUOTA_SNAPSHOT_STORE_NAME);
      const records = await Promise.all(uniqueAuthIndexes.map((authIndex) => requestToPromise(store.get(authIndex))));
      for (const record of records) {
        const snapshot = readQuotaSnapshotRecord(record);
        if (snapshot) {
          snapshots.set(snapshot.auth_index, snapshot);
        }
      }
      return snapshots;
    } finally {
      db.close();
    }
  } catch {
    return snapshots;
  }
}

export async function saveWebQuotaSnapshot(snapshot: QuotaSnapshotRecord): Promise<boolean> {
  const normalized = readQuotaSnapshotRecord(snapshot);
  if (!normalized) {
    return false;
  }
  try {
    const key = await runStoreRequest<IDBValidKey>(WEB_QUOTA_SNAPSHOT_STORE_NAME, "readwrite", (store) => store.put(normalized));
    return key === normalized.auth_index;
  } catch {
    return false;
  }
}

export async function clearWebQuotaSnapshots(): Promise<boolean> {
  try {
    await runStoreRequest<undefined>(WEB_QUOTA_SNAPSHOT_STORE_NAME, "readwrite", (store) => store.clear());
    return true;
  } catch {
    return false;
  }
}
