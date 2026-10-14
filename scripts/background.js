"use strict";

importScripts("shared.js", "preview-db.js");

const shared = globalThis.XTweetRecall;
const previewDatabase = globalThis.XRecallPreviewDB;
const MAX_PREVIEW_WIDTH = 640;
const MAX_PREVIEW_HEIGHT = 960;
const PREVIEW_QUALITY = 0.82;
const MIN_CAPTURE_INTERVAL_MS = 550;
const pendingCaptures = new Map();
let captureQueue = Promise.resolve();
let lastCaptureAt = 0;
let dataGeneration = 0;

const messageHandlers = {
  "xRecall:capturePreview": handlePreviewRequest,
  "xRecall:getStorageStats": getStorageStats,
  "xRecall:clearAllData": clearAllData,
  "xRecall:deleteRecordsBefore": (message) => deleteRecordsBefore(message.before)
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = messageHandlers[message?.type];
  if (!handler) {
    return false;
  }

  handler(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.warn("[XRecall] 后台操作失败", error);
      sendResponse({ ok: false, reason: "background-error" });
    });
  return true;
});

async function handlePreviewRequest(message, sender) {
  const tweetId = String(message.tweetId || "");
  const replaceExisting = message.replaceExisting === true;
  if (!/^\d+$/.test(tweetId) || !isAllowedXTab(sender.tab)) {
    return { ok: false, reason: "invalid-request" };
  }

  const pending = pendingCaptures.get(tweetId);
  if (pending) {
    if (!replaceExisting) {
      return pending;
    }
    await pending.catch(() => undefined);
  }

  if (!replaceExisting && await previewDatabase.hasPreview(tweetId)) {
    return { ok: true, reason: "already-exists" };
  }

  if (pendingCaptures.has(tweetId)) {
    return pendingCaptures.get(tweetId);
  }

  const generation = dataGeneration;
  const operation = enqueueCapture(() =>
    captureAndStorePreview(message, sender.tab, generation)
  ).finally(() => {
    pendingCaptures.delete(tweetId);
  });
  pendingCaptures.set(tweetId, operation);
  return operation;
}

function enqueueCapture(operation) {
  const next = captureQueue
    .catch(() => undefined)
    .then(async () => {
      const waitMs = Math.max(
        0,
        MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt)
      );
      if (waitMs > 0) {
        await wait(waitMs);
      }

      lastCaptureAt = Date.now();
      return operation();
    });
  captureQueue = next.catch(() => undefined);
  return next;
}

async function captureAndStorePreview(message, tab, generation) {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    windowId: tab.windowId
  });
  if (activeTab?.id !== tab.id || !isAllowedXTab(activeTab)) {
    return { ok: false, reason: "tab-not-active" };
  }
  if (message.pageUrl && !shared.isSamePage(activeTab.url, message.pageUrl)) {
    return { ok: false, reason: "page-changed" };
  }

  const crop = normalizeCrop(message.crop, message.viewport);
  if (!crop) {
    return { ok: false, reason: "invalid-crop" };
  }

  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png"
  });
  if (message.pageUrl) {
    const [tabAfterCapture] = await chrome.tabs.query({
      active: true,
      windowId: tab.windowId
    });
    if (
      tabAfterCapture?.id !== tab.id ||
      !shared.isSamePage(tabAfterCapture.url, message.pageUrl)
    ) {
      return { ok: false, reason: "page-changed" };
    }
  }
  const preview = await cropScreenshot(screenshot, crop, message.viewport);
  if (!preview || generation !== dataGeneration) {
    return { ok: false, reason: "capture-cancelled" };
  }

  const recordExists = await waitForTweetRecord(message.tweetId);
  if (!recordExists || generation !== dataGeneration) {
    return { ok: false, reason: "record-missing" };
  }

  await previewDatabase.putPreview({
    tweetId: String(message.tweetId),
    blob: preview.blob,
    width: preview.width,
    height: preview.height,
    byteLength: preview.blob.size,
    createdAt: new Date().toISOString()
  });

  void chrome.runtime
    .sendMessage({
      type: "xRecall:previewStored",
      tweetId: String(message.tweetId)
    })
    .catch(() => undefined);

  return {
    ok: true,
    width: preview.width,
    height: preview.height,
    byteLength: preview.blob.size
  };
}

function normalizeCrop(crop, viewport) {
  const viewportWidth = Number(viewport?.width);
  const viewportHeight = Number(viewport?.height);
  const left = Number(crop?.left);
  const top = Number(crop?.top);
  const width = Number(crop?.width);
  const height = Number(crop?.height);
  if (
    ![viewportWidth, viewportHeight, left, top, width, height].every(
      Number.isFinite
    ) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    width < 120 ||
    height < 72
  ) {
    return null;
  }

  const normalizedLeft = Math.max(0, Math.min(left, viewportWidth));
  const normalizedTop = Math.max(0, Math.min(top, viewportHeight));
  return {
    left: normalizedLeft,
    top: normalizedTop,
    width: Math.min(width, viewportWidth - normalizedLeft),
    height: Math.min(height, viewportHeight - normalizedTop)
  };
}

async function cropScreenshot(dataUrl, crop, viewport) {
  const sourceBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);
  try {
    const scaleX = bitmap.width / Number(viewport.width);
    const scaleY = bitmap.height / Number(viewport.height);
    const sourceX = Math.max(0, Math.round(crop.left * scaleX));
    const sourceY = Math.max(0, Math.round(crop.top * scaleY));
    const sourceWidth = Math.min(
      bitmap.width - sourceX,
      Math.max(1, Math.round(crop.width * scaleX))
    );
    const sourceHeight = Math.min(
      bitmap.height - sourceY,
      Math.max(1, Math.round(crop.height * scaleY))
    );
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return null;
    }

    const outputScale = Math.min(
      1,
      MAX_PREVIEW_WIDTH / sourceWidth,
      MAX_PREVIEW_HEIGHT / sourceHeight
    );
    const outputWidth = Math.max(1, Math.round(sourceWidth * outputScale));
    const outputHeight = Math.max(1, Math.round(sourceHeight * outputScale));
    const canvas = new OffscreenCanvas(outputWidth, outputHeight);
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new Error("无法创建截图画布");
    }
    context.drawImage(
      bitmap,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      outputWidth,
      outputHeight
    );
    const blob = await canvas.convertToBlob({
      type: "image/webp",
      quality: PREVIEW_QUALITY
    });
    return { blob, width: outputWidth, height: outputHeight };
  } finally {
    bitmap.close?.();
  }
}

async function waitForTweetRecord(tweetId) {
  const storageKey = shared.makeStorageKey(tweetId);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const stored = await chrome.storage.local.get(storageKey);
    if (shared.isTweetRecord(stored[storageKey])) {
      return true;
    }
    await wait(100);
  }
  return false;
}

async function readTweetRecordEntries() {
  const stored = await chrome.storage.local.get(null);
  return Object.entries(stored).filter(
    ([key, value]) =>
      key.startsWith(shared.STORAGE_PREFIX) && shared.isTweetRecord(value)
  );
}

async function getStorageStats() {
  const [entries, previewStats] = await Promise.all([
    readTweetRecordEntries(),
    previewDatabase.getStats()
  ]);
  return { ok: true, recordCount: entries.length, ...previewStats };
}

async function clearAllData() {
  dataGeneration += 1;
  const stored = await chrome.storage.local.get(null);
  const recordKeys = Object.keys(stored).filter((key) =>
    key.startsWith(shared.STORAGE_PREFIX)
  );
  await Promise.all([
    recordKeys.length ? chrome.storage.local.remove(recordKeys) : undefined,
    previewDatabase.clearPreviews()
  ]);
  return { ok: true, deletedRecords: recordKeys.length };
}

async function deleteRecordsBefore(before) {
  const cutoff = Number(before);
  if (!Number.isFinite(cutoff)) {
    return { ok: false, reason: "invalid-request" };
  }

  const expired = (await readTweetRecordEntries()).filter(
    ([, value]) => shared.getRecordTime(value) < cutoff
  );
  if (expired.length) {
    await chrome.storage.local.remove(expired.map(([key]) => key));
    await previewDatabase.deletePreviews(expired.map(([, value]) => String(value.id)));
  }
  return { ok: true, deletedRecords: expired.length };
}

function isAllowedXTab(tab) {
  try {
    return Boolean(
      tab?.id >= 0 &&
        tab?.windowId >= 0 &&
        shared.isXHost(new URL(tab.url || "").hostname)
    );
  } catch {
    return false;
  }
}


function wait(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay));
}
