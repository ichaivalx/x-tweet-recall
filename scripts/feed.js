(function initializeFeedObservation() {
  "use strict";

  const shared = globalThis.XTweetRecall;
  const recorder = globalThis.XRecallRecorder;
  if (!shared || !recorder) {
    return;
  }

  const SAMPLE_INTERVAL_MS = 250;
  const VISIBLE_DWELL_THRESHOLD_MS = 2_500;
  const MIN_ARTICLE_VISIBLE_RATIO = 0.5;
  const MIN_VIEWPORT_COVERAGE_RATIO = 0.5;
  const MEDIA_GESTURE_GRACE_MS = 1_500;

  const observedVideos = new WeakSet();
  const activeMediaPointers = new Map();
  const recentMediaGestures = new WeakMap();
  const observedArticles = new WeakSet();
  const visibleArticles = new Map();
  const visibleDwellClocks = new Map();
  const dwellRecordedTweetIds = new Set();

  function closestTweetArticle(target) {
    return typeof target?.closest === "function"
      ? target.closest('article[data-testid="tweet"]')
      : null;
  }

  function handleArticleInteraction(event) {
    if (event.isTrusted) {
      void recorder.recordTarget(event.target);
    }
  }

  function handleArticleKeydown(event) {
    if (
      !event.isTrusted ||
      ![
        "Enter",
        " ",
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "k",
        "K",
        "m",
        "M"
      ].includes(event.key)
    ) {
      return;
    }

    const actionable = event.target?.closest?.(
      'a[href], button, input, video, [role="button"], [role="link"], [role="slider"], [role="radio"], [role="checkbox"], [contenteditable="true"]'
    );
    if (actionable) {
      void recorder.recordTarget(actionable);
    }
  }

  function handleTweetCopy(event) {
    if (!event.isTrusted || typeof document.getSelection !== "function") {
      return;
    }

    const selection = document.getSelection();
    const anchorNode = selection?.anchorNode;
    const anchorElement =
      anchorNode?.nodeType === 1 ? anchorNode : anchorNode?.parentElement;
    void recorder.recordArticle(closestTweetArticle(anchorElement));
  }

  function findVideoFromPointerEvent(event) {
    const target = event.target;
    if (typeof target?.closest !== "function") {
      return null;
    }

    const player = target.closest(
      'video, [data-testid="videoPlayer"], [data-testid="videoComponent"], [role="slider"], input[type="range"]'
    );
    if (player) {
      if (typeof player.matches === "function" && player.matches("video")) {
        return player;
      }

      const playerVideo = player.querySelector?.("video");
      if (playerVideo) {
        return playerVideo;
      }

      const articleVideo = closestTweetArticle(player)?.querySelector?.("video");
      if (articleVideo) {
        return articleVideo;
      }
    }

    const article = closestTweetArticle(target);
    if (!article || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
      return null;
    }

    for (const video of article.querySelectorAll("video")) {
      const rect = video.getBoundingClientRect?.();
      if (
        rect &&
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        return video;
      }
    }

    return null;
  }

  function handleMediaPointerDown(event) {
    if (!event.isTrusted) {
      return;
    }

    const video = findVideoFromPointerEvent(event);
    if (!video) {
      return;
    }

    activeMediaPointers.set(event.pointerId, {
      video,
      startX: event.clientX,
      startY: event.clientY,
      movedFar: false
    });
  }

  function handleMediaPointerMove(event) {
    const gesture = activeMediaPointers.get(event.pointerId);
    if (!gesture || gesture.movedFar) {
      return;
    }

    gesture.movedFar =
      Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 12;
  }

  function finishMediaPointer(event) {
    const gesture = activeMediaPointers.get(event.pointerId);
    if (!gesture) {
      return;
    }

    activeMediaPointers.delete(event.pointerId);
    recentMediaGestures.set(gesture.video, {
      movedFar: gesture.movedFar,
      expiresAt: monotonicNow() + MEDIA_GESTURE_GRACE_MS
    });
  }

  function cancelMediaPointer(event) {
    activeMediaPointers.delete(event.pointerId);
  }

  function hasRecentMediaGesture(video, allowMovement) {
    for (const gesture of activeMediaPointers.values()) {
      if (gesture.video === video && (allowMovement || !gesture.movedFar)) {
        return true;
      }
    }

    const recent = recentMediaGestures.get(video);
    return Boolean(
      recent &&
        recent.expiresAt >= monotonicNow() &&
        (allowMovement || !recent.movedFar)
    );
  }

  function getVideoContext(video) {
    return recorder.getArticleContext(closestTweetArticle(video));
  }

  function handleExplicitVideoEvent(event) {
    const video = event.currentTarget;
    if (!hasRecentMediaGesture(video, event.type === "seeking")) {
      return;
    }

    const context = getVideoContext(video);
    if (context) {
      void recorder.recordContext(context);
    }
  }

  function monotonicNow() {
    const clock = globalThis.performance;
    return typeof clock?.now === "function" ? clock.now() : Date.now();
  }

  function observeVideo(video) {
    if (
      !video ||
      observedVideos.has(video) ||
      typeof video.addEventListener !== "function"
    ) {
      return;
    }

    observedVideos.add(video);
    for (const type of ["play", "pause", "seeking", "volumechange", "ratechange"]) {
      video.addEventListener(type, handleExplicitVideoEvent);
    }
  }

  function handleArticleIntersections(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting || entry.intersectionRatio <= 0) {
        visibleArticles.delete(entry.target);
      } else {
        visibleArticles.set(entry.target, entry.boundingClientRect);
      }
    }
  }

  const articleObserver =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(handleArticleIntersections, {
          threshold: [0, 0.25, 0.5, 0.75, 1]
        })
      : null;

  function observeArticle(article) {
    if (!article || observedArticles.has(article) || !articleObserver) {
      return;
    }

    observedArticles.add(article);
    articleObserver.observe(article);
  }

  function observeContentWithin(root) {
    if (!root) {
      return;
    }

    if (typeof root.matches === "function") {
      if (root.matches("video")) {
        observeVideo(root);
      }
      if (root.matches('article[data-testid="tweet"]')) {
        observeArticle(root);
      }
    }

    if (typeof root.querySelectorAll === "function") {
      for (const video of root.querySelectorAll("video")) {
        observeVideo(video);
      }
      for (const article of root.querySelectorAll('article[data-testid="tweet"]')) {
        observeArticle(article);
      }
    }
  }

  function allowsPassiveDwellOnCurrentPage() {
    const href = String(window.location?.href || "");
    if (shared.parseTweetRoute(href)) {
      return false;
    }

    try {
      const pathname = new URL(href).pathname.replace(/\/+$/, "").toLowerCase();
      return !pathname.endsWith("/media");
    } catch {
      return false;
    }
  }

  function isArticleMeaningfullyVisible(rect, viewportHeight) {
    if (!rect || rect.height <= 0 || viewportHeight <= 0) {
      return false;
    }

    const visibleHeight = Math.max(
      0,
      Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0)
    );
    return (
      visibleHeight / rect.height >= MIN_ARTICLE_VISIBLE_RATIO ||
      visibleHeight >= viewportHeight * MIN_VIEWPORT_COVERAGE_RATIO
    );
  }

  function sampleArticleDwell(now) {
    if (!allowsPassiveDwellOnCurrentPage()) {
      visibleDwellClocks.clear();
      return;
    }

    const viewportHeight =
      window.innerHeight || document.documentElement?.clientHeight || 0;
    const activeTweetIds = new Set();

    for (const [article, observedRect] of visibleArticles) {
      if (article.isConnected === false) {
        visibleArticles.delete(article);
        continue;
      }

      const context = recorder.getPassiveContext(article);
      const tweetId = context?.route.id;
      if (
        !tweetId ||
        dwellRecordedTweetIds.has(tweetId) ||
        activeTweetIds.has(tweetId)
      ) {
        continue;
      }

      const rect = article.getBoundingClientRect?.() || observedRect;
      if (!isArticleMeaningfullyVisible(rect, viewportHeight)) {
        continue;
      }

      activeTweetIds.add(tweetId);
      const previousClock = visibleDwellClocks.get(tweetId) || {
        elapsedAttentionMs: 0,
        lastTickAt: now
      };
      const nextClock = shared.advanceAttentionClock(previousClock, now);
      visibleDwellClocks.set(tweetId, nextClock);

      if (nextClock.elapsedAttentionMs < VISIBLE_DWELL_THRESHOLD_MS) {
        continue;
      }

      dwellRecordedTweetIds.add(tweetId);
      visibleDwellClocks.delete(tweetId);
      void recorder.recordContext(context);
    }

    for (const tweetId of visibleDwellClocks.keys()) {
      if (!activeTweetIds.has(tweetId)) {
        visibleDwellClocks.delete(tweetId);
      }
    }
  }

  function handleStorageChanges(changes, areaName) {
    if (areaName !== "local") {
      return;
    }

    for (const tweetId of shared.removedTweetIds(changes)) {
      dwellRecordedTweetIds.delete(tweetId);
      visibleDwellClocks.delete(tweetId);
    }
  }

  function sampleArticleDwellNow() {
    sampleArticleDwell(monotonicNow());
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations || []) {
      for (const node of mutation.addedNodes || []) {
        observeContentWithin(node);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  if (typeof document.addEventListener === "function") {
    document.addEventListener("click", handleArticleInteraction, true);
    document.addEventListener("auxclick", handleArticleInteraction, true);
    document.addEventListener("contextmenu", handleArticleInteraction, true);
    document.addEventListener("keydown", handleArticleKeydown, true);
    document.addEventListener("copy", handleTweetCopy, true);
    document.addEventListener("pointerdown", handleMediaPointerDown, true);
    document.addEventListener("pointermove", handleMediaPointerMove, true);
    document.addEventListener("pointerup", finishMediaPointer, true);
    document.addEventListener("pointercancel", cancelMediaPointer, true);
    document.addEventListener("visibilitychange", sampleArticleDwellNow, true);
  }
  if (typeof window.addEventListener === "function") {
    window.addEventListener("focus", sampleArticleDwellNow, true);
  }

  chrome.storage?.onChanged?.addListener(handleStorageChanges);
  observeContentWithin(document);
  window.setInterval(sampleArticleDwellNow, SAMPLE_INTERVAL_MS);
})();
