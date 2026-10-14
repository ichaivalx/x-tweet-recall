"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("../scripts/shared.js");

test("识别普通 X 推文地址并去掉附加路径和参数", () => {
  assert.deepEqual(
    shared.parseTweetRoute(
      "https://x.com/example_user/status/123456789/photo/1?s=20"
    ),
    {
      id: "123456789",
      handle: "example_user",
      canonicalUrl: "https://x.com/example_user/status/123456789"
    }
  );
});

test("兼容 twitter.com 旧域名", () => {
  assert.deepEqual(
    shared.parseTweetRoute("https://twitter.com/old_name/status/987654321"),
    {
      id: "987654321",
      handle: "old_name",
      canonicalUrl: "https://x.com/old_name/status/987654321"
    }
  );
});

test("兼容不含用户名的 i/web/status 地址", () => {
  assert.deepEqual(
    shared.parseTweetRoute("https://x.com/i/web/status/1122334455"),
    {
      id: "1122334455",
      handle: "",
      canonicalUrl: "https://x.com/i/web/status/1122334455"
    }
  );
});

test("忽略 Feed、伪造域名和非数字状态 ID", () => {
  assert.equal(shared.parseTweetRoute("https://x.com/home"), null);
  assert.equal(shared.parseTweetRoute("https://notx.com/user/status/123"), null);
  assert.equal(shared.parseTweetRoute("https://x.com/user/status/not-a-number"), null);
});

test("生成彼此独立的存储键", () => {
  assert.equal(shared.makeStorageKey("123"), "xRecall:tweet:123");
});

test("连续可见时间按浏览器经过时间累计", () => {
  let clock = { elapsedAttentionMs: 0, lastTickAt: 0 };

  for (let tick = 1; tick <= 10; tick += 1) {
    clock = shared.advanceAttentionClock(clock, tick * 250);
  }

  assert.equal(clock.elapsedAttentionMs, 2_500);
});

test("后台计时器延迟后按实际经过时间补算", () => {
  const clock = shared.advanceAttentionClock(
    { elapsedAttentionMs: 2_000, lastTickAt: 1_000 },
    4_000
  );

  assert.deepEqual(clock, {
    elapsedAttentionMs: 5_000,
    lastTickAt: 4_000
  });
});

test("单个数字会同时模糊匹配小时和分钟", () => {
  const atFourteen = new Date(2026, 7, 25, 14, 7, 0);
  const minuteFourteen = new Date(2026, 7, 25, 9, 14, 0);

  assert.equal(shared.matchesLooseLocalTimeQuery("14", [atFourteen]), true);
  assert.equal(shared.matchesLooseLocalTimeQuery("14", [minuteFourteen]), true);
  assert.equal(shared.matchesLooseLocalTimeQuery("38", [atFourteen]), false);
  assert.equal(shared.isLooseTimeQuery("14"), true);
  assert.equal(shared.isLooseTimeQuery("iPhone 14"), false);
  assert.equal(shared.isLooseTimeQuery("1234567890123456789"), false);
});

test("宽松时间搜索兼容常见分隔符、紧凑写法和重复输入", () => {
  const value = new Date(2026, 7, 25, 12, 15, 0);

  for (const query of [
    "12:15",
    "12 15",
    "12、15",
    "1215",
    "12点15分",
    "12、12、15"
  ]) {
    assert.equal(
      shared.matchesLooseLocalTimeQuery(query, [value]),
      true,
      query
    );
  }
});

test("宽松时间搜索理解今天和十二小时制时段", () => {
  const now = new Date(2026, 7, 25, 18, 0, 0);
  const todayAfternoon = new Date(2026, 7, 25, 14, 15, 0);
  const yesterdayAfternoon = new Date(2026, 7, 24, 14, 15, 0);

  assert.equal(
    shared.matchesLooseLocalTimeQuery(
      "今天 下午2点15分",
      [todayAfternoon],
      now
    ),
    true
  );
  assert.equal(
    shared.matchesLooseLocalTimeQuery(
      "今天 下午2点15分",
      [yesterdayAfternoon],
      now
    ),
    false
  );
});

test("记录时间优先使用最近记录时间，缺失时退回首次时间", () => {
  assert.equal(
    shared.getRecordTime({
      firstVisitedAt: "2026-01-01T00:00:00.000Z",
      lastVisitedAt: "2026-02-01T00:00:00.000Z"
    }),
    Date.parse("2026-02-01T00:00:00.000Z")
  );
  assert.equal(
    shared.getRecordTime({ firstVisitedAt: "2026-01-01T00:00:00.000Z" }),
    Date.parse("2026-01-01T00:00:00.000Z")
  );
  assert.ok(Number.isNaN(shared.getRecordTime({})));
});

test("只把被移除的推文记录识别为删除", () => {
  assert.deepEqual(
    shared.removedTweetIds({
      "xRecall:tweet:1": { oldValue: {} },
      "xRecall:tweet:2": { oldValue: {}, newValue: {} },
      "xRecall:setting:showPreviews": { oldValue: true }
    }),
    ["1"]
  );
});
