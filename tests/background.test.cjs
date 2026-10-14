"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const shared = require("../scripts/shared.js");

const backgroundScript = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "background.js"),
  "utf8"
);

function createBackgroundHarness({ previewExistsInitially = false } = {}) {
  let messageListener = null;
  const stored = {
    "xRecall:setting:showPreviews": true,
    "xRecall:tweet:24680": {
      id: "24680",
      url: "https://x.com/example/status/24680"
    }
  };
  const writtenPreviews = [];
  const removedKeys = [];
  const deletedPreviewIds = [];
  let previewsCleared = false;
  let drawArguments = null;
  let previewExists = previewExistsInitially;

  const previewDatabase = {
    async hasPreview() {
      return previewExists;
    },
    async putPreview(preview) {
      writtenPreviews.push(preview);
      previewExists = true;
    },
    async getStats() {
      return { count: 1, bytes: 7 };
    },
    async clearPreviews() {
      previewsCleared = true;
    },
    async deletePreviews(tweetIds) {
      deletedPreviewIds.push(...tweetIds);
    }
  };
  const sandbox = {
    XTweetRecall: shared,
    XRecallPreviewDB: previewDatabase,
    URL,
    Date,
    Blob,
    Promise,
    console,
    setTimeout,
    importScripts() {},
    fetch: async () => ({
      async blob() {
        return new Blob(["source"], { type: "image/png" });
      }
    }),
    createImageBitmap: async () => ({
      width: 1280,
      height: 720,
      close() {}
    }),
    OffscreenCanvas: class OffscreenCanvas {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return {
          drawImage(...args) {
            drawArguments = args;
          }
        };
      }
      async convertToBlob() {
        return new Blob(["preview"], { type: "image/webp" });
      }
    },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) {
            messageListener = listener;
          }
        },
        async sendMessage() {}
      },
      tabs: {
        async query() {
          return [
            {
              id: 9,
              windowId: 3,
              active: true,
              url: "https://x.com/home"
            }
          ];
        },
        async captureVisibleTab() {
          return "data:image/png;base64,c2NyZWVuc2hvdA==";
        }
      },
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string") {
              return Object.hasOwn(stored, key) ? { [key]: stored[key] } : {};
            }
            return { ...stored };
          },
          async remove(keys) {
            for (const key of keys) {
              removedKeys.push(key);
              delete stored[key];
            }
          }
        }
      }
    }
  };

  vm.runInNewContext(backgroundScript, sandbox, { filename: "background.js" });

  async function send(message) {
    return new Promise((resolve, reject) => {
      const keepChannelOpen = messageListener(
        message,
        {
          tab: {
            id: 9,
            windowId: 3,
            active: true,
            url: "https://x.com/home"
          }
        },
        resolve
      );
      if (!keepChannelOpen) {
        reject(new Error("后台消息通道未保持打开"));
      }
    });
  }

  return {
    send,
    stored,
    writtenPreviews,
    removedKeys,
    deletedPreviewIds,
    get previewsCleared() {
      return previewsCleared;
    },
    get drawArguments() {
      return drawArguments;
    }
  };
}

test("后台会裁切活动 X 标签页并写入 WebP 预览", async () => {
  const harness = createBackgroundHarness();
  const result = await harness.send({
    type: "xRecall:capturePreview",
    tweetId: "24680",
    crop: { left: 200, top: 100, width: 640, height: 500 },
    viewport: { width: 1280, height: 720 }
  });

  assert.equal(result.ok, true);
  assert.equal(harness.writtenPreviews.length, 1);
  assert.equal(harness.writtenPreviews[0].blob.type, "image/webp");
  assert.ok(harness.writtenPreviews[0].width <= 640);
  assert.ok(Array.isArray(harness.drawArguments));
});

test("点击后页面已经切换时，不会用旧坐标保存错误截图", async () => {
  const harness = createBackgroundHarness();
  const result = await harness.send({
    type: "xRecall:capturePreview",
    tweetId: "24680",
    crop: { left: 200, top: 100, width: 640, height: 500 },
    viewport: { width: 1280, height: 720 },
    pageUrl: "https://x.com/example/media?filter=photo"
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "page-changed");
  assert.equal(harness.writtenPreviews.length, 0);
});

test("图片查看器可以用稳定后的裁切覆盖临时预览", async () => {
  const harness = createBackgroundHarness({ previewExistsInitially: true });
  const request = {
    type: "xRecall:capturePreview",
    tweetId: "24680",
    crop: { left: 200, top: 100, width: 640, height: 500 },
    viewport: { width: 1280, height: 720 }
  };

  const kept = await harness.send(request);
  assert.equal(kept.reason, "already-exists");
  assert.equal(harness.writtenPreviews.length, 0);

  const replaced = await harness.send({ ...request, replaceExisting: true });
  assert.equal(replaced.ok, true);
  assert.equal(harness.writtenPreviews.length, 1);
});

test("清除全部数据会同时删除推文记录与预览文件", async () => {
  const harness = createBackgroundHarness();
  const result = await harness.send({ type: "xRecall:clearAllData" });

  assert.equal(result.ok, true);
  assert.deepEqual(harness.removedKeys, ["xRecall:tweet:24680"]);
  assert.equal(harness.previewsCleared, true);
  assert.equal(harness.stored["xRecall:setting:showPreviews"], true);
});

test("按时间删除只移除早于截止时间的推文及其预览", async () => {
  const harness = createBackgroundHarness();
  harness.stored["xRecall:tweet:24680"].lastVisitedAt = "2026-10-10T08:00:00.000Z";
  harness.stored["xRecall:tweet:111"] = {
    id: "111",
    url: "https://x.com/old/status/111",
    firstVisitedAt: "2026-06-01T08:00:00.000Z",
    lastVisitedAt: "2026-08-01T08:00:00.000Z"
  };
  harness.stored["xRecall:tweet:222"] = {
    id: "222",
    url: "https://x.com/older/status/222",
    firstVisitedAt: "2026-05-01T08:00:00.000Z"
  };

  const result = await harness.send({
    type: "xRecall:deleteRecordsBefore",
    before: Date.parse("2026-09-01T00:00:00.000Z")
  });

  assert.equal(result.ok, true);
  assert.equal(result.deletedRecords, 2);
  assert.deepEqual(harness.removedKeys.sort(), [
    "xRecall:tweet:111",
    "xRecall:tweet:222"
  ]);
  assert.deepEqual(harness.deletedPreviewIds.sort(), ["111", "222"]);
  assert.ok(harness.stored["xRecall:tweet:24680"]);
  assert.equal(harness.stored["xRecall:setting:showPreviews"], true);
  assert.equal(harness.previewsCleared, false);
});

test("按时间删除拒绝无效的截止时间", async () => {
  const harness = createBackgroundHarness();
  const result = await harness.send({ type: "xRecall:deleteRecordsBefore" });

  assert.equal(result.ok, false);
  assert.deepEqual(harness.removedKeys, []);
});
