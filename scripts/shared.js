(function initializeShared(globalScope) {
  "use strict";

  const STORAGE_PREFIX = "xRecall:tweet:";

  function isXHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    return (
      host === "x.com" ||
      host.endsWith(".x.com") ||
      host === "twitter.com" ||
      host.endsWith(".twitter.com")
    );
  }

  function parseTweetRoute(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (!isXHost(url.hostname)) {
        return null;
      }

      const parts = url.pathname.split("/").filter(Boolean);
      const statusIndex = parts.findIndex((part) => part.toLowerCase() === "status");
      const id = parts[statusIndex + 1] || "";

      if (statusIndex < 1 || !/^\d+$/.test(id)) {
        return null;
      }

      const precedingPart = parts[statusIndex - 1] || "";
      const isGenericRoute =
        (precedingPart.toLowerCase() === "web" &&
          parts[statusIndex - 2]?.toLowerCase() === "i") ||
        precedingPart.toLowerCase() === "i";
      const handle = isGenericRoute ? "" : decodeURIComponent(precedingPart).replace(/^@/, "");
      const canonicalUrl = handle
        ? `https://x.com/${encodeURIComponent(handle)}/status/${id}`
        : `https://x.com/i/web/status/${id}`;

      return { id, handle, canonicalUrl };
    } catch {
      return null;
    }
  }

  function makeStorageKey(id) {
    return `${STORAGE_PREFIX}${id}`;
  }

  function isTweetRecord(value) {
    return Boolean(
      value &&
        typeof value === "object" &&
        /^\d+$/.test(String(value.id || "")) &&
        typeof value.url === "string"
    );
  }

  function isSamePage(leftUrl, rightUrl) {
    try {
      const left = new URL(leftUrl || "");
      const right = new URL(rightUrl || "");
      return left.origin === right.origin && left.pathname === right.pathname;
    } catch {
      return false;
    }
  }

  function removedTweetIds(changes) {
    return Object.entries(changes || {})
      .filter(
        ([key, change]) =>
          key.startsWith(STORAGE_PREFIX) && change?.newValue === undefined
      )
      .map(([key]) => key.slice(STORAGE_PREFIX.length));
  }

  function getRecordTime(record) {
    const time = Date.parse(record?.lastVisitedAt || record?.firstVisitedAt || "");
    return Number.isFinite(time) ? time : Number.NaN;
  }

  function advanceAttentionClock(state, now) {
    const elapsedAttentionMs = Math.max(
      0,
      Number(state?.elapsedAttentionMs) || 0
    );
    const lastTickAt = Number(state?.lastTickAt);
    const currentTickAt = Number(now);

    if (!Number.isFinite(currentTickAt)) {
      return { elapsedAttentionMs, lastTickAt: null };
    }

    const elapsedMs = Number.isFinite(lastTickAt)
      ? Math.max(0, currentTickAt - lastTickAt)
      : 0;

    return {
      elapsedAttentionMs: elapsedAttentionMs + elapsedMs,
      lastTickAt: currentTickAt
    };
  }

  function matchesLooseLocalTimeQuery(rawQuery, rawValues, referenceNow = new Date()) {
    const query = String(rawQuery || "").trim().toLowerCase();
    if (!query || !isLooseTimeQuery(query)) {
      return false;
    }

    const dates = (Array.isArray(rawValues) ? rawValues : [rawValues])
      .map((value) => new Date(value))
      .filter((date) => Number.isFinite(date.getTime()));
    if (!dates.length) {
      return false;
    }

    const dayOffset = query.includes("前天")
      ? -2
      : query.includes("昨天")
        ? -1
        : query.includes("今天")
          ? 0
          : null;
    const period = /下午|晚上|傍晚/.test(query)
      ? "pm"
      : /上午|早上|凌晨/.test(query)
        ? "am"
        : query.includes("中午")
          ? "noon"
          : "";
    const options = {
      period,
      hasHourMarker: /点|时/.test(query),
      hasMinuteMarker: query.includes("分"),
      hasYearMarker: query.includes("年"),
      hasMonthMarker: query.includes("月"),
      hasDayMarker: /日|号/.test(query)
    };
    const rawGroups = (query.match(/\d+/g) || []).map((digits) => ({
      digits,
      value: Number(digits)
    }));
    const collapsedGroups = rawGroups.filter(
      (group, index) => index === 0 || group.value !== rawGroups[index - 1].value
    );

    return dates.some((date) => {
      if (
        dayOffset !== null &&
        !isLocalDayOffset(date, referenceNow, dayOffset)
      ) {
        return false;
      }
      if (!matchesDayPeriod(date, period)) {
        return false;
      }
      if (!rawGroups.length) {
        return dayOffset !== null;
      }

      return (
        matchesTimeGroups(date, rawGroups, options) ||
        (collapsedGroups.length !== rawGroups.length &&
          matchesTimeGroups(date, collapsedGroups, options))
      );
    });
  }

  function isLooseTimeQuery(query) {
    if (/^\d{9,}$/.test(query)) {
      return false;
    }
    const remainder = query
      .replace(/今天|昨天|前天|上午|下午|早上|晚上|傍晚|凌晨|中午/g, "")
      .replace(/[年月日号点时分秒]/g, "")
      .replace(/[\d\s:：/／\\.,，、;；_\-—]/g, "");
    return (
      remainder === "" &&
      (/\d/.test(query) || /今天|昨天|前天/.test(query))
    );
  }

  function matchesTimeGroups(date, groups, options) {
    const values = groups.map((group) => group.value);
    const first = values[0];
    const last = values[values.length - 1];
    const hour = date.getHours();
    const minute = date.getMinutes();
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();

    if (
      options.hasYearMarker &&
      !values.includes(year) &&
      !values.includes(year % 100)
    ) {
      return false;
    }
    if (options.hasMonthMarker && !values.includes(month)) {
      return false;
    }
    if (options.hasDayMarker && !values.includes(day)) {
      return false;
    }
    if (options.hasMinuteMarker && !options.hasHourMarker) {
      return last === minute;
    }
    if (options.hasHourMarker) {
      if (!matchesHour(hour, first, options.period)) {
        return false;
      }
      return values.length < 2 || last === minute;
    }

    if (groups.length === 1) {
      const { digits, value } = groups[0];
      if (options.hasYearMarker || options.hasMonthMarker || options.hasDayMarker) {
        return (
          value === year ||
          value === year % 100 ||
          value === month ||
          value === day
        );
      }
      if (options.period) {
        return matchesHour(hour, value, options.period);
      }
      if (digits.length === 4 && value === year) {
        return true;
      }
      if (digits.length <= 2) {
        return matchesHour(hour, value, "") || minute === value;
      }
      if (digits.length === 8) {
        return digits === buildCompactDate(date);
      }
      return compactTimeCandidates(digits).some(
        ([queryHour, queryMinute]) =>
          matchesHour(hour, queryHour, "") && minute === queryMinute
      );
    }

    const candidates = [
      [year, month, day, hour, minute],
      [year % 100, month, day, hour, minute],
      [month, day, hour, minute],
      [month, day],
      [hour, minute],
      [toTwelveHour(hour), minute]
    ];
    return candidates.some((candidate) =>
      containsNumberSequence(candidate, values)
    );
  }

  function compactTimeCandidates(digits) {
    const candidates = [];
    if (digits.length === 3) {
      candidates.push([Number(digits.slice(0, 1)), Number(digits.slice(1))]);
      candidates.push([Number(digits.slice(0, 2)), Number(digits.slice(2))]);
    } else if (digits.length === 4) {
      candidates.push([Number(digits.slice(0, 2)), Number(digits.slice(2))]);
    }
    return candidates.filter(
      ([hour, minute]) => hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    );
  }

  function matchesHour(actualHour, queryHour, period) {
    if (!Number.isFinite(queryHour)) {
      return false;
    }
    if (period === "pm") {
      return actualHour === (queryHour < 12 ? queryHour + 12 : queryHour);
    }
    if (period === "am") {
      return actualHour === (queryHour === 12 ? 0 : queryHour);
    }
    if (period === "noon") {
      const normalized = queryHour > 0 && queryHour < 11
        ? queryHour + 12
        : queryHour;
      return actualHour === normalized;
    }
    return actualHour === queryHour || toTwelveHour(actualHour) === queryHour;
  }

  function matchesDayPeriod(date, period) {
    const hour = date.getHours();
    if (period === "pm") {
      return hour >= 12;
    }
    if (period === "am") {
      return hour < 12;
    }
    if (period === "noon") {
      return hour >= 11 && hour <= 13;
    }
    return true;
  }

  function toTwelveHour(hour) {
    return hour % 12 || 12;
  }

  function containsNumberSequence(haystack, needle) {
    if (!needle.length || needle.length > haystack.length) {
      return false;
    }
    for (let start = 0; start <= haystack.length - needle.length; start += 1) {
      if (needle.every((value, index) => value === haystack[start + index])) {
        return true;
      }
    }
    return false;
  }

  function buildCompactDate(date) {
    return [
      String(date.getFullYear()).padStart(4, "0"),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("");
  }

  function isLocalDayOffset(date, reference, dayOffset) {
    const target = new Date(
      reference.getFullYear(),
      reference.getMonth(),
      reference.getDate()
    );
    target.setDate(target.getDate() + dayOffset);
    return (
      date.getFullYear() === target.getFullYear() &&
      date.getMonth() === target.getMonth() &&
      date.getDate() === target.getDate()
    );
  }

  const api = Object.freeze({
    STORAGE_PREFIX,
    isXHost,
    parseTweetRoute,
    makeStorageKey,
    isTweetRecord,
    isSamePage,
    removedTweetIds,
    getRecordTime,
    advanceAttentionClock,
    isLooseTimeQuery,
    matchesLooseLocalTimeQuery
  });

  globalScope.XTweetRecall = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
