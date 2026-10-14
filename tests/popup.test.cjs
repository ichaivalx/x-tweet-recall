"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const popupScript = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "popup.js"),
  "utf8"
);
const popupHtml = fs.readFileSync(
  path.join(__dirname, "..", "popup.html"),
  "utf8"
);

test("删除请求只能从确认步骤发出", () => {
  const submitStart = popupScript.indexOf("async function submitCleanup");
  const submitEnd = popupScript.indexOf("function cleanupCutoff", submitStart);
  const submitFunction = popupScript.slice(submitStart, submitEnd);
  const outsideSubmit =
    popupScript.slice(0, submitStart) + popupScript.slice(submitEnd);

  assert.ok(submitStart >= 0);
  assert.match(submitFunction, /cleanupSelection/);
  assert.match(submitFunction, /xRecall:deleteRecordsBefore/);
  assert.match(submitFunction, /xRecall:clearAllData/);
  assert.doesNotMatch(outsideSubmit, /xRecall:deleteRecordsBefore|xRecall:clearAllData/);
});

test("搜索栏带数字键盘，工具栏提供预览开关和删除入口，搜索栏不预填内容", () => {
  assert.match(popupHtml, /id="keypad"/);
  assert.match(popupHtml, /id="toggle-previews"/);
  assert.match(popupHtml, /id="open-cleanup"/);
  assert.doesNotMatch(popupHtml, /placeholder=/);
});
