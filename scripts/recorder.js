(function initializeRecorder() {
  "use strict";

  const shared = globalThis.XTweetRecall;
  if (!shared) {
    return;
  }

  const MEDIA_READY_TIMEOUT_MS = 8_000;
  const MEDIA_READY_POLL_MS = 120;
  const MAX_ENRICHMENT_ATTEMPTS = 30;
  const recordedFeedTweetIds = new Set();
  const pendingFeedTweetIds = new Set();
  const requestedPreviewTweetIds = new Set();
  const pendingPreviewTweetIds = new Set();
  const waitingPreviewRequests = new Map();
  let lastHref = "";
  let activeSession = null;
  let routeCheckScheduled = false;
  let enrichmentTimer = null;

  function scheduleRouteCheck() {
    if (routeCheckScheduled) {
      return;
    }

    routeCheckScheduled = true;
    queueMicrotask(() => {
      routeCheckScheduled = false;
      syncRoute();
    });
  }

  function syncRoute() {
    const href = window.location.href;
    if (href === lastHref) {
      if (activeSession && !activeSession.enriched) {
        scheduleEnrichment(activeSession, 160);
      }
      return;
    }

    lastHref = href;
    const route = shared.parseTweetRoute(href);
    if (!route) {
      activeSession = null;
      return;
    }

    if (activeSession?.id === route.id) {
      return;
    }

    const session = {
      ...route,
      mediaHint: inferRouteMediaHint(href),
      saved: false,
      enriched: false,
      attempts: 0,
      record: null
    };

    activeSession = session;
    void saveVisit(session);
  }

  async function saveVisit(session) {
    const storageKey = shared.makeStorageKey(session.id);
    const now = new Date().toISOString();

    try {
      const stored = await chrome.storage.local.get(storageKey);
      const existing = shared.isTweetRecord(stored[storageKey])
        ? stored[storageKey]
        : null;
      const nextRecord = buildVisitRecord(session, existing, null, now);

      await chrome.storage.local.set({ [storageKey]: nextRecord });
      if (activeSession !== session) {
        return;
      }

      session.record = nextRecord;
      session.saved = true;
      scheduleEnrichment(session, session.mediaHint ? 180 : 40);
    } catch (error) {
      console.warn("[XRecall] 保存推文失败", error);
    }
  }

  function buildVisitRecord(route, existing, details, now) {
    const existingMedia = Array.isArray(existing?.media) ? existing.media : [];
    const hintedMedia = route.mediaHint ? [route.mediaHint] : [];
    const nextMedia = details?.media?.length
      ? details.media
      : existingMedia.length
        ? existingMedia
        : hintedMedia;

    return {
      schemaVersion: 1,
      id: route.id,
      url: route.canonicalUrl,
      handle: details?.handle || route.handle || existing?.handle || "",
      author: details?.author || existing?.author || "",
      text: details?.text || existing?.text || "",
      language: details?.language || existing?.language || "",
      media: nextMedia,
      tweetedAt: details?.tweetedAt || existing?.tweetedAt || "",
      firstVisitedAt: existing?.firstVisitedAt || now,
      lastVisitedAt: now,
      visitCount: Math.max(0, Number(existing?.visitCount) || 0) + 1
    };
  }

  function scheduleEnrichment(session, delay = 300) {
    if (
      enrichmentTimer ||
      activeSession !== session ||
      !session.saved ||
      session.enriched
    ) {
      return;
    }

    enrichmentTimer = window.setTimeout(() => {
      enrichmentTimer = null;
      void enrichRecord(session);
    }, delay);
  }

  async function enrichRecord(session) {
    if (activeSession !== session || !session.saved || session.enriched) {
      return;
    }

    session.attempts += 1;
    const article = findTargetArticle(session.id);
    const routeMedia = session.mediaHint
      ? findVisibleRouteMediaElement(session.mediaHint)
      : null;
    if (!article && !routeMedia) {
      if (session.attempts < MAX_ENRICHMENT_ATTEMPTS) {
        scheduleEnrichment(session, 450);
      }
      return;
    }

    const details = mergeMediaHint(
      article
        ? extractTweetDetails(article, session)
        : createEmptyDetails(session),
      session.mediaHint
    );
    const contentIsReady = details.hasTextNode || details.media.length > 0;
    const previewTarget = contentIsReady ? article : null;
    const previewReady = routeMedia
      ? await requestPreview(routeMedia, session.id, {
          replaceExisting: true,
          forceRefresh: true
        })
      : previewTarget
        ? await requestPreview(previewTarget, session.id, {
            replaceExisting: hasVisualMedia(details)
          })
        : false;
    const nextRecord = {
      ...session.record,
      handle: details.handle || session.record.handle,
      author: details.author || session.record.author,
      text: details.text || session.record.text,
      language: details.language || session.record.language,
      media: details.media.length ? details.media : session.record.media,
      tweetedAt: details.tweetedAt || session.record.tweetedAt
    };

    try {
      await chrome.storage.local.set({
        [shared.makeStorageKey(session.id)]: nextRecord
      });
      if (activeSession !== session) {
        return;
      }

      session.record = nextRecord;
      session.enriched =
        (contentIsReady && previewReady) ||
        session.attempts >= MAX_ENRICHMENT_ATTEMPTS;
      if (!session.enriched) {
        scheduleEnrichment(session, 450);
      }
    } catch (error) {
      console.warn("[XRecall] 补全推文信息失败", error);
    }
  }

  function getArticleContext(article) {
    if (!article || typeof article.querySelectorAll !== "function") {
      return null;
    }

    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      if (!link.querySelector("time")) {
        continue;
      }
      if (
        typeof link.closest === "function" &&
        link.closest('article[data-testid="tweet"]') !== article
      ) {
        continue;
      }

      const route = shared.parseTweetRoute(link.href);
      if (route) {
        return { article, route };
      }
    }

    return null;
  }

  function getPassiveContext(article) {
    const context = getArticleContext(article);
    if (!context) {
      return null;
    }

    const details = extractTweetDetails(article, context.route);
    return details.hasTextNode || details.media.length > 0
      ? { ...context, details }
      : null;
  }

  function getInteractionContext(target) {
    const article =
      typeof target?.closest === "function"
        ? target.closest('article[data-testid="tweet"]')
        : null;
    const statusLink =
      typeof target?.closest === "function"
        ? target.closest('a[href*="/status/"]')
        : null;
    const directRoute = statusLink
      ? shared.parseTweetRoute(statusLink.href)
      : null;
    const context = directRoute
      ? { article, route: directRoute }
      : getArticleContext(article);
    if (!context) {
      return null;
    }

    const mediaHint = inferElementMediaHint(target, statusLink);
    return {
      ...context,
      mediaHint,
      captureElement: chooseInteractionCaptureElement(
        target,
        statusLink,
        article,
        mediaHint
      )
    };
  }

  async function saveFeedInteraction(context) {
    const { article, route } = context || {};
    if (!route || activeSession?.id === route.id) {
      return false;
    }

    const details = mergeMediaHint(
      context.details ||
        (article ? extractTweetDetails(article, route) : createEmptyDetails(route)),
      context.mediaHint
    );
    const previewTarget = context.captureElement || article;
    // A failed capture should remain retryable even after the text record exists.
    // requestPreview itself deduplicates successful and in-flight captures.
    if (previewTarget) {
      void requestPreview(previewTarget, route.id, {
        replaceExisting: hasVisualMedia(details)
      });
    }
    if (
      recordedFeedTweetIds.has(route.id) ||
      pendingFeedTweetIds.has(route.id)
    ) {
      return false;
    }

    pendingFeedTweetIds.add(route.id);
    const storageKey = shared.makeStorageKey(route.id);
    const now = new Date().toISOString();

    try {
      const stored = await chrome.storage.local.get(storageKey);
      const existing = shared.isTweetRecord(stored[storageKey])
        ? stored[storageKey]
        : null;
      const nextRecord = buildVisitRecord(
        { ...route, mediaHint: context.mediaHint || "" },
        existing,
        details,
        now
      );

      await chrome.storage.local.set({ [storageKey]: nextRecord });
      recordedFeedTweetIds.add(route.id);
      return true;
    } catch (error) {
      console.warn("[XRecall] 保存 Feed 交互推文失败", error);
      return false;
    } finally {
      pendingFeedTweetIds.delete(route.id);
    }
  }

  function saveArticleInteraction(article) {
    const context = getArticleContext(article);
    return context ? saveFeedInteraction(context) : Promise.resolve(false);
  }

  function saveTargetInteraction(target) {
    const context = getInteractionContext(target);
    return context ? saveFeedInteraction(context) : Promise.resolve(false);
  }

  async function requestPreview(
    target,
    tweetId,
    { replaceExisting = false, forceRefresh = false } = {}
  ) {
    if (requestedPreviewTweetIds.has(tweetId) && !forceRefresh) {
      return true;
    }

    const waiting = waitingPreviewRequests.get(tweetId);
    if (waiting) {
      if (!forceRefresh) {
        return waiting;
      }
      await waiting.catch(() => false);
    }

    const operation = prepareAndSubmitPreview(target, tweetId, {
      replaceExisting,
      forceRefresh
    }).finally(() => {
      if (waitingPreviewRequests.get(tweetId) === operation) {
        waitingPreviewRequests.delete(tweetId);
      }
    });
    waitingPreviewRequests.set(tweetId, operation);
    return operation;
  }

  async function prepareAndSubmitPreview(
    target,
    tweetId,
    { replaceExisting, forceRefresh }
  ) {
    const pageUrl = window.location.href;
    const ready = await waitForPreviewTargetReady(target, pageUrl);
    if (
      !ready ||
      target?.isConnected === false ||
      !shared.isSamePage(window.location.href, pageUrl)
    ) {
      return false;
    }

    const request = buildPreviewRequest(target, tweetId, pageUrl);
    if (!request) {
      return false;
    }
    if (replaceExisting) {
      request.replaceExisting = true;
    }

    return submitPreviewRequest(request, tweetId, forceRefresh);
  }

  async function submitPreviewRequest(request, tweetId, forceRefresh) {
    if (requestedPreviewTweetIds.has(tweetId) && !forceRefresh) {
      return true;
    }
    if (
      pendingPreviewTweetIds.has(tweetId) ||
      typeof chrome.runtime?.sendMessage !== "function"
    ) {
      return false;
    }

    pendingPreviewTweetIds.add(tweetId);
    try {
      const result = await chrome.runtime.sendMessage(request);
      if (result?.ok || result?.reason === "already-exists") {
        requestedPreviewTweetIds.add(tweetId);
        return true;
      }
    } catch (error) {
      console.debug("[XRecall] 本次预览截图未完成", error);
    } finally {
      pendingPreviewTweetIds.delete(tweetId);
    }

    return false;
  }

  async function waitForPreviewTargetReady(target, pageUrl) {
    const deadline = Date.now() + MEDIA_READY_TIMEOUT_MS;

    while (Date.now() <= deadline) {
      if (
        target?.isConnected === false ||
        !isElementVisibleInViewport(target) ||
        document.visibilityState === "hidden" ||
        !shared.isSamePage(window.location.href, pageUrl)
      ) {
        return false;
      }

      const mediaState = collectVisiblePreviewMedia(target);
      if (!mediaState.hasPendingContainer && mediaState.media.every(isMediaReady)) {
        await Promise.all(mediaState.media.map(finishMediaDecode));
        if (!mediaState.media.every(isMediaReady)) {
          await delay(MEDIA_READY_POLL_MS);
          continue;
        }

        await waitForPaintFrames(2);
        return (
          target?.isConnected !== false &&
          isElementVisibleInViewport(target) &&
          document.visibilityState !== "hidden" &&
          shared.isSamePage(window.location.href, pageUrl) &&
          mediaState.media.every(
            (element) => isElementVisibleInViewport(element) && isMediaReady(element)
          ) &&
          !collectVisiblePreviewMedia(target).hasPendingContainer
        );
      }

      await delay(MEDIA_READY_POLL_MS);
    }

    return false;
  }

  function collectVisiblePreviewMedia(target) {
    const media = [];
    const seen = new Set();
    const add = (element) => {
      if (
        !element ||
        seen.has(element) ||
        !isPreviewMediaElement(element) ||
        !isElementVisibleInViewport(element)
      ) {
        return;
      }
      seen.add(element);
      media.push(element);
    };

    add(target);
    for (const selector of [
      '[data-testid="tweetPhoto"] img',
      '[data-testid="card.wrapper"] img',
      '[data-testid="videoPlayer"] video',
      "video"
    ]) {
      for (const element of safeQuerySelectorAll(target, selector)) {
        add(element);
      }
    }

    let hasPendingContainer = false;
    for (const container of safeQuerySelectorAll(
      target,
      '[data-testid="tweetPhoto"], [data-testid="videoPlayer"]'
    )) {
      if (!isElementVisibleInViewport(container)) {
        continue;
      }
      const containedMedia = safeQuerySelectorAll(container, "img, video");
      if (!containedMedia.some(isElementVisibleInViewport)) {
        hasPendingContainer = true;
        break;
      }
    }

    return { media, hasPendingContainer };
  }

  function safeQuerySelectorAll(target, selector) {
    if (typeof target?.querySelectorAll !== "function") {
      return [];
    }

    try {
      return Array.from(target.querySelectorAll(selector) || []);
    } catch {
      return [];
    }
  }

  function isPreviewMediaElement(element) {
    return matchesTag(element, "img") || matchesTag(element, "video");
  }

  function matchesTag(element, tagName) {
    if (String(element?.tagName || "").toLowerCase() === tagName) {
      return true;
    }
    try {
      return Boolean(element?.matches?.(tagName));
    } catch {
      return false;
    }
  }

  function isMediaReady(element) {
    if (matchesTag(element, "img")) {
      return (
        element.complete === true &&
        Number(element.naturalWidth) > 0 &&
        Number(element.naturalHeight) > 0
      );
    }
    if (matchesTag(element, "video")) {
      return (
        Number(element.readyState) >= 2 &&
        Number(element.videoWidth) > 0 &&
        Number(element.videoHeight) > 0
      );
    }
    return true;
  }

  async function finishMediaDecode(element) {
    if (matchesTag(element, "img") && typeof element.decode === "function") {
      await Promise.race([
        Promise.resolve().then(() => element.decode()).catch(() => undefined),
        delay(1_000)
      ]);
      return;
    }

    if (
      matchesTag(element, "video") &&
      typeof element.requestVideoFrameCallback === "function"
    ) {
      await Promise.race([
        new Promise((resolve) => element.requestVideoFrameCallback(resolve)),
        delay(500)
      ]);
    }
  }

  function isElementVisibleInViewport(element) {
    const rect = element?.getBoundingClientRect?.();
    const viewportWidth = Number(window.innerWidth) || 0;
    const viewportHeight = Number(window.innerHeight) || 0;
    return Boolean(
      rect &&
        rect.width > 1 &&
        rect.height > 1 &&
        rect.right > 0 &&
        rect.bottom > 0 &&
        rect.left < viewportWidth &&
        rect.top < viewportHeight
    );
  }

  async function waitForPaintFrames(count) {
    for (let frame = 0; frame < count; frame += 1) {
      if (typeof window.requestAnimationFrame !== "function") {
        await Promise.resolve();
        continue;
      }
      await Promise.race([
        new Promise((resolve) => window.requestAnimationFrame(resolve)),
        delay(250)
      ]);
    }
  }

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }


  function buildPreviewRequest(article, tweetId, pageUrl) {
    const rect = article?.getBoundingClientRect?.();
    const viewportWidth = Number(window.innerWidth) || 0;
    const viewportHeight = Number(window.innerHeight) || 0;
    if (!rect || viewportWidth <= 0 || viewportHeight <= 0) {
      return null;
    }

    let contentBottom = rect.bottom;
    const actionGroup = article
      .querySelector?.('[data-testid="reply"]')
      ?.closest?.('[role="group"]');
    const actionRect = actionGroup?.getBoundingClientRect?.();
    if (actionRect && actionRect.top > rect.top + 80) {
      contentBottom = Math.min(contentBottom, actionRect.top - 4);
    }

    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(viewportWidth, rect.right);
    const bottom = Math.min(viewportHeight, contentBottom);
    const width = right - left;
    const height = bottom - top;
    if (width < 120 || height < 72) {
      return null;
    }

    return {
      type: "xRecall:capturePreview",
      tweetId,
      crop: { left, top, width, height },
      viewport: { width: viewportWidth, height: viewportHeight },
      pageUrl
    };
  }

  function findTargetArticle(tweetId) {
    const links = document.querySelectorAll(
      'article[data-testid="tweet"] a[href*="/status/"]'
    );
    for (const link of links) {
      if (!link.querySelector("time")) {
        continue;
      }

      const route = shared.parseTweetRoute(link.href);
      if (route?.id !== tweetId) {
        continue;
      }

      const article = link.closest('article[data-testid="tweet"]');
      if (article) {
        return article;
      }
    }

    return null;
  }

  function extractTweetDetails(article, route) {
    const textNode = article.querySelector('[data-testid="tweetText"]');
    const text = normalizeText(textNode?.textContent || "");
    const language = textNode?.getAttribute("lang") || "";
    const userNameNode = article.querySelector('[data-testid="User-Name"]');
    const userLinks = userNameNode
      ? Array.from(userNameNode.querySelectorAll("a[href]"))
      : [];
    const userLinkTexts = userLinks
      .map((link) => normalizeText(link.textContent || ""))
      .filter(Boolean);
    const handleText = userLinkTexts.find((value) => value.startsWith("@")) || "";
    const author =
      userLinkTexts.find((value) => !value.startsWith("@") && value !== "·") || "";
    const time = article.querySelector(`a[href*="/status/${route.id}"] time`);
    const media = new Set();

    if (article.querySelector('[data-testid="tweetPhoto"]')) {
      media.add("图片");
    }
    if (article.querySelector('video, [data-testid="videoPlayer"]')) {
      media.add("视频");
    }
    if (article.querySelector('[data-testid="poll"]')) {
      media.add("投票");
    }
    if (article.querySelector('[data-testid="card.wrapper"]')) {
      media.add("链接卡片");
    }

    return {
      author,
      handle: handleText.replace(/^@/, "") || route.handle,
      text,
      language,
      media: Array.from(media),
      tweetedAt: time?.getAttribute("datetime") || "",
      hasTextNode: Boolean(textNode)
    };
  }

  function createEmptyDetails(route) {
    return {
      author: "",
      handle: route.handle || "",
      text: "",
      language: "",
      media: [],
      tweetedAt: "",
      hasTextNode: false
    };
  }

  function mergeMediaHint(details, mediaHint) {
    if (!mediaHint) {
      return details;
    }

    return {
      ...details,
      media: Array.from(new Set([...(details.media || []), mediaHint]))
    };
  }

  function hasVisualMedia(details) {
    return (details?.media || []).some(
      (mediaType) => mediaType === "图片" || mediaType === "视频"
    );
  }

  function inferRouteMediaHint(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const parts = url.pathname.split("/").filter(Boolean);
      const statusIndex = parts.findIndex(
        (part) => part.toLowerCase() === "status"
      );
      const mediaSegment = parts[statusIndex + 2]?.toLowerCase() || "";
      if (mediaSegment === "photo") {
        return "图片";
      }
      if (mediaSegment === "video") {
        return "视频";
      }
    } catch {
      return "";
    }
    return "";
  }

  function inferElementMediaHint(target, statusLink) {
    const routeHint = inferRouteMediaHint(statusLink?.href || "");
    if (routeHint) {
      return routeHint;
    }

    const videoSelector = 'video, [data-testid="videoPlayer"]';
    const imageSelector = 'img, [data-testid="tweetPhoto"]';
    if (
      target?.closest?.(videoSelector) ||
      statusLink?.querySelector?.(videoSelector)
    ) {
      return "视频";
    }
    if (
      target?.closest?.(imageSelector) ||
      statusLink?.querySelector?.(imageSelector)
    ) {
      return "图片";
    }
    return "";
  }

  function chooseInteractionCaptureElement(
    target,
    statusLink,
    article,
    mediaHint
  ) {
    if (!mediaHint) {
      return article || statusLink || null;
    }

    const selector = mediaHint === "视频"
      ? 'video, [data-testid="videoPlayer"]'
      : 'img, [data-testid="tweetPhoto"]';
    return (
      target?.closest?.(selector) ||
      statusLink?.querySelector?.(selector) ||
      statusLink ||
      article ||
      null
    );
  }

  function findVisibleRouteMediaElement(mediaHint) {
    const selector = mediaHint === "视频"
      ? 'video, [data-testid="videoPlayer"] video'
      : '[aria-modal="true"] img[src], [role="dialog"] img[src], [data-testid="swipe-to-dismiss"] img[src], img[src]';
    const viewportWidth = Number(window.innerWidth) || 0;
    const viewportHeight = Number(window.innerHeight) || 0;
    const viewportArea = viewportWidth * viewportHeight;
    let best = null;

    for (const element of document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect?.();
      if (!rect || rect.width < 120 || rect.height < 72) {
        continue;
      }

      const visibleWidth = Math.max(
        0,
        Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0)
      );
      const visibleHeight = Math.max(
        0,
        Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0)
      );
      const isInsideViewer = Boolean(element.closest?.(
        '[aria-modal="true"], [role="dialog"], [data-testid="swipe-to-dismiss"]'
      ));
      const visibleArea = visibleWidth * visibleHeight;
      const coversViewportCenter =
        rect.left <= viewportWidth / 2 &&
        rect.right >= viewportWidth / 2 &&
        rect.top <= viewportHeight / 2 &&
        rect.bottom >= viewportHeight / 2;
      if (
        !isInsideViewer &&
        (visibleArea < viewportArea * 0.25 || !coversViewportCenter)
      ) {
        continue;
      }

      const score = visibleArea * (isInsideViewer ? 2 : 1);
      if (score > 0 && (!best || score > best.score)) {
        best = { element, score };
      }
    }

    return best?.element || null;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function handleStorageChanges(changes, areaName) {
    if (areaName !== "local") {
      return;
    }

    for (const tweetId of shared.removedTweetIds(changes)) {
      recordedFeedTweetIds.delete(tweetId);
      requestedPreviewTweetIds.delete(tweetId);
    }
  }

  globalThis.XRecallRecorder = Object.freeze({
    getArticleContext,
    getPassiveContext,
    recordArticle: saveArticleInteraction,
    recordTarget: saveTargetInteraction,
    recordContext: saveFeedInteraction
  });

  const observer = new MutationObserver(() => {
    scheduleRouteCheck();
    if (activeSession && !activeSession.enriched) {
      scheduleEnrichment(activeSession, 180);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  chrome.storage?.onChanged?.addListener(handleStorageChanges);
  window.setInterval(scheduleRouteCheck, 800);
  syncRoute();
})();
