/*
 * ============================================================
 *  同词相遇 · 前端主逻辑
 * ============================================================
 *
 *  实时同步：Supabase Realtime Broadcast
 *  频道：room:<房间号>
 *  事件：game
 *
 *  防偷看协议（重点）：
 *  1. 提交时只广播 submit_status { round }，绝不携带词语。
 *  2. 只有当自己已提交 && 对方提交状态为 true 时，才广播 reveal { round, word }。
 *  3. 收到 reveal 时再次校验双方提交状态；否则在读取/保存词语前直接丢弃。
 *  4. join_accept / sync_state 快照在 input 阶段只包含“是否提交”，不包含任何未揭晓词语。
 *
 *  断线/重连：
 *  - 每 3 秒广播一次 heartbeat；12 秒未收到对方消息视为离线（只提示，不销毁房间）。
 *  - 刷新页面会用 sessionStorage 自动恢复；房主以快照同步，必要时重开当前轮。
 *  - 使用 Supabase Realtime，不依赖数据库，不依赖自建服务器。
 */
(function () {
  "use strict";

  const core = window.TongciCore;
  if (!core) {
    console.error("TongciCore 未加载");
    return;
  }

  // ---------- 配置与模式 ----------
  const RAW_CONFIG = window.TONGCI_CONFIG || {};
  const query = new URLSearchParams(window.location.search);
  const DEMO = query.get("demo") === "1";
  const DEBUG = query.get("debug") === "1";

  const CONFIG = (function readConfig() {
    const rawUrl = String(RAW_CONFIG.SUPABASE_URL || "").trim();
    const url = rawUrl.replace(/\/+$/, "");
    const key = String(RAW_CONFIG.SUPABASE_ANON_KEY || "").trim();
    const placeholder = /YOUR|PASTE|EXAMPLE|CHANGEME|XXXX/i;
    const validUrl = /^https?:\/\/[^\s/]+/i.test(url) && !placeholder.test(url);
    const validKey = key.length > 20 && !placeholder.test(key);
    return {
      url,
      key,
      ok: validUrl && validKey,
    };
  })();

  const SESSION_KEY = "tongci:session:v2";
  const PLAYER_KEY = "tongci:player:v1";
  const PROTOCOL = core.PROTOCOL_VERSION;

  const dom = {
    screens: Array.from(document.querySelectorAll("[data-screen]")),
    setupBanner: byId("setup-banner"),
    demoBanner: byId("demo-banner"),
    demoLink: byId("demo-link"),
    createBtn: byId("create-btn"),
    joinForm: byId("join-form"),
    joinCode: byId("join-code"),
    joinBtn: byId("join-btn"),
    homeError: byId("home-error"),
    waitingKicker: byId("waiting-kicker"),
    waitingTitle: byId("waiting-title"),
    waitingCopy: byId("waiting-copy"),
    waitingCode: byId("waiting-code"),
    waitingStatusText: byId("waiting-status-text"),
    waitingBackBtn: byId("waiting-back-btn"),
    shareBlock: byId("share-block"),
    shareUrl: byId("share-url"),
    copyCodeBtn: byId("copy-code-btn"),
    copyInviteBtn: byId("copy-invite-btn"),
    gameRoomCode: byId("game-room-code"),
    connectionBanner: byId("connection-banner"),
    connectionText: byId("connection-text"),
    roundNumber: byId("round-number"),
    gameKicker: byId("game-kicker"),
    gameTitle: byId("game-title"),
    gameSubtitle: byId("game-subtitle"),
    previousPanel: byId("previous-panel"),
    previousSelf: byId("previous-self"),
    previousPeer: byId("previous-peer"),
    inputPanel: byId("input-panel"),
    wordForm: byId("word-form"),
    wordInput: byId("word-input"),
    submitWordBtn: byId("submit-word-btn"),
    charCount: byId("char-count"),
    wordHint: byId("word-hint"),
    sealedState: byId("sealed-state"),
    sealedWord: byId("sealed-word"),
    playerStatus: byId("player-status"),
    selfStatus: byId("self-status"),
    peerStatus: byId("peer-status"),
    selfStatusDot: byId("self-status-dot"),
    peerStatusDot: byId("peer-status-dot"),
    gameNote: byId("game-note"),
    revealPanel: byId("reveal-panel"),
    revealEyebrow: byId("reveal-eyebrow"),
    revealTitle: byId("reveal-title"),
    revealSelf: byId("reveal-self"),
    revealPeer: byId("reveal-peer"),
    revealSymbol: byId("reveal-symbol"),
    revealMessage: byId("reveal-message"),
    revealNext: byId("reveal-next"),
    revealCountdown: byId("reveal-countdown"),
    showResultBtn: byId("show-result-btn"),
    resultWord: byId("result-word"),
    resultRounds: byId("result-rounds"),
    resultRating: byId("result-rating"),
    resultSubtitle: byId("result-subtitle"),
    resultStamp: byId("result-stamp"),
    rematchBtn: byId("rematch-btn"),
    shareBtn: byId("share-btn"),
    rulesDialog: byId("rules-dialog"),
    peerLeftDialog: byId("peer-left-dialog"),
    stayBtn: byId("stay-btn"),
    toast: byId("toast"),
    confetti: byId("confetti"),
  };

  function byId(id) {
    return document.getElementById(id);
  }

  // ---------- 应用状态 ----------
  const state = {
    screen: "home",
    room: "",
    role: null,
    selfId: getOrCreatePlayerId(),
    peerId: "",
    peerRole: null,
    peerJoined: false,
    peerOnline: false,
    peerLeft: false,
    peerLastSeen: 0,
    joinNonce: "",
    guestJoinNonce: "",
    transport: null,
    transportState: "idle",
    transportReadyOnce: false,
    game: createGame(),
    homeError: "",
    waitingSince: 0,
    resultShown: false,
    advanceAt: 0,
    lastSyncRequestAt: 0,
    lastRevealSentAt: 0,
    lastRevealedRound: 0,
    wireLog: [],
    leaving: false,
    sessionRestored: false,
    statusRetryTimer: 0,
    revealRetryTimer: 0,
    advanceTimer: 0,
    resultTimer: 0,
    revealTicker: 0,
    joinRetryTimer: 0,
    waitingHintTimer: 0,
    heartbeatTimer: 0,
    watchdogTimer: 0,
    toastTimer: 0,
    toastHideTimer: 0,
    revealScrollTimer: 0,
  };

  function createGame(phase) {
    return {
      phase: phase || "lobby",
      round: 1,
      selfWord: "",
      selfSubmitted: false,
      peerSubmitted: false,
      peerWord: "",
      lastPair: null,
      reveal: null,
      result: null,
      awaitingReveal: false,
    };
  }

  // ---------- 通用工具 ----------
  function pad2(n) {
    const value = Math.max(0, Number(n) || 0);
    return value < 10 ? `0${value}` : String(value);
  }

  function isTransportReady() {
    return state.transportState === "ready";
  }

  function canUseTransport() {
    if (DEMO) return typeof window.BroadcastChannel === "function";
    return CONFIG.ok && !!window.supabase;
  }

  function demoParams() {
    return DEMO ? { demo: "1" } : {};
  }

  function shareUrlForRoom() {
    return core.makeInviteUrl(window.location.href, state.room, demoParams());
  }

  function showToast(message, duration) {
    if (!message) return;
    window.clearTimeout(state.toastTimer);
    window.clearTimeout(state.toastHideTimer);
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    // 强制一帧，让进入动画重新播放。
    requestAnimationFrame(function () {
      dom.toast.classList.add("is-visible");
    });
    state.toastTimer = window.setTimeout(function () {
      dom.toast.classList.remove("is-visible");
      state.toastHideTimer = window.setTimeout(function () {
        dom.toast.hidden = true;
      }, 240);
    }, duration || 2400);
  }

  function setHomeError(message) {
    state.homeError = message || "";
    dom.homeError.textContent = state.homeError;
    dom.homeError.hidden = !state.homeError;
  }

  function clearHomeError() {
    setHomeError("");
  }

  function clearTimer(name) {
    if (state[name]) {
      window.clearTimeout(state[name]);
      window.clearInterval(state[name]);
      state[name] = 0;
    }
  }

  function clearRoundTimers() {
    clearTimer("statusRetryTimer");
    clearTimer("revealRetryTimer");
    clearTimer("advanceTimer");
    clearTimer("resultTimer");
    clearTimer("revealTicker");
    clearTimer("revealScrollTimer");
    state.advanceAt = 0;
  }

  function clearAllRoomTimers() {
    clearRoundTimers();
    clearTimer("joinRetryTimer");
    clearTimer("waitingHintTimer");
    clearTimer("heartbeatTimer");
    clearTimer("watchdogTimer");
  }

  function resetWordEntry() {
    dom.wordInput.value = "";
    dom.wordInput.disabled = false;
    dom.charCount.textContent = `0 / ${core.WORD_MAX_LENGTH}`;
  }

  function setPlayerId(id) {
    state.selfId = id;
    try {
      window.sessionStorage.setItem(PLAYER_KEY, id);
    } catch (err) {
      /* sessionStorage 被禁用时仍可在本次页面会话内工作 */
    }
  }

  function makeNonce() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function getOrCreatePlayerId() {
    try {
      const saved = window.sessionStorage.getItem(PLAYER_KEY);
      if (saved) return saved;
    } catch (err) {
      /* ignore */
    }
    let id;
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      id = window.crypto.randomUUID();
    } else {
      id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
    try {
      window.sessionStorage.setItem(PLAYER_KEY, id);
    } catch (err) {
      /* ignore */
    }
    return id;
  }

  // ---------- 页面切换 ----------
  function showScreen(name) {
    let found = false;
    const changed = state.screen !== name;
    dom.screens.forEach(function (screen) {
      const active = screen.dataset.screen === name;
      screen.hidden = !active;
      if (active) found = true;
    });
    if (!found) return;
    state.screen = name;
    document.body.dataset.screen = name;
    updateTopNotes();
    if (changed) window.scrollTo(0, 0);
    syncTitle();
  }

  function syncTitle() {
    let title = "同词相遇 · 两个人，一个词";
    if (state.room) {
      if (state.game.phase === "finished" && state.game.result) {
        title = `${state.game.result.rounds} 轮相遇 · 同词相遇`;
      } else if (state.game.phase === "lobby") {
        title = `房间 ${state.room} · 同词相遇`;
      } else if (state.screen === "game") {
        title = `第 ${state.game.round} 轮 · 同词相遇`;
      }
    }
    document.title = title;
  }

  function updateTopNotes() {
    const setupVisible = !DEMO && !canUseTransport();
    const demoVisible = DEMO;
    dom.setupBanner.hidden = !setupVisible;
    dom.demoBanner.hidden = !demoVisible;

    if (setupVisible) {
      const text = !window.supabase && CONFIG.ok
        ? "Supabase SDK 加载失败，请检查网络后刷新。"
        : "还没连接 Supabase。请先在 config.js 填入 Project URL 与 publishable / anon key。";
      const span = dom.setupBanner.querySelector("span");
      if (span) span.textContent = text;
    }

    document.body.classList.toggle("has-top-note", setupVisible || demoVisible);
  }

  function renderCurrentScreen() {
    if (!state.room) {
      showScreen("home");
      renderHome();
      return;
    }
    if (state.game.phase === "finished") {
      renderResult();
    } else if (state.game.phase === "lobby") {
      renderWaiting();
    } else {
      renderGame();
    }
  }

  // ---------- 首页 ----------
  function renderHome() {
    showScreen("home");
    updateTopNotes();
    setHomeError(state.homeError);
  }

  function ensureCanConnect() {
    if (DEMO && typeof window.BroadcastChannel !== "function") {
      setHomeError("当前浏览器不支持本地演示所需的 BroadcastChannel。");
      showToast("请换用较新的浏览器");
      return false;
    }
    if (!DEMO && !CONFIG.ok) {
      setHomeError(
        "还没有配置 Supabase。请打开 config.js 填入 Project URL 和 publishable / anon key；也可以先点顶部「本地演示」。"
      );
      showToast("请先完成 Supabase 配置");
      return false;
    }
    if (!DEMO && !window.supabase) {
      setHomeError("Supabase SDK 没有加载成功，请检查网络或 CDN 地址后刷新。");
      showToast("Supabase SDK 未加载");
      return false;
    }
    return true;
  }

  function createRoom() {
    clearHomeError();
    if (!ensureCanConnect()) return;

    if (state.transport) disconnectTransport(true);

    state.room = core.generateRoomCode(6);
    state.role = "host";
    state.peerId = "";
    state.peerRole = null;
    state.peerJoined = false;
    state.peerOnline = false;
    state.peerLeft = false;
    state.peerLastSeen = 0;
    state.joinNonce = "";
    state.guestJoinNonce = "";
    state.game = createGame("lobby");
    state.resultShown = false;
    state.advanceAt = 0;
    state.transportState = "connecting";
    state.transportReadyOnce = false;
    state.sessionRestored = false;
    state.waitingSince = Date.now();
    clearInviteQuery();

    saveSession();
    renderWaiting();
    connectToRoom(false);
  }

  function joinRoom() {
    clearHomeError();
    if (!ensureCanConnect()) return;

    const code = core.normalizeRoomCode(dom.joinCode.value);
    if (!core.isValidRoomCode(code)) {
      setHomeError("请输入 4–6 位数字房间号。");
      dom.joinCode.focus();
      return;
    }
    dom.joinCode.value = code;

    if (state.transport) disconnectTransport(true);

    state.room = code;
    state.role = "guest";
    state.peerId = "";
    state.peerRole = null;
    state.peerJoined = false;
    state.peerOnline = false;
    state.peerLeft = false;
    state.peerLastSeen = 0;
    state.joinNonce = "";
    state.guestJoinNonce = "";
    state.game = createGame("lobby");
    state.resultShown = false;
    state.advanceAt = 0;
    state.transportState = "connecting";
    state.transportReadyOnce = false;
    state.sessionRestored = false;
    state.waitingSince = Date.now();
    clearInviteQuery();

    saveSession();
    renderWaiting();
    connectToRoom(false);
  }

  function clearInviteQuery() {
    try {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("room")) return;
      url.searchParams.delete("room");
      window.history.replaceState(
        null,
        "",
        url.pathname + (url.search || "") + (url.hash || "")
      );
    } catch (err) {
      /* ignore */
    }
  }

  // ---------- 等待页 ----------
  function renderWaiting() {
    if (!state.room) {
      renderHome();
      return;
    }
    showScreen("waiting");
    const isHost = state.role === "host";
    dom.waitingKicker.textContent = isHost ? "ROOM IS OPEN" : "KNOCK KNOCK";
    dom.waitingTitle.textContent = isHost ? "等待对方加入" : "正在加入房间";
    dom.waitingCopy.textContent = isHost
      ? "把房间号发给 TA，或者直接发送邀请链接。"
      : "正在寻找这个房间，请让房主保持页面打开。";
    dom.waitingCode.textContent = core.formatRoomCode(state.room);
    dom.waitingBackBtn.textContent = isHost ? "取消，回到首页" : "取消加入";
    dom.shareBlock.hidden = !isHost;

    if (isHost) {
      dom.shareUrl.value = shareUrlForRoom();
    }

    let status = "";
    if (state.transportState === "connecting" || state.transportState === "idle") {
      status = "正在连接房间…";
    } else if (state.transportState === "error" || state.transportState === "closed") {
      status = "实时通道连接失败，请检查 Supabase 配置与网络";
    } else if (isHost) {
      status = state.peerJoined ? "对方已加入，正在同步…" : "正在等你的一位朋友…";
    } else {
      status = state.peerJoined ? "已进入房间，正在同步…" : "正在敲门，等待房主回应…";
    }

    if (
      !isHost &&
      !state.peerJoined &&
      state.waitingSince &&
      Date.now() - state.waitingSince > 15000
    ) {
      status = "还没有收到房主回应，请确认房间号与房主页面。";
    }

    dom.waitingStatusText.textContent = status;
    updateTopNotes();
    syncTitle();
  }

  // ---------- 游戏页 ----------
  function renderGame() {
    if (!state.room) {
      renderHome();
      return;
    }
    if (state.game.phase === "finished") {
      renderResult();
      return;
    }
    if (state.game.phase === "lobby") {
      renderWaiting();
      return;
    }

    showScreen("game");
    const game = state.game;
    const isReveal = game.phase === "reveal";

    dom.gameRoomCode.textContent = core.formatRoomCode(state.room);
    dom.roundNumber.textContent = pad2(game.round);

    if (game.round <= 1) {
      dom.gameKicker.textContent = "FIRST INSTINCT";
      dom.gameTitle.textContent = "凭直觉，写下一个词";
      dom.gameSubtitle.textContent = "不用想太多，第一个跳进脑海里的词就很好。";
    } else {
      dom.gameKicker.textContent = `ROUND ${pad2(game.round)} · ASSOCIATION`;
      dom.gameTitle.textContent = "用一个词，连接上一轮";
      dom.gameSubtitle.textContent = "不需要标准答案，写你最先想到的那个词。";
    }

    const showPrevious = game.round > 1 && !!game.lastPair && !isReveal;
    dom.previousPanel.hidden = !showPrevious;
    if (showPrevious) {
      dom.previousSelf.textContent = game.lastPair.self;
      dom.previousPeer.textContent = game.lastPair.peer;
    }

    dom.inputPanel.hidden = isReveal;
    dom.playerStatus.hidden = isReveal;

    if (!isReveal) {
      renderAnswerCard();
      renderPlayerStatus();
      renderConnectionBanner();
      renderGameNote();
      dom.revealPanel.hidden = true;
      dom.revealPanel.classList.remove("is-same");
    } else {
      dom.gameNote.textContent = "";
      renderReveal();
      renderConnectionBanner();
    }

    if (state.screen === "game") {
      // 保持页面标题随轮次变化。
      syncTitle();
    }
  }

  function renderAnswerCard() {
    const game = state.game;
    const submitted = game.selfSubmitted;

    dom.wordForm.classList.toggle("word-entry--waiting", submitted);
    dom.wordInput.hidden = submitted;
    dom.sealedState.hidden = !submitted;

    if (submitted) {
      dom.wordInput.value = game.selfWord;
      dom.sealedWord.textContent = game.selfWord;
      dom.submitWordBtn.disabled = true;
      dom.submitWordBtn.querySelector("span").textContent = game.peerSubmitted
        ? "等待同时揭晓"
        : "等待对方提交";
      dom.charCount.textContent = "已封存";
    } else {
      dom.wordInput.disabled = false;
      dom.submitWordBtn.disabled = !state.peerJoined;
      dom.submitWordBtn.querySelector("span").textContent = "就是这个词";
      dom.charCount.textContent = `${core.wordLength(dom.wordInput.value)} / ${core.WORD_MAX_LENGTH}`;
    }
    dom.wordHint.textContent =
      "提交后不可修改 · 对方提交前看不到你的词";
  }

  function renderPlayerStatus() {
    const game = state.game;

    dom.selfStatus.textContent = game.selfSubmitted ? "已提交" : "思考中";
    dom.selfStatus.classList.toggle("is-ready", game.selfSubmitted);
    dom.selfStatusDot.classList.toggle("is-ready", game.selfSubmitted);

    let peerText = "思考中";
    if (!state.peerJoined) peerText = "等待加入";
    else if (!state.peerOnline) peerText = "暂时离线";
    else if (game.peerSubmitted) peerText = "已提交";
    dom.peerStatus.textContent = peerText;
    dom.peerStatus.classList.toggle("is-ready", game.peerSubmitted);
    dom.peerStatusDot.classList.toggle("is-ready", game.peerSubmitted);
  }

  function renderConnectionBanner() {
    let text = "";
    let offline = false;

    if (
      state.transportState === "connecting" ||
      state.transportState === "idle"
    ) {
      text = "正在连接房间…";
    } else if (state.transportState === "error" || state.transportState === "closed") {
      text = "实时通道连接失败，请检查 Supabase 配置与网络，或刷新重试。";
      offline = true;
    } else if (state.peerLeft) {
      text = "对方已经离开了房间。";
      offline = true;
    } else if (state.peerJoined && !state.peerOnline) {
      text = "对方暂时离线，已经在等 TA 回来…";
      offline = true;
    }

    dom.connectionBanner.hidden = !text;
    dom.connectionText.textContent = text;
    dom.connectionBanner.classList.toggle("is-offline", offline);
  }

  function renderGameNote() {
    const game = state.game;
    let note = "";

    if (!state.peerJoined) {
      note = "正在等待对方加入房间…";
    } else if (state.transportState === "error" || state.transportState === "closed") {
      note = "网络正在重连，你的输入会保留。";
    } else if (game.selfSubmitted && game.peerSubmitted) {
      note = game.peerWord ? "" : "双方都已提交，正在同时揭晓…";
    } else if (game.selfSubmitted) {
      note = "答案已封存，等对方提交后同时揭晓。";
    } else if (game.peerSubmitted) {
      note = "对方已经提交了，轮到你了。";
    } else if (state.peerJoined && !state.peerOnline) {
      note = "对方暂时离线；你仍然可以提交，TA 回来后会同步。";
    }

    dom.gameNote.textContent = note;
  }

  function renderReveal() {
    const game = state.game;
    const reveal = game.reveal;
    if (!reveal) {
      dom.revealPanel.hidden = true;
      return;
    }

    dom.revealPanel.hidden = false;
    dom.revealPanel.classList.toggle("is-same", reveal.same);
    dom.revealEyebrow.textContent = reveal.same
      ? "MATCHED IN A WORD"
      : "THE MOMENT OF TRUTH";
    dom.revealTitle.textContent = reveal.same ? "同词相遇！" : "这次还没相遇";
    dom.revealSelf.textContent = reveal.self;
    dom.revealPeer.textContent = reveal.peer;
    dom.revealSymbol.textContent = reveal.same ? "=" : "×";
    dom.revealMessage.textContent = reveal.same
      ? `第 ${game.round} 轮，你们写出了同一个词。`
      : "两个词擦肩而过。第 " + (game.round + 1) + " 轮，继续靠近。";
    dom.revealNext.hidden = reveal.same;
    dom.showResultBtn.hidden = !reveal.same;
    dom.showResultBtn.disabled = !reveal.same;

    if (!reveal.same) {
      if (!state.peerOnline) {
        dom.revealCountdown.textContent = "等待对方重连后进入下一轮…";
      } else if (state.advanceAt) {
        const seconds = Math.max(0, Math.ceil((state.advanceAt - Date.now()) / 1000));
        dom.revealCountdown.textContent =
          seconds > 0
            ? `第 ${game.round + 1} 轮将在 ${seconds} 秒后开始…`
            : "正在进入下一轮…";
      } else {
        dom.revealCountdown.textContent = "即将进入下一轮…";
      }
    }

    if (state.lastRevealedRound !== game.round) {
      state.lastRevealedRound = game.round;
      clearTimer("revealScrollTimer");
      state.revealScrollTimer = window.setTimeout(function () {
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          dom.revealPanel.scrollIntoView({ block: "center" });
        } else {
          dom.revealPanel.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 120);
    }
  }

  function updateRevealCountdown() {
    if (state.game.phase !== "reveal" || !state.game.reveal || state.game.reveal.same) {
      return;
    }
    if (!state.peerOnline) {
      dom.revealCountdown.textContent = "等待对方重连后进入下一轮…";
      return;
    }
    if (state.advanceAt) {
      const seconds = Math.max(0, Math.ceil((state.advanceAt - Date.now()) / 1000));
      dom.revealCountdown.textContent =
        seconds > 0
          ? `第 ${state.game.round + 1} 轮将在 ${seconds} 秒后开始…`
          : "正在进入下一轮…";
    }
  }

  // ---------- 结算页 ----------
  function renderResult() {
    if (!state.room) {
      renderHome();
      return;
    }
    const game = state.game;
    if (game.phase !== "finished" || !game.result) {
      if (game.phase === "finished" && game.reveal && game.reveal.same) {
        // 兼容极少数从损坏/旧版 sessionStorage 恢复的情况。
        const rounds = Math.max(1, Number(game.round) || 1);
        game.result = {
          rounds: rounds,
          word: game.reveal.self,
          rating: core.rateResult(rounds),
        };
      } else if (game.phase === "finished") {
        // 没有可恢复的结算数据时，退回第 1 轮而不是递归渲染。
        state.game = createGame("input");
        resetWordEntry();
        renderGame();
        return;
      } else {
        renderGame();
        return;
      }
    }

    showScreen("result");
    const result = game.result;
    const rating = result.rating || core.rateResult(result.rounds);

    dom.resultWord.textContent = result.word || "—";
    dom.resultRounds.textContent = pad2(result.rounds);
    dom.resultRating.textContent = rating.title;
    dom.resultSubtitle.textContent = rating.subtitle;
    dom.resultStamp.textContent = rating.stamp;

    if (!state.resultShown) {
      state.resultShown = true;
      launchConfetti();
    }

    updateTopNotes();
    syncTitle();
  }

  // ---------- 连接层 ----------
  function connectToRoom(isResume) {
    state.transportState = "connecting";
    state.transportReadyOnce = false;
    state.sessionRestored = !!isResume;
    state.joinNonce = state.role === "guest" ? makeNonce() : "";
    state.guestJoinNonce = "";
    renderCurrentScreen();

    let transport;
    try {
      transport = DEMO
        ? new DemoTransport({
            room: state.room,
            onMessage: handleIncoming,
            onStatus: handleTransportStatus,
          })
        : new SupabaseTransport({
            room: state.room,
            onMessage: handleIncoming,
            onStatus: handleTransportStatus,
          });
      state.transport = transport;
      transport.connect();
    } catch (err) {
      console.error(err);
      state.transportState = "error";
      showToast("无法连接实时频道，请检查配置");
      renderCurrentScreen();
    }
  }

  function disconnectTransport(silent) {
    const transport = state.transport;
    state.transport = null;
    state.transportState = "idle";
    if (transport) {
      try {
        transport.disconnect();
      } catch (err) {
        /* ignore */
      }
    }
  }

  function handleTransportStatus(status, detail) {
    if (state.leaving || !state.room) return;
    if (status === "ready") {
      const firstReady = !state.transportReadyOnce;
      state.transportReadyOnce = true;
      state.transportState = "ready";

      if (firstReady) {
        startHeartbeat();
      }

      // 每次重新订阅成功都重新打招呼；Supabase 断线重连后尤其重要。
      sendHello();

      if (state.role === "host") {
        if (state.game.phase !== "lobby" && state.peerId) {
          window.setTimeout(function () {
            if (isTransportReady() && state.role === "host" && state.peerId) {
              sendSnapshot("sync_state");
            }
          }, 300);
        }

        if (
          state.game.phase === "input" &&
          (state.game.selfSubmitted || state.game.peerSubmitted) &&
          state.sessionRestored
        ) {
          hostResetRound("重新连接，本轮重新开始");
        }
      } else if (state.role === "guest") {
        startJoinRetry();
      }

      state.sessionRestored = false;
      renderCurrentScreen();
      return;
    }

    if (status === "error" || status === "closed") {
      if (state.leaving) return;
      state.transportState = status === "closed" ? "closed" : "error";
      if (state.peerOnline) {
        state.peerOnline = false;
      }
      renderCurrentScreen();
      if (state.screen !== "home") {
        showToast("实时通道连接失败，请检查 Supabase 配置与网络", 4200);
      }
      if (DEBUG && detail) {
        state.wireLog.push({ dir: "status", type: status, detail: String(detail), ts: Date.now() });
      }
    }
  }

  function startHeartbeat() {
    clearTimer("heartbeatTimer");
    clearTimer("watchdogTimer");
    sendHeartbeat();
    state.heartbeatTimer = window.setInterval(sendHeartbeat, 3000);
    state.watchdogTimer = window.setInterval(runWatchdog, 1500);
  }

  function sendHeartbeat() {
    if (!isTransportReady() || !state.room) return;
    send(
      "heartbeat",
      {
        phase: state.game.phase,
        round: state.game.round,
        started: state.game.phase !== "lobby",
        submitted: state.game.selfSubmitted,
      },
      { silent: true }
    );
  }

  function runWatchdog() {
    if (!state.room) return;
    const now = Date.now();

    if (
      state.peerJoined &&
      state.peerOnline &&
      state.peerLastSeen &&
      now - state.peerLastSeen > 12000
    ) {
      state.peerOnline = false;
      showToast("对方暂时离线，正在等待重连…", 2600);
      renderCurrentScreen();
    }

    if (state.game.phase === "reveal") {
      if (!state.game.reveal || !state.game.reveal.same) {
        updateRevealCountdown();
        if (
          state.role === "host" &&
          state.peerOnline &&
          state.advanceAt &&
          now >= state.advanceAt
        ) {
          advanceRound();
        }
      }
    }

    if (
      state.game.phase === "input" &&
      state.game.selfSubmitted &&
      state.game.peerSubmitted &&
      !state.game.reveal &&
      state.peerOnline &&
      now - state.lastRevealSentAt > 2500
    ) {
      // 双方状态都到了，但词还没出现：重发自己的 reveal，并请求一次同步。
      sendReveal();
      requestSync();
    }
  }

  // ---------- 消息发送 ----------
  function send(type, fields, options) {
    if (!isTransportReady() || !state.transport) return Promise.resolve(false);
    const opts = options || {};
    const payload = Object.assign(
      {
        app: core.APP_ID,
        v: PROTOCOL,
        room: state.room,
        from: state.selfId,
        role: state.role,
        type: type,
        ts: Date.now(),
      },
      opts.to ? { to: opts.to } : {},
      fields || {}
    );

    logWire("out", payload);

    try {
      const result = state.transport.send(payload);
      if (result && typeof result.catch === "function") {
        return result
          .then(function (ok) {
            if (!ok && !opts.silent) {
              showToast("消息发送失败，正在重试…");
            }
            return !!ok;
          })
          .catch(function (err) {
            if (!opts.silent) {
              console.warn("Broadcast 发送失败", err);
              showToast("消息发送失败，请检查网络");
            }
            return false;
          });
      }
      return Promise.resolve(true);
    } catch (err) {
      if (!opts.silent) console.warn("Broadcast 发送异常", err);
      return Promise.resolve(false);
    }
  }

  function logWire(dir, message) {
    if (!DEBUG) return;
    state.wireLog.push({
      dir: dir,
      type: message.type,
      from: message.role,
      round: message.round,
      hasWord: typeof message.word === "string",
      hasSnapshot: !!message.snapshot,
      ts: Date.now(),
    });
    if (state.wireLog.length > 240) state.wireLog.shift();
  }

  function sendHello() {
    send(
      "hello",
      {
        phase: state.game.phase,
        round: state.game.round,
        started: state.game.phase !== "lobby",
        resume: state.sessionRestored,
        nonce: state.joinNonce || undefined,
      },
      { silent: true }
    );
  }

  function startJoinRetry() {
    clearTimer("joinRetryTimer");
    clearTimer("waitingHintTimer");

    // 第一次加入：持续敲门，直到房主接受。
    if (!state.peerJoined) {
      sendJoinRequest();
      state.joinRetryTimer = window.setInterval(function () {
        if (!state.peerJoined && state.role === "guest") {
          sendJoinRequest();
        } else if (state.peerJoined) {
          clearTimer("joinRetryTimer");
        }
      }, 1800);

      state.waitingHintTimer = window.setTimeout(function () {
        if (!state.peerJoined) renderWaiting();
      }, 15500);
      return;
    }

    if (state.sessionRestored) {
      // 页面刷新：本地可能丢失了提交内容，请房主下发快照并按需重开本轮。
      sendJoinRequest(true);
      state.joinRetryTimer = window.setTimeout(function () {
        if (state.peerJoined && state.role === "guest" && state.game.phase === "lobby") {
          sendJoinRequest(true);
        }
      }, 1800);
      return;
    }

    // 只是 WebSocket 短暂重连：保留当前轮，只交换“谁提交了”的状态。
    sendGuestState();
    requestSync();
  }

  function sendJoinRequest(force) {
    if (state.role !== "guest") return;
    if (state.peerJoined && !force && !state.sessionRestored) return;
    send(
      "join_request",
      {
        resume: state.sessionRestored || !!force,
        round: state.game.round,
        phase: state.game.phase,
        submitted: state.game.selfSubmitted,
        nonce: state.joinNonce || undefined,
      },
      { silent: true }
    );
  }

  function stopJoinRetry() {
    clearTimer("joinRetryTimer");
    clearTimer("waitingHintTimer");
  }

  function sendSubmitStatus() {
    if (!state.peerId || !state.game.selfSubmitted) return;
    // 关键：这里只发送“我已提交”和轮次，绝不发送 selfWord。
    send(
      "submit_status",
      { round: state.game.round },
      { to: state.peerId, silent: true }
    );
  }

  function scheduleStatusRetry() {
    clearTimer("statusRetryTimer");
    let attempt = 0;
    state.statusRetryTimer = window.setTimeout(function retry() {
      if (
        state.game.phase !== "input" ||
        !state.game.selfSubmitted ||
        state.game.peerSubmitted ||
        !state.peerId
      ) {
        return;
      }
      sendSubmitStatus();
      attempt += 1;
      if (attempt < 5) {
        state.statusRetryTimer = window.setTimeout(retry, 2000);
      }
    }, 1200);
  }

  function sendReveal() {
    if (
      state.game.phase !== "input" ||
      !state.game.selfSubmitted ||
      !state.game.peerSubmitted ||
      !state.game.selfWord ||
      state.game.reveal
    ) {
      return;
    }
    state.lastRevealSentAt = Date.now();
    // 只有双方提交状态都为 true 才会走到这里，此时广播词语才安全。
    send(
      "reveal",
      { round: state.game.round, word: state.game.selfWord },
      { to: state.peerId, silent: true }
    );

    clearTimer("revealRetryTimer");
    let attempt = 0;
    state.revealRetryTimer = window.setTimeout(function retry() {
      if (
        state.game.phase === "input" &&
        !state.game.peerWord &&
        state.game.selfSubmitted &&
        state.game.peerSubmitted
      ) {
        state.lastRevealSentAt = Date.now();
        send(
          "reveal",
          { round: state.game.round, word: state.game.selfWord },
          { to: state.peerId, silent: true }
        );
        attempt += 1;
        if (attempt < 5) {
          state.revealRetryTimer = window.setTimeout(retry, 2000);
        }
      }
    }, 1600);
  }

  function maybeReveal() {
    const game = state.game;
    game.awaitingReveal = !!(game.selfSubmitted && game.peerSubmitted && !game.reveal);
    if (!game.awaitingReveal) return;
    renderGameNote();
    if (!game.peerWord) {
      if (Date.now() - state.lastRevealSentAt > 500) {
        sendReveal();
      } else if (!state.revealRetryTimer) {
        state.revealRetryTimer = window.setTimeout(sendReveal, 800);
      }
    }
  }

  function requestSync() {
    if (!state.peerId) return;
    const now = Date.now();
    if (now - state.lastSyncRequestAt < 1200) return;
    state.lastSyncRequestAt = now;
    send(
      "sync_request",
      { round: state.game.round, phase: state.game.phase },
      { to: state.peerId, silent: true }
    );
  }

  function sendSnapshot(type) {
    if (state.role !== "host" || !state.peerId) return;
    send(
      type || "sync_state",
      { snapshot: makeSnapshot(), roundReset: false },
      { to: state.peerId, silent: true }
    );
  }

  function makeSnapshot(roundReset) {
    const game = state.game;
    const hasReveal =
      (game.phase === "reveal" || game.phase === "finished") && !!game.reveal;
    return {
      started: game.phase === "input" || game.phase === "reveal" || game.phase === "finished",
      round: game.round,
      phase: game.phase,
      hostSubmitted: !!game.selfSubmitted,
      guestSubmitted: !!game.peerSubmitted,
      roundReset: !!roundReset,
      lastPair: game.lastPair
        ? {
            round: game.lastPair.round,
            host: game.lastPair.self,
            guest: game.lastPair.peer,
          }
        : null,
      // 输入阶段绝不放入任何“本轮词语”。只有已经揭晓的轮次才允许带词。
      reveal: hasReveal
        ? {
            round: game.round,
            host: game.reveal.self,
            guest: game.reveal.peer,
          }
        : null,
      result:
        game.phase === "finished" && game.result
          ? { rounds: game.result.rounds, word: game.result.word }
          : null,
    };
  }

  function sendGuestState() {
    if (state.role !== "guest" || !state.peerId) return;
    send(
      "guest_state",
      {
        round: state.game.round,
        phase: state.game.phase,
        submitted: state.game.selfSubmitted,
        lastPair: state.game.lastPair
          ? {
              round: state.game.lastPair.round,
              host: state.game.lastPair.peer,
              guest: state.game.lastPair.self,
            }
          : null,
      },
      { to: state.peerId, silent: true }
    );
  }

  // ---------- 消息接收 ----------
  function handleIncoming(raw) {
    if (!core.isEnvelope(raw)) return;
    if (raw.room !== state.room) return;
    if (raw.from === state.selfId) return;
    if (raw.to && raw.to !== state.selfId) return;

    logWire("in", raw);

    // 对方活动时间 / 上线状态
    if (state.peerId && raw.from === state.peerId) {
      const wasOnline = state.peerOnline;
      state.peerLastSeen = Date.now();
      state.peerOnline = true;
      state.peerLeft = false;
      if (!wasOnline && state.peerJoined) {
        if (dom.peerLeftDialog && dom.peerLeftDialog.open) {
          dom.peerLeftDialog.close();
        }
        showToast("对方已重新连接");
        afterPeerBack();
        renderCurrentScreen();
      }
    }

    switch (raw.type) {
      case "hello":
        handleHello(raw);
        break;
      case "join_request":
        handleJoinRequest(raw);
        break;
      case "join_accept":
        handleJoinAccept(raw);
        break;
      case "join_ack":
        handleJoinAck(raw);
        break;
      case "room_full":
        handleRoomFull(raw);
        break;
      case "submit_status":
        handleSubmitStatus(raw);
        break;
      case "reveal":
        handleReveal(raw);
        break;
      case "heartbeat":
        handleHeartbeat(raw);
        break;
      case "sync_request":
        handleSyncRequest(raw);
        break;
      case "sync_state":
        handleSyncState(raw);
        break;
      case "guest_state":
        handleGuestState(raw);
        break;
      case "next_round":
        handleNextRound(raw);
        break;
      case "round_reset":
        handleRoundReset(raw);
        break;
      case "round_reset_request":
        handleRoundResetRequest(raw);
        break;
      case "rematch":
        handleRematch(raw);
        break;
      case "rematch_start":
        handleRematchStart(raw);
        break;
      case "leave":
        handlePeerLeave(raw);
        break;
      default:
        break;
    }
  }

  function handleHello(msg) {
    if (msg.type !== "hello") return;

    if (state.role === "host" && msg.role === "guest") {
      // 真正的入房必须走 join_request（含 nonce），不能只凭 hello 占座。
      if (!state.peerId) return;
      if (msg.from !== state.peerId) {
        send(
          "room_full",
          { joinNonce: msg.nonce || undefined },
          { to: msg.from, silent: true }
        );
        return;
      }
      markPeerJoined();
      if (state.game.phase !== "lobby") {
        window.setTimeout(function () {
          if (isTransportReady()) sendSnapshot("sync_state");
        }, 120);
      }
      return;
    }

    if (state.role === "guest" && msg.role === "host") {
      if (!state.peerId) {
        // 还没收到带 nonce 的 join_accept，不把任意 hello 当成房主。
        sendJoinRequest();
        return;
      }
      if (msg.from !== state.peerId) return;
      if (!state.peerOnline) {
        state.peerOnline = true;
        state.peerLastSeen = Date.now();
      }
      if (!state.peerJoined) {
        sendJoinRequest();
      } else {
        renderCurrentScreen();
        requestSync();
      }
    }
  }

  function handleJoinRequest(msg) {
    if (state.role !== "host") return;
    if (msg.role !== "guest" && msg.type !== "join_request") return;

    if (state.peerId && state.peerId !== msg.from) {
      send(
        "room_full",
        {
          reason: "这个房间已经有两位玩家了",
          joinNonce: msg.nonce || undefined,
        },
        { to: msg.from, silent: true }
      );
      return;
    }

    const wasStarted = state.game.phase !== "lobby";
    const wasPeerOnline =
      state.peerOnline &&
      state.peerLastSeen &&
      Date.now() - state.peerLastSeen < 12000;
    const isRejoin =
      wasStarted &&
      (msg.resume === true ||
        !wasPeerOnline ||
        (msg.round && msg.round !== state.game.round));

    state.peerId = msg.from;
    state.peerRole = "guest";
    state.peerJoined = true;
    state.peerOnline = true;
    state.peerLastSeen = Date.now();
    state.peerLeft = false;
    state.guestJoinNonce = typeof msg.nonce === "string" ? msg.nonce : "";
    stopJoinRetry();

    let didReset = false;
    if (!wasStarted) {
      state.game = createGame("input");
      state.resultShown = false;
      state.lastRevealedRound = 0;
      resetWordEntry();
      showToast("对方已加入，开始第 1 轮");
    } else if (
      isRejoin &&
      state.game.phase === "input" &&
      (state.game.selfSubmitted ||
        state.game.peerSubmitted ||
        msg.submitted === true ||
        (msg.round && msg.round !== state.game.round))
    ) {
      // 重连时若本轮已经有提交，重开本轮最稳妥，也不会泄露任何未揭晓的词。
      resetCurrentRoundLocal();
      didReset = true;
    }

    if (isRejoin) {
      showToast(didReset ? "对方重新加入，本轮重新开始" : "对方已重新连接");
    }

    send(
      "join_accept",
      {
        snapshot: makeSnapshot(didReset),
        roundReset: didReset,
        joinNonce: state.guestJoinNonce || undefined,
      },
      { to: msg.from, silent: true }
    );

    if (didReset) {
      window.setTimeout(function () {
        if (isTransportReady() && state.peerId) {
          send(
            "round_reset",
            {
              round: state.game.round,
              reason: "对方重新加入，本轮重新开始",
              lastPair: state.game.lastPair
                ? {
                    round: state.game.lastPair.round,
                    host: state.game.lastPair.self,
                    guest: state.game.lastPair.peer,
                  }
                : null,
            },
            { to: state.peerId, silent: true }
          );
        }
      }, 240);
    }

    state.waitingSince = 0;
    saveSession();
    renderCurrentScreen();
  }

  function markPeerJoined() {
    state.peerJoined = true;
    state.peerOnline = true;
    state.peerLastSeen = Date.now();
    stopJoinRetry();
    renderCurrentScreen();
  }

  function handleJoinAccept(msg) {
    if (state.role !== "guest" || msg.role !== "host") return;

    // 已经建立连接后，只认当前房主；避免被第三方 join_accept 中途顶替。
    if (state.peerJoined && state.peerId && msg.from !== state.peerId) return;
    // join nonce 必须是本次敲门时带出去的随机值。
    if (state.joinNonce && msg.joinNonce !== state.joinNonce) return;

    if (!msg.snapshot) {
      requestSync();
      return;
    }

    state.peerId = msg.from;
    state.peerRole = "host";
    state.peerJoined = true;
    state.peerOnline = true;
    state.peerLastSeen = Date.now();
    state.peerLeft = false;
    state.waitingSince = 0;
    stopJoinRetry();

    const snapshot = msg.snapshot;
    applySnapshot(snapshot);

    send(
      "join_ack",
      {
        round: state.game.round,
        phase: state.game.phase,
        submitted: state.game.selfSubmitted,
      },
      { to: state.peerId, silent: true }
    );

    if (snapshot.roundReset) {
      showToast("房间已同步，本轮重新开始");
    }

    saveSession();
    renderCurrentScreen();
  }

  function handleJoinAck(msg) {
    if (state.role !== "host") return;
    if (msg.from !== state.peerId) return;
    markPeerJoined();

    if (state.game.phase === "lobby") {
      state.game = createGame("input");
      state.lastRevealedRound = 0;
      resetWordEntry();
      saveSession();
      renderCurrentScreen();
      sendSnapshot("sync_state");
    }
  }

  function handleRoomFull(msg) {
    if (state.role !== "guest" || msg.role !== "host") return;
    // 只处理“尚未进入房间”时的拒绝；进入后不再接受第三方伪造的 room_full。
    if (state.peerJoined) return;
    if (state.joinNonce && msg.joinNonce !== state.joinNonce) return;
    state.leaving = true;
    stopJoinRetry();
    disconnectTransport(true);
    clearAllRoomTimers();
    clearSession();
    const reason = (msg && msg.reason) || "房间已满，或房间号已失效。";
    resetToLocalHome();
    state.leaving = false;
    setHomeError(reason + " 请让房主重新创建一个房间。");
    renderHome();
    showToast("无法加入这个房间");
  }

  function handleSubmitStatus(msg) {
    if (msg.from !== state.peerId) return;
    if (msg.round !== state.game.round) {
      requestSync();
      return;
    }
    if (state.game.phase === "finished") return;
    if (state.game.phase !== "input" && state.game.phase !== "reveal") return;

    if (!state.game.peerSubmitted) {
      state.game.peerSubmitted = true;
      clearTimer("statusRetryTimer");
      saveSession();
      renderCurrentScreen();
    }

    if (state.game.phase === "input") {
      maybeReveal();
    }
  }

  function handleReveal(msg) {
    if (msg.from !== state.peerId) return;
    if (msg.round !== state.game.round) return;
    if (state.game.phase !== "input") return;

    // ===== 防偷看核心校验 =====
    // 在读取 msg.word 之前，先确认“自己已提交”与“对方已提交”都为 true。
    // 如果对方提前发来词语，这里直接丢弃，不保存、不展示。
    if (!state.game.selfSubmitted || !state.game.peerSubmitted) {
      if (DEBUG) state.wireLog.push({ dir: "guard", type: "reveal_dropped", ts: Date.now() });
      return;
    }

    const peerWord = core.normalizeWord(msg.word);
    if (!peerWord || !core.isValidWord(peerWord)) return;

    clearTimer("revealRetryTimer");
    clearTimer("statusRetryTimer");
    state.game.peerWord = peerWord;
    state.game.phase = "reveal";
    state.game.awaitingReveal = false;
    state.game.reveal = {
      self: state.game.selfWord,
      peer: peerWord,
      same: core.sameWord(state.game.selfWord, peerWord),
      round: state.game.round,
    };
    state.lastRevealedRound = 0;
    clearRoundTimersExceptReveal();
    saveSession();
    renderCurrentScreen();

    if (state.game.reveal.same) {
      scheduleFinish();
    } else {
      state.advanceAt = Date.now() + 5200;
      if (state.role === "host") {
        scheduleAdvance(5200);
      } else {
        startRevealTicker();
        window.setTimeout(function () {
          if (
            state.role === "guest" &&
            state.game.phase === "reveal" &&
            state.game.reveal &&
            !state.game.reveal.same
          ) {
            requestSync();
          }
        }, 6200);
      }
    }
  }

  function clearRoundTimersExceptReveal() {
    clearTimer("statusRetryTimer");
    clearTimer("revealRetryTimer");
    clearTimer("advanceTimer");
    clearTimer("resultTimer");
  }

  function handleHeartbeat(msg) {
    if (state.role === "host") {
      if (!state.peerId) return;
      if (msg.from !== state.peerId) return;
      if (!state.peerJoined) {
        state.peerJoined = true;
      }
      if (msg.round !== state.game.round && state.game.phase !== "lobby") {
        // 房主以自己为权威，发快照纠正。
        sendSnapshot("sync_state");
        return;
      }
      if (
        msg.submitted === true &&
        state.game.phase === "input" &&
        msg.round === state.game.round &&
        !state.game.peerSubmitted
      ) {
        // 心跳中的 submitted 只是“已提交”布尔值，不包含词语。
        state.game.peerSubmitted = true;
        clearTimer("statusRetryTimer");
        saveSession();
        renderCurrentScreen();
        maybeReveal();
      }
      return;
    }

    // 房主心跳
    if (msg.role !== "host") return;
    if (!state.peerId) {
      // 还没通过带 nonce 的 join_accept 确认房主，只继续敲门。
      sendJoinRequest();
      return;
    }
    if (msg.from !== state.peerId) return;

    if (!state.peerJoined) {
      sendJoinRequest();
      return;
    }

    if (msg.started && state.game.phase === "lobby") {
      sendJoinRequest();
      return;
    }

    if (
      state.game.phase !== "lobby" &&
      (msg.round !== state.game.round || msg.phase !== state.game.phase)
    ) {
      requestSync();
      return;
    }

    // 心跳里携带的是“是否提交”，没有词语，可以作为状态消息的补偿。
    if (
      msg.submitted === true &&
      state.game.phase === "input" &&
      msg.round === state.game.round &&
      !state.game.peerSubmitted
    ) {
      state.game.peerSubmitted = true;
      clearTimer("statusRetryTimer");
      saveSession();
      renderCurrentScreen();
      maybeReveal();
    }
  }

  function handleSyncRequest(msg) {
    if (msg.from !== state.peerId && state.peerId) return;

    if (state.role === "host") {
      sendSnapshot("sync_state");
      return;
    }

    // 客人只能发送“状态”，绝不发送未揭晓词语。
    sendGuestState();
    if (
      state.game.phase === "input" &&
      state.game.selfSubmitted &&
      state.game.peerSubmitted &&
      !state.game.peerWord
    ) {
      sendReveal();
    }
  }

  function handleSyncState(msg) {
    if (state.role !== "guest") return;
    if (msg.from !== state.peerId) return;
    if (!msg.snapshot) return;

    state.peerJoined = true;
    state.peerOnline = true;
    state.peerLastSeen = Date.now();
    stopJoinRetry();
    applySnapshot(msg.snapshot);
    // 注意：同步快照不回复 join_ack，避免 join_ack ↔ sync_state 无限回环。
    saveSession();
    renderCurrentScreen();
    if (msg.snapshot.roundReset) {
      showToast("房间已同步，本轮重新开始");
    }
  }

  function handleGuestState(msg) {
    if (state.role !== "host") return;
    if (msg.from !== state.peerId) return;

    if (
      state.game.phase === "input" &&
      (msg.submitted === true ||
        state.game.selfSubmitted ||
        state.game.peerSubmitted ||
        msg.round !== state.game.round)
    ) {
      if (msg.submitted === true && !state.game.peerSubmitted) {
        // 客人说它提交过，但房主这边没有这个词（可能刚重连）：
        // 为了避免一方永远等待，直接重开当前轮。词语不会因此泄露。
        resetCurrentRoundLocal();
        send(
          "round_reset",
          {
            round: state.game.round,
            reason: "重新同步，本轮重新开始",
            lastPair: state.game.lastPair
              ? {
                  round: state.game.lastPair.round,
                  host: state.game.lastPair.self,
                  guest: state.game.lastPair.peer,
                }
              : null,
          },
          { to: state.peerId, silent: true }
        );
        saveSession();
        renderCurrentScreen();
        showToast("已重新同步本轮");
        return;
      }
    }

    if (state.game.phase !== "lobby") {
      sendSnapshot("sync_state");
    }
  }

  function handleNextRound(msg) {
    if (state.role !== "guest") return;
    if (msg.from !== state.peerId) return;
    if (!msg.round || msg.round <= state.game.round) return;

    clearRoundTimers();
    state.game.round = Number(msg.round);
    state.game.phase = "input";
    state.game.selfWord = "";
    state.game.selfSubmitted = false;
    state.game.peerSubmitted = false;
    state.game.peerWord = "";
    state.game.reveal = null;
    state.game.awaitingReveal = false;
    state.game.lastPair = mapLastPair(msg.lastPair);
    state.lastRevealedRound = 0;
    state.advanceAt = 0;
    resetWordEntry();
    saveSession();
    renderCurrentScreen();
    showToast(`第 ${state.game.round} 轮开始`);
    window.scrollTo(0, 0);
  }

  function handleRoundReset(msg) {
    if (msg.from !== state.peerId) return;
    if (msg.round !== state.game.round) return;
    if (state.game.phase !== "input") return;

    state.game.selfWord = "";
    state.game.selfSubmitted = false;
    state.game.peerSubmitted = false;
    state.game.peerWord = "";
    state.game.reveal = null;
    state.game.awaitingReveal = false;
    if (msg.lastPair) state.game.lastPair = mapLastPair(msg.lastPair);
    clearRoundTimers();
    resetWordEntry();
    saveSession();
    renderCurrentScreen();
    showToast(msg.reason || "本轮重新开始");
  }

  function handleRoundResetRequest(msg) {
    if (state.role !== "host") return;
    if (msg.from !== state.peerId) return;
    if (state.game.phase !== "input") {
      sendSnapshot("sync_state");
      return;
    }
    resetCurrentRoundLocal();
    send(
      "round_reset",
      {
        round: state.game.round,
        reason: "同步数据，本轮重新开始",
        lastPair: state.game.lastPair
          ? {
              round: state.game.lastPair.round,
              host: state.game.lastPair.self,
              guest: state.game.lastPair.peer,
            }
          : null,
      },
      { to: state.peerId, silent: true }
    );
    sendSnapshot("sync_state");
    saveSession();
    renderCurrentScreen();
  }

  function handleRematch(msg) {
    if (msg.from !== state.peerId) return;
    if (state.game.phase !== "finished") return;
    resetForRematch();
    showToast("对方发起了新的一局");
    if (state.role === "host") {
      send(
        "rematch_start",
        { round: 1 },
        { to: state.peerId, silent: true }
      );
    }
    saveSession();
    renderCurrentScreen();
  }

  function handleRematchStart(msg) {
    if (state.role !== "guest") return;
    if (msg.from !== state.peerId) return;
    if (state.game.phase === "input" && state.game.round === 1) return;
    resetForRematch();
    saveSession();
    renderCurrentScreen();
    showToast("新的一局开始了");
  }

  function handlePeerLeave(msg) {
    if (msg.from !== state.peerId) return;
    state.peerLeft = true;
    state.peerOnline = false;
    clearRoundTimers();
    renderCurrentScreen();
    if (
      dom.peerLeftDialog &&
      !dom.peerLeftDialog.open &&
      state.screen !== "home"
    ) {
      if (typeof dom.peerLeftDialog.showModal === "function") {
        dom.peerLeftDialog.showModal();
      }
    }
  }

  function afterPeerBack() {
    if (state.game.phase === "input") {
      if (state.game.selfSubmitted) sendSubmitStatus();
      if (state.game.selfSubmitted && state.game.peerSubmitted) sendReveal();
    } else if (
      state.game.phase === "reveal" &&
      state.game.reveal &&
      !state.game.reveal.same &&
      state.role === "host"
    ) {
      scheduleAdvance(Math.max(1200, state.advanceAt - Date.now()));
    }
  }

  // ---------- 快照与轮次 ----------
  function mapLastPair(pair) {
    if (!pair || !pair.host || !pair.guest) return null;
    if (state.role === "guest") {
      return {
        self: pair.guest,
        peer: pair.host,
        round: Number(pair.round) || Math.max(1, state.game.round - 1),
      };
    }
    return {
      self: pair.host,
      peer: pair.guest,
      round: Number(pair.round) || Math.max(1, state.game.round - 1),
    };
  }

  function applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    const game = state.game;
    const previousRound = game.round;
    const round = Math.max(1, Number(snapshot.round) || 1);
    const roundChanged = round !== previousRound;

    game.round = round;
    game.lastPair = mapLastPair(snapshot.lastPair);

    if (!snapshot.started || snapshot.phase === "lobby") {
      game.phase = "lobby";
      game.selfWord = "";
      game.selfSubmitted = false;
      game.peerSubmitted = false;
      game.peerWord = "";
      game.reveal = null;
      game.result = null;
      resetWordEntry();
      return;
    }

    if (snapshot.phase === "input") {
      game.phase = "input";
      game.reveal = null;
      game.result = null;
      game.peerWord = "";
      game.awaitingReveal = false;

      // 房主视角：hostSubmitted 是对方，guestSubmitted 是自己。
      game.peerSubmitted = !!snapshot.hostSubmitted;
      game.selfSubmitted = !!snapshot.guestSubmitted;

      if (snapshot.roundReset) {
        game.selfWord = "";
        game.selfSubmitted = false;
        game.peerSubmitted = false;
        resetWordEntry();
      } else if (!game.selfSubmitted) {
        game.selfWord = "";
        // 只是同步状态时，不要清掉玩家正在输入的草稿；只有换轮才重置。
        if (roundChanged) resetWordEntry();
      } else if (roundChanged || !game.selfWord) {
        // 状态说“我已提交”，但本页没有对应的词：不能凭空编造，请房主重开本轮。
        game.selfWord = "";
        game.selfSubmitted = false;
        window.setTimeout(function () {
          if (state.role === "guest" && state.peerId && state.game.phase === "input") {
            send(
              "round_reset_request",
              { round: state.game.round },
              { to: state.peerId, silent: true }
            );
          }
        }, 180);
      }

      game.awaitingReveal = !!(game.selfSubmitted && game.peerSubmitted);
      clearRoundTimers();
      if (game.awaitingReveal && game.selfWord) {
        window.setTimeout(maybeReveal, 160);
      }
      return;
    }

    if (snapshot.phase === "reveal") {
      if (!snapshot.reveal || !snapshot.reveal.host || !snapshot.reveal.guest) {
        return;
      }
      // 快照也必须声明双方都已提交，避免异常/恶意快照绕过“同时揭晓”。
      if (snapshot.hostSubmitted !== true || snapshot.guestSubmitted !== true) {
        return;
      }
      const selfWord = snapshot.reveal.guest;
      const peerWord = snapshot.reveal.host;
      game.selfWord = selfWord;
      game.selfSubmitted = true;
      game.peerSubmitted = true;
      game.peerWord = peerWord;
      game.phase = "reveal";
      game.result = null;
      game.awaitingReveal = false;
      game.reveal = {
        self: selfWord,
        peer: peerWord,
        same: core.sameWord(selfWord, peerWord),
        round: round,
      };
      state.lastRevealedRound = 0;
      clearRoundTimers();
      if (game.reveal.same) {
        scheduleFinish(2000);
      } else {
        state.advanceAt = Date.now() + 4200;
        startRevealTicker();
        if (state.role === "guest") {
          window.setTimeout(function () {
            if (state.game.phase === "reveal" && !state.game.reveal.same) requestSync();
          }, 5000);
        }
      }
      return;
    }

    if (snapshot.phase === "finished") {
      if (snapshot.hostSubmitted !== true || snapshot.guestSubmitted !== true) {
        return;
      }
      const result = snapshot.result || {};
      const rounds = Math.max(1, Number(result.rounds) || round);
      const word = result.word || (snapshot.reveal && snapshot.reveal.host) || "";
      game.phase = "finished";
      game.round = rounds;
      if (snapshot.reveal && snapshot.reveal.host && snapshot.reveal.guest) {
        game.selfWord = snapshot.reveal.guest;
        game.peerWord = snapshot.reveal.host;
        game.selfSubmitted = true;
        game.peerSubmitted = true;
        game.reveal = {
          self: snapshot.reveal.guest,
          peer: snapshot.reveal.host,
          same: true,
          round: rounds,
        };
      } else if (word) {
        game.selfWord = word;
        game.peerWord = word;
        game.reveal = { self: word, peer: word, same: true, round: rounds };
      }
      game.result = {
        rounds: rounds,
        word: word || game.selfWord || "—",
        rating: core.rateResult(rounds),
      };
      clearRoundTimers();
      state.resultShown = false;
    }
  }

  function resetCurrentRoundLocal() {
    const game = state.game;
    game.selfWord = "";
    game.selfSubmitted = false;
    game.peerSubmitted = false;
    game.peerWord = "";
    game.reveal = null;
    game.awaitingReveal = false;
    game.phase = "input";
    state.lastRevealedRound = 0;
    clearRoundTimers();
    resetWordEntry();
  }

  function hostResetRound(reason) {
    if (state.role !== "host" || state.game.phase !== "input") return;
    resetCurrentRoundLocal();
    saveSession();
    renderCurrentScreen();
    if (state.peerId) {
      send(
        "round_reset",
        {
          round: state.game.round,
          reason: reason || "本轮重新开始",
          lastPair: state.game.lastPair
            ? {
                round: state.game.lastPair.round,
                host: state.game.lastPair.self,
                guest: state.game.lastPair.peer,
              }
            : null,
        },
        { to: state.peerId, silent: true }
      );
    }
    showToast(reason || "本轮重新开始");
  }

  // ---------- 提交 / 揭晓 / 下一轮 ----------
  function submitWord() {
    const game = state.game;
    if (game.phase !== "input" || game.selfSubmitted) return;
    if (!state.peerJoined) {
      showToast("等对方加入后再提交");
      return;
    }

    const word = core.normalizeWord(dom.wordInput.value);
    if (!word) {
      showToast("先写一个词吧");
      dom.wordInput.focus();
      return;
    }
    if (!core.isValidWord(word)) {
      showToast(`最多 ${core.WORD_MAX_LENGTH} 个字`);
      dom.wordInput.focus();
      return;
    }

    game.selfWord = word;
    game.selfSubmitted = true;
    dom.wordInput.value = word;
    dom.wordInput.disabled = true;
    saveSession();
    renderAnswerCard();
    renderPlayerStatus();
    renderGameNote();
    // 只发送状态，不发送词语。
    sendSubmitStatus();
    scheduleStatusRetry();
    maybeReveal();
  }

  function scheduleFinish(delay) {
    clearTimer("resultTimer");
    state.resultTimer = window.setTimeout(finishGame, delay || 2400);
  }

  function finishGame() {
    const game = state.game;
    if (!game.reveal || !game.reveal.same) return;
    if (game.phase === "finished") return;

    clearRoundTimers();
    const rounds = game.round;
    game.phase = "finished";
    game.result = {
      rounds: rounds,
      word: game.reveal.self,
      rating: core.rateResult(rounds),
    };
    state.resultShown = false;
    saveSession();
    renderResult();
  }

  function scheduleAdvance(delay) {
    if (state.role !== "host") return;
    if (state.game.phase !== "reveal" || !state.game.reveal || state.game.reveal.same) {
      return;
    }
    if (!state.peerOnline) {
      state.advanceAt = 0;
      clearTimer("advanceTimer");
      return;
    }
    const wait = Math.max(800, Number(delay) || 5200);
    state.advanceAt = Date.now() + wait;
    clearTimer("advanceTimer");
    state.advanceTimer = window.setTimeout(advanceRound, wait);
    startRevealTicker();
    updateRevealCountdown();
  }

  function startRevealTicker() {
    clearTimer("revealTicker");
    state.revealTicker = window.setInterval(function () {
      if (state.game.phase !== "reveal") {
        clearTimer("revealTicker");
        return;
      }
      updateRevealCountdown();
    }, 500);
  }

  function advanceRound() {
    if (state.role !== "host") return;
    const game = state.game;
    if (game.phase !== "reveal" || !game.reveal || game.reveal.same) return;
    if (!state.peerOnline) {
      state.advanceAt = 0;
      updateRevealCountdown();
      return;
    }

    const previous = {
      round: game.round,
      host: game.reveal.self,
      guest: game.reveal.peer,
      self: game.reveal.self,
      peer: game.reveal.peer,
    };

    clearRoundTimers();
    game.lastPair = {
      self: previous.self,
      peer: previous.peer,
      round: previous.round,
    };
    game.round += 1;
    game.phase = "input";
    game.selfWord = "";
    game.selfSubmitted = false;
    game.peerSubmitted = false;
    game.peerWord = "";
    game.reveal = null;
    game.awaitingReveal = false;
    state.advanceAt = 0;
    state.lastRevealedRound = 0;
    resetWordEntry();
    saveSession();
    renderCurrentScreen();
    showToast(`第 ${game.round} 轮开始`);
    window.scrollTo(0, 0);

    const lastPair = {
      round: previous.round,
      host: previous.host,
      guest: previous.guest,
    };
    send(
      "next_round",
      { round: game.round, lastPair: lastPair },
      { to: state.peerId, silent: true }
    );
    window.setTimeout(function () {
      if (
        isTransportReady() &&
        state.role === "host" &&
        state.game.phase === "input" &&
        state.game.round === game.round
      ) {
        send(
          "next_round",
          { round: game.round, lastPair: lastPair },
          { to: state.peerId, silent: true }
        );
      }
    }, 700);
  }

  // ---------- 重赛 / 退出 ----------
  function resetForRematch() {
    clearAllRoomTimers();
    state.game = createGame("input");
    state.advanceAt = 0;
    state.resultShown = false;
    state.lastRevealedRound = 0;
    state.peerLeft = false;
    resetWordEntry();
    startHeartbeat();
    saveSession();
  }

  function rematch() {
    if (state.game.phase !== "finished") return;
    if (!state.peerId || state.peerLeft) {
      showToast("对方不在房间里，无法开始新一局");
      return;
    }
    resetForRematch();
    renderCurrentScreen();
    send("rematch", { round: 1 }, { to: state.peerId, silent: true });
    showToast("新的一局开始了");
  }

  function leaveRoom() {
    if (state.leaving) return;
    state.leaving = true;

    if (state.room && isTransportReady() && state.peerId && !state.peerLeft) {
      send("leave", {}, { to: state.peerId, silent: true, noWait: true });
    }

    clearAllRoomTimers();
    disconnectTransport(true);
    clearSession();
    closeDialogs();
    resetToLocalHome();
    state.leaving = false;
    renderHome();
    updateTopNotes();
  }

  function resetToLocalHome() {
    clearAllRoomTimers();
    state.room = "";
    state.role = null;
    state.peerId = "";
    state.peerRole = null;
    state.peerJoined = false;
    state.peerOnline = false;
    state.peerLeft = false;
    state.peerLastSeen = 0;
    state.joinNonce = "";
    state.guestJoinNonce = "";
    state.game = createGame("lobby");
    state.transportState = "idle";
    state.transportReadyOnce = false;
    state.resultShown = false;
    state.advanceAt = 0;
    state.lastRevealedRound = 0;
    state.sessionRestored = false;
    state.screen = "home";
    state.waitingSince = 0;
    resetWordEntry();
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("room");
      if (DEMO) url.searchParams.set("demo", "1");
      else url.searchParams.delete("demo");
      window.history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
    } catch (err) {
      /* ignore */
    }
  }

  function closeDialogs() {
    [dom.rulesDialog, dom.peerLeftDialog].forEach(function (dialog) {
      if (dialog && dialog.open && typeof dialog.close === "function") {
        dialog.close();
      }
    });
  }

  // ---------- 会话持久化 ----------
  function saveSession() {
    if (!state.room || !state.role) return;
    const game = state.game;
    const hasReveal =
      (game.phase === "reveal" || game.phase === "finished") && !!game.reveal;
    const snapshot = {
      v: 2,
      savedAt: Date.now(),
      room: state.room,
      role: state.role,
      selfId: state.selfId,
      peerId: state.peerId,
      demo: DEMO,
      game: {
        phase: game.phase,
        round: game.round,
        selfWord: game.selfWord,
        selfSubmitted: game.selfSubmitted,
        peerSubmitted: game.peerSubmitted,
        peerWord: hasReveal ? game.peerWord : "",
        lastPair: game.lastPair,
        reveal: hasReveal ? game.reveal : null,
        result: game.phase === "finished" ? game.result : null,
      },
    };
    try {
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(snapshot));
    } catch (err) {
      /* 隐私模式下可能不可用 */
    }
  }

  function loadSession() {
    let raw;
    try {
      raw = window.sessionStorage.getItem(SESSION_KEY);
    } catch (err) {
      return null;
    }
    if (!raw) return null;

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      clearSession();
      return null;
    }

    if (!data || data.v !== 2) return null;
    if (!data.room || !core.isValidRoomCode(data.room)) return null;
    if (data.role !== "host" && data.role !== "guest") return null;
    if (!data.savedAt || Date.now() - data.savedAt > 12 * 60 * 60 * 1000) {
      clearSession();
      return null;
    }
    if (!!data.demo !== DEMO) return null;

    const game = createGame(data.game && data.game.phase);
    if (!game.phase || ["lobby", "input", "reveal", "finished"].indexOf(game.phase) < 0) {
      game.phase = "lobby";
    }
    if (data.game) {
      game.round = Math.max(1, Number(data.game.round) || 1);
      game.lastPair = data.game.lastPair || null;
      if (game.phase === "input" || game.phase === "lobby") {
        game.selfWord = String(data.game.selfWord || "");
        game.selfSubmitted = !!data.game.selfSubmitted;
        game.peerSubmitted = !!data.game.peerSubmitted;
        game.peerWord = "";
        game.reveal = null;
        game.result = null;
      } else if (game.phase === "reveal") {
        if (data.game.reveal && data.game.reveal.self && data.game.reveal.peer) {
          game.selfWord = data.game.reveal.self;
          game.peerWord = data.game.reveal.peer;
          game.selfSubmitted = true;
          game.peerSubmitted = true;
          game.reveal = data.game.reveal;
        } else {
          game.phase = "input";
          game.peerWord = "";
          game.reveal = null;
        }
      } else if (game.phase === "finished") {
        game.result = data.game.result || null;
        game.reveal = data.game.reveal || null;
        game.selfWord = game.reveal ? game.reveal.self : "";
        game.peerWord = game.reveal ? game.reveal.peer : "";
      }
    }

    return {
      room: data.room,
      role: data.role,
      selfId: data.selfId || state.selfId,
      peerId: data.peerId || "",
      game: game,
    };
  }

  function clearSession() {
    try {
      window.sessionStorage.removeItem(SESSION_KEY);
    } catch (err) {
      /* ignore */
    }
  }

  function restoreSession(saved) {
    state.room = saved.room;
    state.role = saved.role;
    setPlayerId(saved.selfId);
    state.peerId = saved.peerId;
    state.peerRole = saved.role === "host" ? "guest" : "host";
    state.peerJoined = !!saved.peerId;
    state.peerOnline = false;
    state.peerLeft = false;
    state.peerLastSeen = 0;
    state.game = saved.game;
    state.resultShown = false;
    state.transportState = "connecting";
    state.transportReadyOnce = false;
    state.sessionRestored = true;
    state.waitingSince = Date.now();
    state.lastRevealedRound = 0;
    clearInviteQuery();

    if (state.game.phase === "finished") {
      renderResult();
    } else if (state.game.phase === "lobby") {
      renderWaiting();
    } else {
      renderGame();
    }
    connectToRoom(true);
  }

  // ---------- 复制 / 分享 ----------
  function fallbackCopy(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (err) {
      ok = false;
    }
    document.body.removeChild(area);
    if (!ok) throw new Error("copy failed");
  }

  async function copyText(text, successMessage) {
    if (!text) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopy(text);
      }
      showToast(successMessage || "已复制");
    } catch (err) {
      try {
        fallbackCopy(text);
        showToast(successMessage || "已复制");
      } catch (err2) {
        showToast("复制失败，请手动选择");
      }
    }
  }

  function copyRoomCode() {
    copyText(state.room, "房间号已复制");
  }

  function copyInvite() {
    const text = core.buildInviteText(state.room, window.location.href, demoParams());
    copyText(text, "邀请链接已复制");
  }

  function shareResult() {
    if (!state.game.result) return;
    const rating = state.game.result.rating || core.rateResult(state.game.result.rounds);
    const text = core.buildShareText(
      state.game.result.rounds,
      rating.title,
      state.game.result.word
    );
    copyText(text, "战绩已复制");
  }

  // ---------- 彩纸 ----------
  function launchConfetti() {
    if (!dom.confetti) return;
    if (
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    dom.confetti.innerHTML = "";
    const colors = ["#e5674d", "#87a08c", "#d3a64a", "#202c29", "#f0b6a6"];
    for (let i = 0; i < 28; i += 1) {
      const piece = document.createElement("span");
      piece.className = "confetti__piece";
      piece.style.setProperty("--left", `${Math.random() * 100}%`);
      piece.style.setProperty("--size", `${5 + Math.random() * 7}px`);
      piece.style.setProperty("--color", colors[i % colors.length]);
      piece.style.setProperty("--drift", `${-120 + Math.random() * 240}px`);
      piece.style.setProperty("--spin", `${360 + Math.random() * 760}deg`);
      piece.style.setProperty("--duration", `${2.4 + Math.random() * 2}s`);
      piece.style.setProperty("--delay", `${Math.random() * 0.45}s`);
      dom.confetti.appendChild(piece);
    }
    window.setTimeout(function () {
      if (dom.confetti) dom.confetti.innerHTML = "";
    }, 5200);
  }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    dom.createBtn.addEventListener("click", createRoom);

    dom.joinForm.addEventListener("submit", function (event) {
      event.preventDefault();
      joinRoom();
    });

    dom.joinCode.addEventListener("input", function () {
      const start = dom.joinCode.selectionStart;
      const before = dom.joinCode.value;
      const cleaned = core.normalizeRoomCode(before);
      if (cleaned !== before) {
        dom.joinCode.value = cleaned;
        const next = Math.max(0, (start || 0) - (before.length - cleaned.length));
        try {
          dom.joinCode.setSelectionRange(next, next);
        } catch (err) {
          /* ignore */
        }
      }
      if (state.homeError) clearHomeError();
    });

    dom.wordForm.addEventListener("submit", function (event) {
      event.preventDefault();
      submitWord();
    });

    dom.wordInput.addEventListener("input", function () {
      const length = core.wordLength(dom.wordInput.value);
      dom.charCount.textContent = `${length} / ${core.WORD_MAX_LENGTH}`;
    });

    dom.showResultBtn.addEventListener("click", finishGame);
    dom.rematchBtn.addEventListener("click", rematch);
    dom.shareBtn.addEventListener("click", shareResult);
    dom.copyCodeBtn.addEventListener("click", copyRoomCode);
    dom.copyInviteBtn.addEventListener("click", copyInvite);
    dom.stayBtn.addEventListener("click", function () {
      if (dom.peerLeftDialog.open) dom.peerLeftDialog.close();
    });

    document.addEventListener("click", function (event) {
      const rulesTrigger = event.target.closest("[data-open-rules]");
      if (rulesTrigger) {
        event.preventDefault();
        if (
          dom.rulesDialog &&
          !dom.rulesDialog.open &&
          typeof dom.rulesDialog.showModal === "function"
        ) {
          dom.rulesDialog.showModal();
        }
        return;
      }

      const closeTrigger = event.target.closest("[data-close-dialog]");
      if (closeTrigger) {
        event.preventDefault();
        closeDialogs();
        return;
      }

      const leaveTrigger = event.target.closest("[data-leave-room]");
      if (leaveTrigger) {
        event.preventDefault();
        leaveRoom();
      }
    });

    [dom.rulesDialog, dom.peerLeftDialog].forEach(function (dialog) {
      if (!dialog) return;
      dialog.addEventListener("click", function (event) {
        if (event.target === dialog) dialog.close();
      });
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && isTransportReady()) {
        sendHeartbeat();
      }
    });

    window.addEventListener("online", function () {
      if (isTransportReady()) sendHeartbeat();
    });

    window.addEventListener("beforeunload", function () {
      // 刷新/关闭时保存状态以便回来继续；故意不发送 leave，让对手等待重连。
      if (state.room) saveSession();
    });
  }

  // ---------- 调试钩子 ----------
  function setupDebug() {
    if (!DEBUG) return;
    window.__TONGCI_DEBUG__ = {
      getState: function () {
        return JSON.parse(
          JSON.stringify({
            room: state.room,
            role: state.role,
            selfId: state.selfId,
            peerId: state.peerId,
            peerJoined: state.peerJoined,
            peerOnline: state.peerOnline,
            transportState: state.transportState,
            screen: state.screen,
            game: state.game,
          })
        );
      },
      getWireLog: function () {
        return state.wireLog.slice();
      },
      getConfig: function () {
        return { demo: DEMO, configOk: CONFIG.ok, canUseTransport: canUseTransport() };
      },
      simulateReconnect: function () {
        if (!DEBUG || !isTransportReady()) return false;
        state.sessionRestored = false;
        state.transportReadyOnce = true;
        handleTransportStatus("ready", "debug-reconnect");
        return true;
      },
    };
  }

  // ---------- 传输实现 ----------
  class DemoTransport {
    constructor(options) {
      this.room = options.room;
      this.onMessage = options.onMessage;
      this.onStatus = options.onStatus;
      this.channel = null;
      this.name = "demo";
    }

    connect() {
      if (typeof window.BroadcastChannel !== "function") {
        throw new Error("BroadcastChannel unavailable");
      }
      this.channel = new window.BroadcastChannel(`tongci-room:${this.room}`);
      this.channel.onmessage = (event) => {
        this.onMessage(event.data);
      };
      this.channel.onmessageerror = () => {
        this.onStatus("error", "BroadcastChannel messageerror");
      };
      this.onStatus("ready", "demo");
    }

    send(payload) {
      if (!this.channel) return Promise.resolve(false);
      try {
        this.channel.postMessage(payload);
        return Promise.resolve(true);
      } catch (err) {
        return Promise.reject(err);
      }
    }

    disconnect() {
      if (this.channel) {
        this.channel.onmessage = null;
        this.channel.close();
        this.channel = null;
      }
      this.onStatus("closed", "demo closed");
    }
  }

  class SupabaseTransport {
    constructor(options) {
      this.room = options.room;
      this.onMessage = options.onMessage;
      this.onStatus = options.onStatus;
      this.client = null;
      this.channel = null;
      this.name = "supabase";
      this.closed = false;

      this.client = window.supabase.createClient(CONFIG.url, CONFIG.key, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        realtime: {
          params: {
            eventsPerSecond: 20,
          },
        },
      });

      this.channel = this.client.channel(`room:${this.room}`, {
        config: {
          broadcast: {
            self: false,
            ack: true,
          },
        },
      });

      this.channel.on("broadcast", { event: "game" }, (event) => {
        this.onMessage(event.payload);
      });
    }

    connect() {
      this.channel.subscribe((status, err) => {
        if (this.closed) return;
        if (status === "SUBSCRIBED") {
          this.onStatus("ready", status);
        } else if (status === "CHANNEL_ERROR") {
          this.onStatus("error", err || status);
        } else if (status === "TIMED_OUT") {
          this.onStatus("error", err || status);
        } else if (status === "CLOSED") {
          this.onStatus("closed", status);
        }
      });
    }

    send(payload) {
      if (!this.channel) return Promise.resolve(false);
      return this.channel
        .send({
          type: "broadcast",
          event: "game",
          payload: payload,
        })
        .then((result) => result === "ok");
    }

    disconnect() {
      this.closed = true;
      const channel = this.channel;
      const client = this.client;
      this.channel = null;
      this.client = null;

      const closeSocket = function () {
        try {
          if (client && client.realtime && client.realtime.disconnect) {
            client.realtime.disconnect();
          }
        } catch (err) {
          /* ignore */
        }
      };

      try {
        if (client && channel) {
          const removed = client.removeChannel(channel);
          if (removed && typeof removed.finally === "function") {
            removed.finally(closeSocket);
          } else {
            closeSocket();
          }
        } else if (channel && channel.unsubscribe) {
          channel.unsubscribe();
          closeSocket();
        } else {
          closeSocket();
        }
      } catch (err) {
        closeSocket();
      }
    }
  }

  // ---------- 启动 ----------
  function init() {
    bindEvents();
    setupDebug();

    const invitedRoom = core.normalizeRoomCode(query.get("room") || "");
    if (core.isValidRoomCode(invitedRoom)) {
      dom.joinCode.value = invitedRoom;
      if (dom.demoLink) {
        dom.demoLink.href = `?demo=1&room=${encodeURIComponent(invitedRoom)}`;
      }
    }

    updateTopNotes();

    const saved = loadSession();
    if (
      saved &&
      (!core.isValidRoomCode(invitedRoom) || saved.room === invitedRoom)
    ) {
      restoreSession(saved);
    } else {
      showScreen("home");
      renderHome();
    }
  }

  init();
})();
