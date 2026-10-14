"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const shared = require("../scripts/shared.js");

const recorderScript = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "recorder.js"),
  "utf8"
);
const feedScript = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "feed.js"),
  "utf8"
);
const contentScripts = `${recorderScript}\n${feedScript}`;

async function runContentScriptAt(url, storedItems = {}) {
  const writtenItems = [];

  const sandbox = {
    XTweetRecall: shared,
    URL,
    Date,
    console,
    queueMicrotask,
    window: {
      location: { href: url },
      setInterval() {
        return 1;
      },
      setTimeout() {
        return 1;
      },
      clearTimeout() {}
    },
    document: {
      documentElement: {},
      querySelectorAll() {
        return [];
      }
    },
    MutationObserver: class MutationObserver {
      observe() {}
    },
    chrome: {
      storage: {
        local: {
          async get(key) {
            if (typeof key === "string" && Object.hasOwn(storedItems, key)) {
              return { [key]: storedItems[key] };
            }
            return { ...storedItems };
          },
          async set(items) {
            writtenItems.push(items);
          }
        }
      }
    }
  };

  vm.runInNewContext(recorderScript, sandbox, { filename: "recorder.js" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return writtenItems;
}

async function runPhotoViewerScenario({ initiallyReady = true } = {}) {
  const storedItems = {};
  const writtenItems = [];
  const previewRequests = [];
  const timers = [];
  const viewerImage = {
    tagName: "IMG",
    complete: initiallyReady,
    naturalWidth: initiallyReady ? 1280 : 0,
    naturalHeight: initiallyReady ? 1280 : 0,
    isConnected: true,
    async decode() {},
    getBoundingClientRect() {
      return { left: 220, top: 40, right: 860, bottom: 680, width: 640, height: 640 };
    },
    closest(selector) {
      return selector.includes('[aria-modal="true"]') ? {} : null;
    },
    querySelector() {
      return null;
    }
  };
  const sandbox = {
    XTweetRecall: shared,
    URL,
    Date,
    console,
    queueMicrotask,
    window: {
      location: { href: "https://x.com/example/status/123456789/photo/1" },
      innerWidth: 1280,
      innerHeight: 720,
      setInterval() {
        return 1;
      },
      setTimeout(callback) {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout() {}
    },
    document: {
      documentElement: {},
      querySelectorAll(selector) {
        return selector.includes("img[src]") ? [viewerImage] : [];
      }
    },
    MutationObserver: class MutationObserver {
      observe() {}
    },
    chrome: {
      runtime: {
        async sendMessage(message) {
          previewRequests.push(message);
          return { ok: true };
        }
      },
      storage: {
        local: {
          async get(key) {
            return Object.hasOwn(storedItems, key)
              ? { [key]: storedItems[key] }
              : {};
          },
          async set(items) {
            Object.assign(storedItems, items);
            writtenItems.push(items);
          }
        }
      }
    }
  };

  vm.runInNewContext(recorderScript, sandbox, { filename: "recorder.js" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(timers.length > 0);
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const previewRequestsBeforeReady = previewRequests.length;
  if (!initiallyReady) {
    viewerImage.complete = true;
    viewerImage.naturalWidth = 1280;
    viewerImage.naturalHeight = 1280;
    assert.ok(timers.length > 0);
    timers.shift()();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { writtenItems, previewRequests, previewRequestsBeforeReady };
}

async function runFeedScenario(action) {
  const writtenItems = [];
  const previewRequests = [];
  const listeners = new Map();
  const intervalCallbacks = new Map();
  const videoListeners = new Map();
  let now = 0;
  let articleTop = action === "dwell-below-visibility" ? 500 : 100;
  const time = {
    getAttribute(name) {
      return name === "datetime" ? "2026-08-16T08:00:00.000Z" : null;
    }
  };
  let article;
  const video = {
    tagName: "VIDEO",
    paused: true,
    ended: false,
    seeking: false,
    readyState: 4,
    currentTime: 0,
    duration: 2,
    videoWidth: 640,
    videoHeight: 360,
    isConnected: true,
    addEventListener(type, listener) {
      const typeListeners = videoListeners.get(type) || [];
      typeListeners.push(listener);
      videoListeners.set(type, typeListeners);
    },
    dispatch(type) {
      for (const listener of videoListeners.get(type) || []) {
        listener({ type, currentTarget: video });
      }
    },
    closest(selector) {
      return selector === 'article[data-testid="tweet"]' ? article : null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 };
    },
    matches(selector) {
      return selector === "video";
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const gridImage = {
    tagName: "IMG",
    complete: true,
    naturalWidth: 960,
    naturalHeight: 1080,
    isConnected: true,
    async decode() {},
    closest(selector) {
      if (selector.includes('a[href*="/status/"]')) {
        return gridLink;
      }
      if (selector.includes("img")) {
        return gridImage;
      }
      return null;
    },
    getBoundingClientRect() {
      return { left: 300, top: 140, right: 620, bottom: 500, width: 320, height: 360 };
    },
    querySelector() {
      return null;
    }
  };
  const gridLink = {
    href: "https://x.com/example/status/13579/photo/1",
    closest() {
      return null;
    },
    querySelector(selector) {
      return selector.includes("img") ? gridImage : null;
    }
  };
  const statusLink = {
    href: "https://x.com/example/status/24680",
    querySelector(selector) {
      return selector === "time" ? time : null;
    },
    closest() {
      return article;
    }
  };
  article = {
    isConnected: true,
    matches(selector) {
      return selector === 'article[data-testid="tweet"]';
    },
    getBoundingClientRect() {
      return {
        left: 200,
        top: articleTop,
        right: 840,
        bottom: articleTop + 520,
        width: 640,
        height: 520
      };
    },
    querySelectorAll(selector) {
      if (selector.includes('/status/')) {
        return [statusLink];
      }
      return selector === "video" && action !== "incomplete-dwell" ? [video] : [];
    },
    querySelector(selector) {
      if (selector === '[data-testid="tweetText"]') {
        if (action === "incomplete-dwell") {
          return null;
        }
        return { textContent: "Feed 里的正文", getAttribute: () => "zh" };
      }
      if (selector.includes('/status/24680') && selector.endsWith(" time")) {
        return time;
      }
      if (selector === "video, [data-testid=\"videoPlayer\"]") {
        return action === "incomplete-dwell" ? null : video;
      }
      return null;
    }
  };
  const target = {
    closest(selector) {
      return selector === 'article[data-testid="tweet"]' ? article : null;
    }
  };

  const sandbox = {
    XTweetRecall: shared,
    URL,
    Date,
    console,
    queueMicrotask,
    window: {
      location: {
        href: action.includes("media-gallery") || action === "media-grid-click"
          ? "https://x.com/example/media?filter=photo"
          : "https://x.com/home"
      },
      innerWidth: 1280,
      innerHeight: 720,
      setInterval(callback, delay) {
        intervalCallbacks.set(delay, callback);
        return 1;
      },
      setTimeout() {
        return 1;
      },
      clearTimeout() {}
    },
    document: {
      documentElement: { clientWidth: 1280, clientHeight: 720 },
      visibilityState: action === "dwell-hidden" ? "hidden" : "visible",
      hasFocus() {
        return [
          "dwell",
          "dwell-scrolling",
          "dwell-short",
          "dwell-below-visibility",
          "media-gallery-dwell",
          "incomplete-dwell"
        ].includes(action);
      },
      querySelectorAll(selector) {
        if (selector === "video") {
          return [video];
        }
        if (selector === 'article[data-testid="tweet"]') {
          return [article];
        }
        return [];
      },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      }
    },
    performance: {
      now() {
        return now;
      }
    },
    MutationObserver: class MutationObserver {
      observe() {}
    },
    IntersectionObserver: class IntersectionObserver {
      constructor(callback) {
        this.callback = callback;
      }
      observe(target) {
        this.callback([
          {
            target,
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRect: { height: 520 }
          }
        ]);
      }
      unobserve() {}
      disconnect() {}
    },
    chrome: {
      storage: {
        local: {
          async get() {
            return {};
          },
          async set(items) {
            writtenItems.push(items);
          }
        }
      },
      runtime: {
        async sendMessage(message) {
          previewRequests.push(message);
          return { ok: true };
        }
      }
    }
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(recorderScript, context, { filename: "recorder.js" });
  vm.runInContext(feedScript, context, { filename: "feed.js" });
  if (action === "click") {
    listeners.get("click")({ isTrusted: true, target });
  } else if (action === "media-grid-click") {
    listeners.get("click")({ isTrusted: true, target: gridImage });
  } else if (action === "dwell-resume") {
    now = 250;
    intervalCallbacks.get(250)();
    now = 5_000;
    listeners.get("visibilitychange")();
  } else if (
    [
      "dwell",
      "dwell-scrolling",
      "dwell-short",
      "dwell-below-visibility",
      "dwell-unfocused",
      "dwell-hidden",
      "media-gallery-dwell",
      "incomplete-dwell"
    ].includes(action)
  ) {
    const tickCount = action === "dwell-short"
      ? 10
      : [
          "dwell-below-visibility",
          "media-gallery-dwell",
          "incomplete-dwell"
        ].includes(action)
        ? 16
        : 11;
    for (let tick = 1; tick <= tickCount; tick += 1) {
      now = tick * 250;
      if (action === "dwell-scrolling") {
        articleTop = 100 - tick * 15;
        listeners.get("scroll")?.({ isTrusted: true });
      }
      intervalCallbacks.get(250)();
    }
  }
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  writtenItems.previewRequests = previewRequests;
  return writtenItems;
}

test("进入具体推文后，会在正文补全前先保存链接", async () => {
  const writes = await runContentScriptAt(
    "https://x.com/example/status/123456789?ref=home"
  );

  assert.equal(writes.length, 1);
  assert.equal(writes[0]["xRecall:tweet:123456789"].id, "123456789");
  assert.equal(
    writes[0]["xRecall:tweet:123456789"].url,
    "https://x.com/example/status/123456789"
  );
  assert.equal(writes[0]["xRecall:tweet:123456789"].visitCount, 1);
});

test("直接进入图片查看器时，会先把记录标记为图片", async () => {
  const writes = await runContentScriptAt(
    "https://x.com/example/status/123456789/photo/1"
  );

  assert.deepEqual(
    Array.from(writes[0]["xRecall:tweet:123456789"].media),
    ["图片"]
  );
});

test("图片查看器会用当前显示的大图补拍预览", async () => {
  const result = await runPhotoViewerScenario();

  assert.equal(result.previewRequests.length, 1);
  assert.equal(result.previewRequests[0].tweetId, "123456789");
  assert.equal(result.previewRequests[0].replaceExisting, true);
  assert.deepEqual({ ...result.previewRequests[0].crop }, {
    left: 220,
    top: 40,
    width: 640,
    height: 640
  });
});

test("图片未解码时不会截图，加载完成后才补拍", async () => {
  const result = await runPhotoViewerScenario({ initiallyReady: false });

  assert.equal(result.previewRequestsBeforeReady, 0);
  assert.equal(result.previewRequests.length, 1);
});

test("Feed 中没有可识别推文时不会生成记录", async () => {
  const writes = await runContentScriptAt("https://x.com/home");
  assert.equal(writes.length, 0);
});

test("在 Feed 中主动点击推文会保存正文和链接", async () => {
  const writes = await runFeedScenario("click");
  assert.equal(writes.length, 1);

  const record = writes[0]["xRecall:tweet:24680"];
  assert.equal(record.url, "https://x.com/example/status/24680");
  assert.equal(record.text, "Feed 里的正文");
  assert.equal(Array.from(record.media).join(","), "视频");
});

test("滚动中的媒体推文有效可见二点五秒后会保存", async () => {
  const writes = await runFeedScenario("dwell-scrolling");

  assert.equal(writes.length, 1);
  assert.equal(
    writes[0]["xRecall:tweet:24680"].url,
    "https://x.com/example/status/24680"
  );
});

test("推文有效可见不足二点五秒时不会提前保存", async () => {
  const writes = await runFeedScenario("dwell-short");
  assert.equal(writes.length, 0);
});

test("推文可见比例不足一半时不会累计停留时间", async () => {
  const writes = await runFeedScenario("dwell-below-visibility");
  assert.equal(writes.length, 0);
});

test("暂停不滚动时有效可见二点五秒后也会保存", async () => {
  const writes = await runFeedScenario("dwell");

  assert.equal(writes.length, 1);
  assert.equal(writes[0]["xRecall:tweet:24680"].text, "Feed 里的正文");
});

test("网页失去焦点后仍按视口位置累计时间", async () => {
  const writes = await runFeedScenario("dwell-unfocused");
  assert.equal(writes.length, 1);
});

test("页面可见状态变为隐藏也不会清空视口计时", async () => {
  const writes = await runFeedScenario("dwell-hidden");
  assert.equal(writes.length, 1);
});

test("后台计时器恢复时会立即按实际经过时间补记", async () => {
  const writes = await runFeedScenario("dwell-resume");
  assert.equal(writes.length, 1);
});

test("个人主页媒体网格停留不会被动保存", async () => {
  const writes = await runFeedScenario("media-gallery-dwell");
  assert.equal(writes.length, 0);
});

test("内容结构不完整的卡片停留不会生成空记录", async () => {
  const writes = await runFeedScenario("incomplete-dwell");
  assert.equal(writes.length, 0);
});

test("主动点击媒体网格缩略图会保存图片记录并请求截图", async () => {
  const writes = await runFeedScenario("media-grid-click");
  assert.equal(writes.length, 1);

  const record = writes[0]["xRecall:tweet:13579"];
  assert.equal(record.url, "https://x.com/example/status/13579");
  assert.deepEqual(Array.from(record.media), ["图片"]);
  assert.equal(writes.previewRequests.length, 1);
  assert.equal(writes.previewRequests[0].tweetId, "13579");
});

test("记录过程不会向 X 页面插入提示界面", () => {
  assert.doesNotMatch(contentScripts, /showToast|createElement\(|save-toast/);
});

test("再次进入同一条推文时保留首次时间并更新最近时间", async () => {
  const key = "xRecall:tweet:123456789";
  const existing = {
    schemaVersion: 1,
    id: "123456789",
    url: "https://x.com/example/status/123456789",
    handle: "example",
    author: "Example",
    text: "原有正文",
    media: [],
    tweetedAt: "",
    firstVisitedAt: "2026-07-01T08:00:00.000Z",
    lastVisitedAt: "2026-07-02T09:30:00.000Z",
    visitCount: 2
  };
  const writes = await runContentScriptAt(
    "https://x.com/example/status/123456789",
    { [key]: existing }
  );
  const updated = writes[0][key];

  assert.equal(updated.firstVisitedAt, existing.firstVisitedAt);
  assert.notEqual(updated.lastVisitedAt, existing.lastVisitedAt);
  assert.equal(updated.visitCount, 3);
  assert.equal(updated.text, existing.text);
});
