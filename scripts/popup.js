(function initializePopup() {
  "use strict";

  const shared = globalThis.XTweetRecall;
  const previewDatabase = globalThis.XRecallPreviewDB;
  const PREVIEW_SETTING_KEY = "xRecall:setting:showPreviews";
  const FIRST_PAGE_SIZE = 30;
  const FILL_PAGE_SIZE = 60;
  const CHANGE_RENDER_DELAY_MS = 250;
  const CLEANUP_RANGES = [
    { id: "7d", label: "7 天前的记录", cutoff: (now) => shiftDays(now, -7) },
    { id: "1m", label: "1 个月前的记录", cutoff: (now) => shiftMonths(now, -1) },
    { id: "2m", label: "2 个月前的记录", cutoff: (now) => shiftMonths(now, -2) },
    { id: "6m", label: "半年前的记录", cutoff: (now) => shiftMonths(now, -6) },
    { id: "all", label: "全部记录", cutoff: null }
  ];
  const icons = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="1.5"></rect><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-10A1.5 1.5 0 0 0 3 5.5v10A1.5 1.5 0 0 0 4.5 17H8"></path></svg>',
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8"></path><path d="M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>',
    copied: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7"></path></svg>',
    failed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg>'
  };
  const clockFormat = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const exactFormat = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const elements = {
    shell: document.getElementById("shell"),
    search: document.getElementById("search"),
    keypad: document.getElementById("keypad"),
    previewButton: document.getElementById("toggle-previews"),
    cleanupButton: document.getElementById("open-cleanup"),
    records: document.getElementById("records"),
    recordsEnd: document.getElementById("records-end"),
    empty: document.getElementById("empty"),
    emptyCopy: document.getElementById("empty-copy"),
    cleanup: document.getElementById("cleanup"),
    cleanupSummary: document.getElementById("cleanup-summary"),
    cleanupOptions: document.getElementById("cleanup-options"),
    cleanupConfirm: document.getElementById("cleanup-confirm"),
    cleanupMessage: document.getElementById("cleanup-message"),
    cleanupCancel: document.getElementById("cleanup-cancel"),
    cleanupSubmit: document.getElementById("cleanup-submit")
  };

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const recordsById = new Map();
  const recordViews = new Map();
  const previewTargets = new Map();
  const previewUrls = new Map();
  const searchTextCache = new WeakMap();
  const copyResetTimers = new WeakMap();
  let records = [];
  let recordsLoaded = false;
  let loadError = "";
  let pendingChanges = [];
  let changeRenderTimer = 0;
  let visibleRecords = [];
  let visibleRecordsStale = true;
  let renderedQuery = "";
  let renderLimit = FIRST_PAGE_SIZE;
  let fillHandle = 0;
  let previewsVisible = true;
  let previewObserver = null;
  let pageObserver = null;
  let cleanupSelection = null;
  let cleanupBusy = false;

  if (!shared || !previewDatabase) {
    elements.empty.hidden = false;
    elements.emptyCopy.textContent = "扩展加载失败";
    return;
  }

  elements.search.addEventListener("input", render);
  elements.search.addEventListener("click", () => setKeypadOpen(true));
  elements.keypad.addEventListener("mousedown", (event) => event.preventDefault());
  elements.keypad.addEventListener("click", handleKeypadClick);
  elements.records.addEventListener("wheel", (event) => {
    if (!isKeypadOpen()) {
      return;
    }
    // 向上滚动时这一格只用来收起键盘，否则列表上移与内容下滚同时发生会来回抖动。
    const holdContent = event.deltaY < 0 && elements.records.scrollTop > 0;
    if (holdContent) {
      event.preventDefault();
    }
    setKeypadOpen(false, { holdContent });
  }, {
    passive: false
  });
  elements.records.addEventListener("pointerdown", (event) => {
    // 直接按住列表本身只可能是拖动滚动条。
    if (event.target === elements.records) {
      setKeypadOpen(false);
    }
  });
  elements.previewButton.addEventListener("click", () => {
    void togglePreviews();
  });
  elements.cleanupButton.addEventListener("click", () => {
    if (elements.cleanup.hidden) {
      openCleanup();
    } else {
      closeCleanup();
    }
  });
  elements.cleanupOptions.addEventListener("click", (event) => {
    const option = event.target.closest("[data-range]");
    if (option && !option.disabled) {
      selectCleanupRange(option.dataset.range);
    }
  });
  elements.cleanupCancel.addEventListener("click", showCleanupOptions);
  elements.cleanupSubmit.addEventListener("click", () => {
    void submitCleanup();
  });
  document.addEventListener("pointerdown", (event) => {
    if (
      !elements.cleanup.hidden &&
      !elements.cleanup.contains(event.target) &&
      !elements.cleanupButton.contains(event.target)
    ) {
      closeCleanup();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (!elements.cleanup.hidden) {
      event.preventDefault();
      closeCleanup();
      elements.cleanupButton.focus();
    } else if (isKeypadOpen()) {
      event.preventDefault();
      setKeypadOpen(false);
    }
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") {
      return;
    }
    if (Object.hasOwn(changes, PREVIEW_SETTING_KEY)) {
      previewsVisible = changes[PREVIEW_SETTING_KEY].newValue !== false;
      updatePreviewMode();
    }
    if (Object.keys(changes).some((key) => key.startsWith(shared.STORAGE_PREFIX))) {
      queueRecordChanges(changes);
    }
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "xRecall:previewStored") {
      handlePreviewStored(String(message.tweetId || ""));
    }
  });
  window.addEventListener("beforeunload", releasePreviewUrls);

  createPageObserver();
  void initialize();

  async function initialize() {
    try {
      const stored = await chrome.storage.local.get(null);
      previewsVisible = stored[PREVIEW_SETTING_KEY] !== false;
      for (const [key, value] of Object.entries(stored)) {
        if (key.startsWith(shared.STORAGE_PREFIX) && shared.isTweetRecord(value)) {
          recordsById.set(String(value.id), value);
        }
      }
      recordsLoaded = true;
      pendingChanges.forEach(applyRecordChanges);
      pendingChanges = [];
      records = sortRecords(recordsById.values());
    } catch (error) {
      console.warn("[XRecall] 读取记录失败", error);
      loadError = "读取记录失败";
    }
    updatePreviewMode();
    render();
  }

  // ---- 记录数据 ----

  function queueRecordChanges(changes) {
    if (!recordsLoaded) {
      pendingChanges.push(changes);
      return;
    }

    applyRecordChanges(changes);
    records = sortRecords(recordsById.values());
    visibleRecordsStale = true;
    window.clearTimeout(changeRenderTimer);
    changeRenderTimer = window.setTimeout(() => {
      render();
      if (!elements.cleanup.hidden && !cleanupSelection) {
        updateCleanupOptions();
      }
    }, CHANGE_RENDER_DELAY_MS);
  }

  function applyRecordChanges(changes) {
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(shared.STORAGE_PREFIX)) {
        continue;
      }

      const id = key.slice(shared.STORAGE_PREFIX.length);
      if (shared.isTweetRecord(change.newValue)) {
        recordsById.set(id, change.newValue);
      } else {
        recordsById.delete(id);
        forgetRecordView(id);
      }
    }
  }

  function sortRecords(values) {
    const sortTime = (record) => shared.getRecordTime(record) || 0;
    return Array.from(values).sort((left, right) => sortTime(right) - sortTime(left));
  }

  function filterRecords(rawQuery) {
    if (!rawQuery) {
      return records;
    }

    const query = rawQuery.toLocaleLowerCase("zh-CN");
    if (shared.isLooseTimeQuery(query)) {
      return records.filter((record) =>
        shared.matchesLooseLocalTimeQuery(rawQuery, [
          record.lastVisitedAt || record.firstVisitedAt
        ])
      );
    }
    return records.filter((record) => searchableText(record).includes(query));
  }

  function searchableText(record) {
    let text = searchTextCache.get(record);
    if (text === undefined) {
      text = [record.author, record.handle, displayText(record), record.id]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("zh-CN");
      searchTextCache.set(record, text);
    }
    return text;
  }

  // ---- 列表渲染 ----
  // 先渲染第一页，其余记录在空闲时分批补齐；滚动快于补齐速度时由底部哨兵立即追加。

  function render() {
    const rawQuery = elements.search.value.trim();
    const queryChanged = rawQuery !== renderedQuery;
    if (queryChanged) {
      renderedQuery = rawQuery;
      renderLimit = FIRST_PAGE_SIZE;
      visibleRecordsStale = true;
    }
    if (visibleRecordsStale) {
      visibleRecords = filterRecords(rawQuery);
      visibleRecordsStale = false;
    }

    elements.cleanupButton.disabled = records.length === 0;
    if (!visibleRecords.length) {
      syncRecordList([]);
      elements.records.hidden = true;
      elements.empty.hidden = !recordsLoaded && !loadError;
      elements.emptyCopy.textContent =
        loadError || (rawQuery ? "没有匹配的推文" : "还没有保存的推文");
      scheduleFill();
      return;
    }

    elements.empty.hidden = true;
    elements.records.hidden = false;
    syncRecordList(visibleRecords.slice(0, renderLimit));
    if (queryChanged) {
      elements.records.scrollTop = 0;
    }
    refreshPageObserver();
    scheduleFill();
  }

  function hasMoreRecords() {
    return visibleRecords.length > renderLimit;
  }

  function growRenderLimit(size) {
    if (hasMoreRecords()) {
      renderLimit += size;
      render();
    }
  }

  function scheduleFill() {
    cancelIdleCallback(fillHandle);
    fillHandle = hasMoreRecords()
      ? requestIdleCallback(() => growRenderLimit(FILL_PAGE_SIZE), { timeout: 300 })
      : 0;
  }

  function createPageObserver() {
    pageObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          growRenderLimit(FIRST_PAGE_SIZE);
        }
      },
      { root: elements.records, rootMargin: "0px 0px 1200px 0px" }
    );
  }

  function refreshPageObserver() {
    // 重新观察会立即回报当前相交状态，追加后仍在预加载范围内时会继续补下一页。
    pageObserver.unobserve(elements.recordsEnd);
    if (hasMoreRecords()) {
      pageObserver.observe(elements.recordsEnd);
    }
  }

  function syncRecordList(nextRecords) {
    const container = elements.records;
    let cursor = container.firstElementChild;

    for (const record of nextRecords) {
      const article = recordView(record);
      if (cursor && !cursor.isConnected) {
        // 记录内容更新时，新卡片已原位替换旧卡片。
        cursor = article;
      }
      if (article === cursor) {
        cursor = cursor.nextElementSibling;
      } else {
        container.insertBefore(article, cursor);
      }
    }

    while (cursor && cursor !== elements.recordsEnd) {
      const next = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
  }

  function recordView(record) {
    const id = String(record.id);
    const existing = recordViews.get(id);
    if (existing?.record === record) {
      return existing.article;
    }

    const article = createRecordElement(record);
    if (existing) {
      detachPreviewTarget(existing.article);
      existing.article.replaceWith(article);
    }
    recordViews.set(id, { record, article });
    return article;
  }

  function forgetRecordView(id) {
    const existing = recordViews.get(id);
    if (existing) {
      detachPreviewTarget(existing.article);
      existing.article.remove();
      recordViews.delete(id);
    }

    const objectUrl = previewUrls.get(id);
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      previewUrls.delete(id);
    }
  }

  function createRecordElement(record) {
    const article = createElement("article", "record");
    const content = createElement("div", "record__content");
    const identity = createElement("div", "record__identity");

    const authorName = String(record.author || "").trim();
    const handleName = String(record.handle || "").trim();
    const authorLabel = authorName || (handleName ? `@${handleName}` : "未知作者");
    identity.appendChild(createElement("span", "record__author", authorLabel));
    if (authorName && handleName) {
      identity.appendChild(createElement("span", "record__handle", `@${handleName}`));
    }

    const visitTimestamp = record.lastVisitedAt || record.firstVisitedAt || "";
    if (isValidDate(visitTimestamp)) {
      const visitTime = createElement(
        "time",
        "record__time",
        formatCompactLocalTime(visitTimestamp)
      );
      const title = buildVisitTimeTitle(record);
      visitTime.dateTime = visitTimestamp;
      visitTime.title = title;
      visitTime.setAttribute("aria-label", title);
      identity.appendChild(visitTime);
    }

    content.append(
      identity,
      createElement("p", "record__text", displayText(record))
    );

    const preview = createTweetLink(record.url, "record__preview", "打开原推文", "打开带预览的原推文");
    preview.hidden = true;
    preview.dataset.state = "idle";
    const previewImage = document.createElement("img");
    previewImage.alt = `${authorLabel} 的推文预览`;
    previewImage.decoding = "async";
    preview.appendChild(previewImage);
    content.appendChild(preview);

    const openButton = createTweetLink(
      record.url,
      "record__action",
      "在新标签页打开",
      "在新标签页打开原推文"
    );
    openButton.innerHTML = icons.open;

    const copyButton = createElement("button", "record__action record__copy");
    copyButton.type = "button";
    copyButton.addEventListener("click", () => {
      void copyRecordLink(copyButton, record.url);
    });
    setCopyButtonState(copyButton, "idle");

    const actions = createElement("div", "record__actions");
    actions.append(openButton, copyButton);
    article.append(content, actions);
    registerPreviewTarget({
      article,
      preview,
      image: previewImage,
      tweetId: String(record.id)
    });
    return article;
  }

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    element.className = className;
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  function createTweetLink(url, className, title, label) {
    const link = createElement("a", className);
    link.href = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.title = title;
    link.setAttribute("aria-label", label);
    return link;
  }

  function displayText(record) {
    const text = String(record.text || "").trim();
    if (text) {
      return text;
    }

    const media = Array.isArray(record.media)
      ? record.media.map((value) => String(value).trim()).filter(Boolean)
      : [];
    return media.length ? media.join("、") : "内容尚未加载";
  }

  // ---- 预览图 ----

  function registerPreviewTarget(entry) {
    previewTargets.set(entry.article, entry);
    const existingUrl = previewUrls.get(entry.tweetId);
    if (existingUrl) {
      displayPreview(entry, existingUrl);
    } else if (previewObserver) {
      previewObserver.observe(entry.article);
    }
  }

  function detachPreviewTarget(article) {
    previewObserver?.unobserve(article);
    previewTargets.delete(article);
  }

  function updatePreviewMode() {
    elements.records.classList.toggle("records--previews-hidden", !previewsVisible);
    elements.previewButton.setAttribute("aria-pressed", String(previewsVisible));
    elements.previewButton.title = previewsVisible ? "隐藏预览" : "显示预览";
    elements.previewButton.setAttribute(
      "aria-label",
      previewsVisible ? "隐藏所有图片预览" : "显示所有图片预览"
    );

    previewObserver?.disconnect();
    previewObserver = null;
    if (!previewsVisible) {
      return;
    }

    previewObserver = new IntersectionObserver(
      (entries) => {
        for (const observed of entries) {
          const entry = observed.isIntersecting && previewTargets.get(observed.target);
          if (entry) {
            previewObserver.unobserve(observed.target);
            void loadPreview(entry);
          }
        }
      },
      { root: elements.records, rootMargin: "260px 0px" }
    );
    for (const entry of previewTargets.values()) {
      if (entry.preview.dataset.state === "idle") {
        previewObserver.observe(entry.article);
      }
    }
  }

  async function togglePreviews() {
    previewsVisible = !previewsVisible;
    updatePreviewMode();
    try {
      await chrome.storage.local.set({ [PREVIEW_SETTING_KEY]: previewsVisible });
    } catch (error) {
      console.warn("[XRecall] 保存预览偏好失败", error);
    }
  }

  async function loadPreview(entry) {
    if (entry.preview.dataset.state === "loading") {
      return;
    }

    entry.preview.dataset.state = "loading";
    try {
      let objectUrl = previewUrls.get(entry.tweetId);
      if (!objectUrl) {
        const storedPreview = await previewDatabase.getPreview(entry.tweetId);
        if (!storedPreview?.blob) {
          entry.preview.dataset.state = "empty";
          return;
        }
        objectUrl = previewUrls.get(entry.tweetId) || URL.createObjectURL(storedPreview.blob);
        previewUrls.set(entry.tweetId, objectUrl);
      }
      displayPreview(entry, objectUrl);
    } catch (error) {
      console.warn("[XRecall] 读取预览失败", error);
      entry.preview.dataset.state = "failed";
    }
  }

  function displayPreview(entry, objectUrl) {
    entry.preview.dataset.state = "ready";
    entry.image.onload = () => {
      entry.preview.hidden = false;
    };
    entry.image.onerror = () => {
      entry.preview.dataset.state = "failed";
      entry.preview.hidden = true;
    };
    entry.image.src = objectUrl;
    if (entry.image.complete) {
      entry.preview.hidden = false;
    }
  }

  function handlePreviewStored(tweetId) {
    const oldUrl = previewUrls.get(tweetId);
    if (oldUrl) {
      URL.revokeObjectURL(oldUrl);
      previewUrls.delete(tweetId);
    }

    const view = recordViews.get(tweetId);
    const entry = view && previewTargets.get(view.article);
    if (entry) {
      entry.preview.dataset.state = "idle";
      if (previewsVisible) {
        void loadPreview(entry);
      }
    }
  }

  function releasePreviewUrls() {
    for (const objectUrl of previewUrls.values()) {
      URL.revokeObjectURL(objectUrl);
    }
    previewUrls.clear();
  }

  // ---- 数字键盘 ----

  function isKeypadOpen() {
    return elements.keypad.dataset.open === "true";
  }

  function setKeypadOpen(open, { holdContent = false } = {}) {
    if (isKeypadOpen() === open) {
      return;
    }

    const list = elements.records.hidden ? elements.empty : elements.records;
    const startOffset = currentTranslateY(list);
    const startScrollTop = list.scrollTop;
    elements.keypad.dataset.open = String(open);
    elements.keypad.inert = !open;
    elements.shell.classList.toggle("shell--keypad-open", open);

    // 布局一次性移动到位，再从原视觉位置滑过去，动画只改 transform 和裁剪。
    const shift = elements.keypad.offsetHeight * (open ? -1 : 1);
    // 收起时可用滚动位置抵消列表上移：内容停在原处，只有列表上缘向上展开。
    const held = holdContent && !open ? Math.min(shift, startScrollTop) : 0;
    if (held > 0) {
      list.scrollTop = startScrollTop - held;
    }
    for (const animation of list.getAnimations()) {
      animation.cancel();
    }
    if (!reducedMotion.matches) {
      list.animate(
        [
          { transform: `translateY(${startOffset + shift - held}px)`, clipPath: `inset(${held}px 0 0)` },
          { transform: "none", clipPath: "inset(0)" }
        ],
        { duration: 260, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
      );
    }
  }

  function currentTranslateY(element) {
    const transform = getComputedStyle(element).transform;
    return transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m42 : 0;
  }

  function handleKeypadClick(event) {
    const key = event.target.closest("button");
    if (!key) {
      return;
    }

    const input = elements.search;
    if (document.activeElement !== input) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }

    const end = input.selectionEnd ?? input.value.length;
    const start = input.selectionStart ?? end;
    if (key.dataset.insert) {
      input.setRangeText(key.dataset.insert, start, end, "end");
    } else if (start !== end) {
      input.setRangeText("", start, end, "end");
    } else if (start > 0) {
      input.setRangeText("", start - 1, start, "end");
    } else {
      return;
    }
    render();
  }

  // ---- 删除记录 ----

  function openCleanup() {
    elements.cleanup.hidden = false;
    elements.cleanupButton.setAttribute("aria-expanded", "true");
    elements.cleanupSummary.textContent = `共 ${records.length} 条记录`;
    showCleanupOptions();
    void loadCleanupSummary();
  }

  function closeCleanup() {
    if (cleanupBusy) {
      return;
    }
    elements.cleanup.hidden = true;
    elements.cleanupButton.setAttribute("aria-expanded", "false");
    cleanupSelection = null;
  }

  async function loadCleanupSummary() {
    try {
      const stats = await chrome.runtime.sendMessage({ type: "xRecall:getStorageStats" });
      const previewCount = Number(stats?.count) || 0;
      if (stats?.ok && previewCount && !elements.cleanup.hidden) {
        elements.cleanupSummary.textContent =
          `共 ${records.length} 条记录，${previewCount} 张预览占用 ${formatBytes(Number(stats.bytes) || 0)}`;
      }
    } catch (error) {
      console.warn("[XRecall] 读取占用空间失败", error);
    }
  }

  function showCleanupOptions() {
    cleanupSelection = null;
    elements.cleanupConfirm.hidden = true;
    elements.cleanupOptions.hidden = false;
    updateCleanupOptions();
    elements.cleanupOptions.querySelector("button:not(:disabled)")?.focus();
  }

  function updateCleanupOptions() {
    const now = new Date();
    elements.cleanupOptions.replaceChildren(
      ...CLEANUP_RANGES.map((range) => {
        const count = countRecordsBefore(cleanupCutoff(range, now));
        const option = createElement(
          "button",
          range.cutoff ? "cleanup__option" : "cleanup__option cleanup__option--all"
        );
        option.type = "button";
        option.dataset.range = range.id;
        option.disabled = count === 0;
        option.append(
          createElement("span", "", range.label),
          createElement("span", "cleanup__count", `${count} 条`)
        );
        return option;
      })
    );
  }

  function selectCleanupRange(rangeId) {
    const range = CLEANUP_RANGES.find((candidate) => candidate.id === rangeId);
    const cutoff = range && cleanupCutoff(range, new Date());
    const count = range ? countRecordsBefore(cutoff) : 0;
    if (!count) {
      return;
    }

    cleanupSelection = { range, cutoff };
    elements.cleanupOptions.hidden = true;
    elements.cleanupConfirm.hidden = false;
    showCleanupMessage(
      range.cutoff
        ? `删除最近一次记录早于 ${formatCutoffDate(cutoff)} 的 ${count} 条推文和对应预览？删除后无法恢复。`
        : `删除全部 ${count} 条推文和所有预览？删除后无法恢复。`
    );
    setCleanupButtons(`删除 ${count} 条`, false);
    elements.cleanupCancel.focus();
  }

  async function submitCleanup() {
    if (!cleanupSelection || cleanupBusy) {
      return;
    }

    const { range, cutoff } = cleanupSelection;
    cleanupBusy = true;
    setCleanupButtons("正在删除…", true);
    try {
      const result = await chrome.runtime.sendMessage(
        range.cutoff
          ? { type: "xRecall:deleteRecordsBefore", before: cutoff }
          : { type: "xRecall:clearAllData" }
      );
      if (!result?.ok) {
        throw new Error("后台未能完成删除");
      }
      cleanupBusy = false;
      closeCleanup();
    } catch (error) {
      console.warn("[XRecall] 删除记录失败", error);
      cleanupBusy = false;
      showCleanupMessage("删除失败，记录没有变化。请重试。", true);
      setCleanupButtons("重试", false);
    }
  }

  function showCleanupMessage(text, failed = false) {
    elements.cleanupMessage.textContent = text;
    elements.cleanupMessage.classList.toggle("cleanup__message--failed", failed);
  }

  function setCleanupButtons(submitLabel, disabled) {
    elements.cleanupSubmit.textContent = submitLabel;
    elements.cleanupSubmit.disabled = disabled;
    elements.cleanupCancel.disabled = disabled;
  }

  function cleanupCutoff(range, now) {
    return range.cutoff ? range.cutoff(now).getTime() : Number.POSITIVE_INFINITY;
  }

  function countRecordsBefore(cutoff) {
    return records.reduce(
      (count, record) => count + (shared.getRecordTime(record) < cutoff ? 1 : 0),
      0
    );
  }

  function shiftDays(date, days) {
    const result = new Date(date.getTime());
    result.setDate(result.getDate() + days);
    return result;
  }

  function shiftMonths(date, months) {
    const result = new Date(date.getTime());
    const day = result.getDate();
    result.setDate(1);
    result.setMonth(result.getMonth() + months);
    const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(day, lastDay));
    return result;
  }

  // ---- 复制链接 ----

  async function copyRecordLink(button, url) {
    window.clearTimeout(copyResetTimers.get(button));
    try {
      await navigator.clipboard.writeText(url);
      setCopyButtonState(button, "copied");
    } catch (error) {
      console.warn("[XRecall] 复制链接失败", error);
      setCopyButtonState(button, "failed");
    }
    copyResetTimers.set(
      button,
      window.setTimeout(() => setCopyButtonState(button, "idle"), 1_100)
    );
  }

  function setCopyButtonState(button, state) {
    const [icon, title, label] = {
      idle: [icons.copy, "复制链接", "复制推文链接"],
      copied: [icons.copied, "已复制", "推文链接已复制"],
      failed: [icons.failed, "复制失败", "复制推文链接失败"]
    }[state];
    button.classList.toggle("record__copy--copied", state === "copied");
    button.classList.toggle("record__copy--failed", state === "failed");
    button.innerHTML = icon;
    button.title = title;
    button.setAttribute("aria-label", label);
  }

  // ---- 时间与数字格式 ----

  function isValidDate(value) {
    return Number.isFinite(Date.parse(value || ""));
  }

  function formatCompactLocalTime(value) {
    const date = new Date(value);
    const now = new Date();
    const yesterday = shiftDays(now, -1);
    const clock = clockFormat.format(date);

    if (isSameLocalDate(date, now)) {
      return `今天 ${clock}`;
    }
    if (isSameLocalDate(date, yesterday)) {
      return `昨天 ${clock}`;
    }
    if (date.getFullYear() === now.getFullYear()) {
      return `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
    }
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
  }

  function isSameLocalDate(left, right) {
    return (
      left.getFullYear() === right.getFullYear() &&
      left.getMonth() === right.getMonth() &&
      left.getDate() === right.getDate()
    );
  }

  function formatCutoffDate(time) {
    const date = new Date(time);
    return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${clockFormat.format(date)}`;
  }

  function buildVisitTimeTitle(record) {
    const latest = record.lastVisitedAt || record.firstVisitedAt;
    const parts = [`最近记录：${exactFormat.format(new Date(latest))}`];
    if (isValidDate(record.firstVisitedAt) && record.firstVisitedAt !== latest) {
      parts.push(`首次记录：${exactFormat.format(new Date(record.firstVisitedAt))}`);
    }
    if (Number(record.visitCount) > 1) {
      parts.push(`共记录 ${record.visitCount} 次`);
    }
    return parts.join("；");
  }

  function formatBytes(bytes) {
    if (bytes < 1_024) {
      return `${bytes} B`;
    }
    if (bytes < 1_048_576) {
      return `${(bytes / 1_024).toFixed(1)} KB`;
    }
    if (bytes < 1_073_741_824) {
      return `${(bytes / 1_048_576).toFixed(1)} MB`;
    }
    return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  }
})();
