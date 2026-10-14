(function initializePreviewDatabase(globalScope) {
  "use strict";

  const DATABASE_NAME = "x-recall-previews";
  const DATABASE_VERSION = 1;
  const STORE_NAME = "previews";
  let databasePromise = null;

  function openDatabase() {
    if (databasePromise) {
      return databasePromise;
    }

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "tweetId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开预览数据库"));
      request.onblocked = () => reject(new Error("预览数据库正在被其他页面占用"));
    });

    return databasePromise;
  }

  async function runRequest(mode, operation) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      let result;

      try {
        result = operation(store);
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve(result?.result);
      transaction.onerror = () =>
        reject(transaction.error || new Error("预览数据库操作失败"));
      transaction.onabort = () =>
        reject(transaction.error || new Error("预览数据库操作已取消"));
    });
  }

  function putPreview(preview) {
    return runRequest("readwrite", (store) => store.put(preview));
  }

  function getPreview(tweetId) {
    return runRequest("readonly", (store) => store.get(String(tweetId)));
  }

  async function hasPreview(tweetId) {
    return (await runRequest("readonly", (store) => store.count(String(tweetId)))) > 0;
  }

  function deletePreviews(tweetIds) {
    return runRequest("readwrite", (store) => {
      for (const tweetId of tweetIds) {
        store.delete(String(tweetId));
      }
    });
  }

  function clearPreviews() {
    return runRequest("readwrite", (store) => store.clear());
  }

  async function getStats() {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).openCursor();
      let count = 0;
      let bytes = 0;

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve({ count, bytes });
          return;
        }

        count += 1;
        bytes += Math.max(
          0,
          Number(cursor.value?.byteLength) || Number(cursor.value?.blob?.size) || 0
        );
        cursor.continue();
      };
      request.onerror = () =>
        reject(request.error || new Error("无法统计预览占用空间"));
    });
  }

  globalScope.XRecallPreviewDB = Object.freeze({
    putPreview,
    getPreview,
    hasPreview,
    deletePreviews,
    clearPreviews,
    getStats
  });
})(globalThis);
