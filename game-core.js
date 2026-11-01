/*
 * 同词相遇 · 纯逻辑工具
 * 这个文件不依赖 DOM / CloudBase，可以直接在 Node 里做单元测试。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.TongciCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ROOM_MIN_LENGTH = 4;
  const ROOM_MAX_LENGTH = 6;
  const WORD_MAX_LENGTH = 20;
  const PROTOCOL_VERSION = 1;
  const APP_ID = "tongci";

  function normalizeRoomCode(value) {
    return String(value == null ? "" : value)
      .replace(/\D/g, "")
      .slice(0, ROOM_MAX_LENGTH);
  }

  function isValidRoomCode(value) {
    const code = normalizeRoomCode(value);
    return (
      code.length >= ROOM_MIN_LENGTH &&
      code.length <= ROOM_MAX_LENGTH &&
      code === String(value == null ? "" : value).trim()
    );
  }

  function randomInt(max) {
    if (max <= 0) return 0;
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const limit = Math.floor(0x100000000 / max) * max;
      const buf = new Uint32Array(1);
      let n;
      do {
        crypto.getRandomValues(buf);
        n = buf[0];
      } while (n >= limit);
      return n % max;
    }
    return Math.floor(Math.random() * max);
  }

  function generateRoomCode(length) {
    const len = Math.min(
      ROOM_MAX_LENGTH,
      Math.max(ROOM_MIN_LENGTH, Number(length) || 6)
    );
    let code = "";
    for (let i = 0; i < len; i += 1) code += String(randomInt(10));
    // 避免出现 0000 这类看起来像占位符的房间号。
    if (/^0+$/.test(code)) code = `1${code.slice(1)}`;
    return code;
  }

  function normalizeWord(value) {
    return String(value == null ? "" : value)
      .normalize("NFKC")
      .replace(/[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function wordLength(value) {
    return Array.from(normalizeWord(value)).length;
  }

  function isValidWord(value) {
    const word = normalizeWord(value);
    return word.length > 0 && wordLength(word) <= WORD_MAX_LENGTH;
  }

  // 仅用于判断“是否同词”：全半角归一、英文忽略大小写，显示仍保留原输入。
  function wordKey(value) {
    return normalizeWord(value).toLocaleLowerCase("zh-CN");
  }

  function sameWord(a, b) {
    const ka = wordKey(a);
    const kb = wordKey(b);
    return ka.length > 0 && ka === kb;
  }

  function formatRoomCode(value, separator) {
    const code = normalizeRoomCode(value);
    if (code.length < 6) return code;
    return `${code.slice(0, 3)}${separator == null ? " " : separator}${code.slice(3)}`;
  }

  function rateResult(rounds) {
    const n = Math.max(1, Number(rounds) || 1);
    if (n === 1) {
      return {
        key: "legend",
        title: "灵魂同频",
        short: "一轮命中",
        subtitle: "第一轮就写出了同一个词，这种默契不讲道理。",
        stamp: "SOULMATES",
      };
    }
    if (n === 2) {
      return {
        key: "bestie",
        title: "天选闺蜜",
        short: "两轮命中",
        subtitle: "只绕了一个弯就相遇，你们的大脑大概连着同一根线。",
        stamp: "BESTIES",
      };
    }
    if (n === 3) {
      return {
        key: "spark",
        title: "心有灵犀",
        short: "三轮命中",
        subtitle: "不多不少，刚好在第三个词遇见彼此。",
        stamp: "IN SYNC",
      };
    }
    if (n <= 5) {
      return {
        key: "warm",
        title: "默契在线",
        short: "稳稳靠近",
        subtitle: "绕了几个弯，但还是准确地走进了同一个词。",
        stamp: "WARM & CLOSE",
      };
    }
    if (n <= 8) {
      return {
        key: "growing",
        title: "渐入佳境",
        short: "正在对齐",
        subtitle: "你们的脑回路正在一点点靠近，下一局会更快。",
        stamp: "GETTING CLOSER",
      };
    }
    return {
      key: "practice",
      title: "还需磨合",
      short: "缘分绕了路",
      subtitle: "虽然走了很远，但最后还是相遇了，这本身就很浪漫。",
      stamp: "KEEP TRYING",
    };
  }

  function makeInviteUrl(href, roomCode, extraParams) {
    try {
      const url = new URL(href);
      url.search = "";
      url.hash = "";
      url.searchParams.set("room", normalizeRoomCode(roomCode));
      if (extraParams && typeof extraParams === "object") {
        Object.keys(extraParams).forEach(function (key) {
          if (extraParams[key] != null && extraParams[key] !== "") {
            url.searchParams.set(key, String(extraParams[key]));
          }
        });
      }
      return url.toString();
    } catch (err) {
      return href;
    }
  }

  function buildInviteText(roomCode, href, extraParams) {
    const url = makeInviteUrl(href, roomCode, extraParams);
    return [
      "来和我玩「同词相遇」吧！",
      `房间号：${normalizeRoomCode(roomCode)}`,
      `打开：${url}`,
      "两个人各写一个词，看看会不会在同一轮相遇。",
    ].join("\n");
  }

  function buildShareText(rounds, title, word) {
    const n = Math.max(1, Number(rounds) || 1);
    return [
      `我们在「同词相遇」里用了 ${n} 轮，写出了同一个词。`,
      `默契评价：${title || rateResult(n).title}`,
      `相遇词：「${normalizeWord(word) || "——"}」`,
      "来测测你们的默契：",
      typeof location !== "undefined" ? location.origin + location.pathname : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  function createEnvelope(type, fields) {
    return Object.assign(
      {
        app: APP_ID,
        v: PROTOCOL_VERSION,
        type,
        ts: Date.now(),
      },
      fields || {}
    );
  }

  function isEnvelope(value) {
    return (
      value &&
      typeof value === "object" &&
      value.app === APP_ID &&
      value.v === PROTOCOL_VERSION &&
      typeof value.type === "string" &&
      typeof value.from === "string" &&
      typeof value.room === "string"
    );
  }

  return {
    APP_ID,
    PROTOCOL_VERSION,
    ROOM_MIN_LENGTH,
    ROOM_MAX_LENGTH,
    WORD_MAX_LENGTH,
    normalizeRoomCode,
    isValidRoomCode,
    generateRoomCode,
    normalizeWord,
    wordLength,
    isValidWord,
    wordKey,
    sameWord,
    formatRoomCode,
    rateResult,
    makeInviteUrl,
    buildInviteText,
    buildShareText,
    createEnvelope,
    isEnvelope,
  };
});
