/**
 * DDJ-FLX4 Web DJ Controller - UI, Waveform, Multi-Touch, MIDI & AUTO DJ PRO Engine
 */

(function () {
 const engine = new window.DDJFlx4AudioEngine();

 let autoDjQueue = []; // Starts 100% empty on launch — user freely selects tracks & order!
 let savedLibrary = []; // Optional server-saved history (never auto-loaded onto decks or Auto DJ)
 let localMusicShownTracks = []; // Currently displayed tracks in iPhone Music / iTunes modal
 let previewAudioEl = null; // 30s audition player for Apple Music catalog search
 let waveZoomFactor = 10.0;
 let recStartTime = 0;
 let recInterval = null;
 let recActiveMode = "screen"; // Default 'screen' (画面＋音声録画) | 'display' (タブ全体録画) | 'audio' (音声のみ)
 let recScreenCanvas = null;
 let recCanvasTimer = null;
 let lastRecFrameMs = 0;
 let lastRecordedResult = null;

 // ==================== iOS / MOBILE SAFE SERIALIZED AUDIO DECODE QUEUE ====================
 // Prevents iOS Safari WebKit Jetsam OOM resets when selecting multiple tracks at once:
 // - Never caches decoded AudioBuffers on playlist items (only Deck 1 & Deck 2 hold audio in RAM)
 // - Serializes all fetch + decodeAudioData operations strictly 1-at-a-time
 // - Reserves Deck 1 & Deck 2 slots synchronously so rapid multi-taps never launch parallel decodes
 let audioDecodeChain = Promise.resolve();
 const deckReservedTrackId = { 1: null, 2: null };
 const deckInFlightPromise = { 1: null, 2: null };
 const deckLoadSeq = { 1: 0, 2: 0 };
 let retainedPickerInputs = [];

 window.addEventListener("unhandledrejection", (ev) => {
 console.warn("Handled async audio/network error safely:", ev.reason);
 ev.preventDefault();
 });

 // ==================== AUTO DJ PRO STATE (ORIGINAL TEMPO BASE + DYNAMIC TRANSITION) ====================
 const autoDj = {
 enabled: false,
 tempoMode: "smart_bpm", // 'smart_bpm' (緩やかなBPM移行・ハーフテンポ対応) | 'adaptive' (原曲重視) | 'lock128'
 style: "allstar", // 'allstar' | 'guetta' | 'tokoto' | 'nicky' | 'festival' | 'club' | 'scratch' | 'smooth'
 edmDrumMode: "off", // Default 'off': ZERO 4-on-the-floor kick / synthetic drums! ('off' | 'kick' | 'full')
 pad5to8Fx: false, // Default OFF: disables Pads 5, 6, 7, 8 off-beat hi-hat/synth/noise FX
 cycleMode: "club", // Default 'club' (Club Dancefloor): ドロップ／サビ（16〜32小節）を踊らせる2〜3分構成！ ('club' | 'radio' | 'extended' | '64' | '32' | '16')
 transitionBars: 8, // トランジション長: 8小節 (4 / 8 / 16 / 0 = 即時カットイン)
 phraseSync: true, // 16小節／32小節のブロック単位でダウンビートを完全同期
 vocalAntiClash: true, // セリフ・ボーカルの被りを防止（1拍エコーフリーズ＋HPFウォッシュアウトで飛ばして次曲クリーンアタック）
 eqMode: "low_swap", // 'low_swap' (低域ぶつかりゼロ・完全アイソレーター) | 'stem_blend' | 'quick_cut'
 mixInStrategy: "smart_mashup", // 'smart_mashup' (歌詞・リズム考慮の最適頭出し＆レイヤリング) | 'drop_direct' | 'buildup_layer' | 'phrase_intro' | 'full_intro'
 smartLowAttack: true, // アタック時は次曲LOWを9:30(-7dB)にカット、2〜4拍目で12時フラットへ滑らか復帰
 lowAttackRampActive: false, // 1小節目LOWスロープ処理中フラグ
 postDropRampActive: false, // ドロップ後BPMランプアップ処理中フラグ
 postDropRampStartBpm: 0,
 cycleBars: 64, // active effective bars for the current song cycle (dynamically computed per song)
 cycleStartPlayheadSec: 0,
 activeDeckId: 1, // 1 or 2 (current master deck)
 playlistCursor: 0, // index in autoDjQueue
 cycleCount: 0, // rotates ALL-STAR pro styles & EDM chapters
 cycleBeatsElapsed: 0, // integrated musical beats elapsed in current cycle (handles smooth tempo ramps!)
 lastFrameAudioTime: 0, // previous audioContext.currentTime for beat integration
 lastBeatIndex: -1,
 lastStep16Index: -1,
 nextTrackPrepared: false,
 riserTriggered: false,
 loopRollStage: 0, // 0 = off, 1 = initial loop, 2 = tightened loop
 echoFrozen: false, // tracks Pioneer DJM Post-Fader Echo-Freeze state in Stage 4
 pausedInBackground: false, // paused from iPhone Lock Screen / AirPods while preserving Auto DJ session
 };

 const PRO_ALLSTAR_ROTATION = ["guetta", "tokoto", "nicky"];

 function getEffectiveAutoDjStyle() {
 if (autoDj.style === "allstar") {
 return PRO_ALLSTAR_ROTATION[autoDj.cycleCount % PRO_ALLSTAR_ROTATION.length];
 }
 return autoDj.style;
 }

 function isProEdmStyle(st) {
 return st === "guetta" || st === "tokoto" || st === "nicky" || st === "festival";
 }

 function updateAutoDjLiveBadgeUI(effStyle) {
 const badge = document.getElementById("autoDjLiveBadge");
 if (!badge) return;
 const prefix = autoDj.style === "allstar" ? " ALL-STAR: " : "";
 switch (effStyle) {
 case "guetta":
 badge.textContent = `${prefix} DAVID GUETTA @ TML 2026`;
 break;
 case "tokoto":
 badge.textContent = `${prefix} MITOMI TOKOTO @ ageHa`;
 break;
 case "nicky":
 badge.textContent = `${prefix} NICKY ROMERO @ TML 2019`;
 break;
 case "festival":
 badge.textContent = " FESTIVAL HYPE AUTO DJ";
 break;
 case "club":
 badge.textContent = " CLUB BASS-SWAP AUTO DJ";
 break;
 case "scratch":
 badge.textContent = " TURNTABLIST AUTO DJ";
 break;
 default:
 badge.textContent = " SMOOTH LOUNGE AUTO DJ";
 break;
 }
 }

 const PAD_FX_LABELS = [
 ["JET", "Flanger"],
 ["PHASER", "Sweep"],
 ["ECHO", "1/2 Beat"],
 ["REVERB", "Wash"],
 ["ROLL 1/4", "Loop"],
 ["ROLL 1/2", "Loop"],
 ["BRAKE", "Vinyl"],
 ["HPF", "Drop"],
 ];

 const BEAT_JUMP_BEATS = [-0.5, 0.5, -1, 1, -2, 2, -4, 4];
 const BEAT_JUMP_LABELS = ["-1/2", "+1/2", "-1", "+1", "-2", "+2", "-4", "+4"];

 window.addEventListener("DOMContentLoaded", () => {
 initLibrary();
 fetchServerLibrary();
 bindTopBar();
 bindDeckControls(1, engine.deck1);
 bindDeckControls(2, engine.deck2);
 bindMixerControls();
 bindRotaryKnobs();
 bindWaveformCanvases();
 bindYoutubeAndLibraryModal();
 bindIphoneMusicModal();
 bindAutoDjPro();
 bindKeyboardShortcuts();
 initWebMIDI();
 initIphoneLandscapeFit();
 initBackgroundPlaybackSupport();

 // Start with Deck 1, Deck 2, and Auto DJ Setlist completely empty so user can freely pick songs!
 resetEmptyDeckDisplay(1);
 resetEmptyDeckDisplay(2);

 // If opened from iPhone Shortcut ("ミュージックを選択" -> URL bridge), import selected songs automatically!
 checkUrlIphoneMusicImport();

 requestAnimationFrame(renderLoop);
 });

 // ==================== iPhone LANDSCAPE 1-SCREEN AUTO-FIT ====================
 let landscapeFitRaf = null;

 function fitControllerToViewport() {
 landscapeFitRaf = null;
 const root = document.documentElement;
 const stage = document.querySelector(".workspace-stage");
 const unit = document.querySelector(".flx4-hardware-unit");
 if (!stage || !unit) return;

 const activeEl = document.activeElement;
 const isTextInputFocused =
 activeEl &&
 (activeEl.tagName === "TEXTAREA" ||
 (activeEl.tagName === "INPUT" &&
 activeEl.type !== "range" &&
 activeEl.type !== "button" &&
 activeEl.type !== "checkbox"));

 const vv = window.visualViewport;
 const vw = vv && !isTextInputFocused ? vv.width : window.innerWidth;
 const vh = vv && !isTextInputFocused ? vv.height : window.innerHeight;
 root.style.setProperty("--app-vh", `${Math.round(vh)}px`);

 const isCompactLandscape = window.innerWidth > window.innerHeight && window.innerHeight <= 540;
 root.classList.toggle("iphone-landscape-fit", isCompactLandscape);

 if (isCompactLandscape) {
 if (!isTextInputFocused && (window.scrollY !== 0 || window.scrollX !== 0)) {
 window.scrollTo(0, 0);
 }
 const availW = Math.max(180, stage.clientWidth - 6);
 const availH = Math.max(100, stage.clientHeight - 4);
 const natW = Math.max(1, unit.offsetWidth);
 const natH = Math.max(1, unit.offsetHeight);
 const scale = Math.min(availW / natW, availH / natH, 1.06);
 unit.style.setProperty("--unit-scale", scale.toFixed(4));
 } else {
 unit.style.removeProperty("--unit-scale");
 }
 }

 function scheduleLandscapeFit() {
 if (landscapeFitRaf !== null) return;
 landscapeFitRaf = requestAnimationFrame(fitControllerToViewport);
 }

 function initIphoneLandscapeFit() {
 fitControllerToViewport();
 setTimeout(fitControllerToViewport, 120);

 window.addEventListener("resize", scheduleLandscapeFit, { passive: true });
 window.addEventListener(
 "orientationchange",
 () => {
 scheduleLandscapeFit();
 setTimeout(fitControllerToViewport, 150);
 setTimeout(fitControllerToViewport, 380);
 },
 { passive: true }
 );

 if (window.visualViewport) {
 window.visualViewport.addEventListener("resize", scheduleLandscapeFit, { passive: true });
 }

 const stage = document.querySelector(".workspace-stage");
 if (stage && typeof ResizeObserver !== "undefined") {
 const ro = new ResizeObserver(() => scheduleLandscapeFit());
 ro.observe(stage);
 }

 // Prevent accidental two-finger page zoom on iOS Safari while scratching/mixing in landscape
 document.addEventListener(
 "gesturestart",
 (e) => {
 if (document.documentElement.classList.contains("iphone-landscape-fit")) {
 e.preventDefault();
 }
 },
 { passive: false }
 );
 }

 function resetEmptyDeckDisplay(deckId) {
 deckReservedTrackId[deckId] = null;
 deckInFlightPromise[deckId] = null;
 deckLoadSeq[deckId] += 1;
 const deck = deckId === 1 ? engine.deck1 : engine.deck2;
 if (typeof deck.unloadTrack === "function") {
 deck.unloadTrack();
 }
 const titleEl = document.getElementById(`waveTitle${deckId}`);
 const stateEl = document.getElementById(`lcdState${deckId}`);
 const playBtn = document.getElementById(`btnPlay${deckId}`);
 if (titleEl) {
 titleEl.textContent = `曲未選択 — [ Musicアプリ] / [ 選曲] / [Load Deck ${deckId}] / [YouTube] から自由に選んでください`;
 }
 if (stateEl) stateEl.textContent = "EMPTY";
 if (playBtn) {
 playBtn.classList.remove("playing");
 playBtn.textContent = "▶";
 }
 updateDeckPadLabels(deckId);
 }

 function formatTime(sec) {
 if (!isFinite(sec) || sec < 0) sec = 0;
 const m = Math.floor(sec / 60);
 const s = Math.floor(sec % 60);
 const ms = Math.floor((sec % 1) * 10);
 return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`;
 }

 function formatShortTime(sec) {
 if (!isFinite(sec) || sec < 0) sec = 0;
 const m = Math.floor(sec / 60);
 const s = Math.floor(sec % 60);
 return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
 }

 function escapeHtml(str) {
 return String(str || "")
 .replace(/&/g, "&amp;")
 .replace(/</g, "&lt;")
 .replace(/>/g, "&gt;")
 .replace(/"/g, "&quot;");
 }

 // ==================== LIBRARY & FREE TRACK SELECTION ====================
 function initLibrary() {
 autoDjQueue = [];
 savedLibrary = [];
 renderLibraryTable();
 renderAutoDjPlaylist();
 renderSavedLibraryInAutoDj();
 }

 function getApiBaseUrl() {
    const custom = (localStorage.getItem("flx4_cloud_api_url") || "").trim();
    if (custom && (custom.startsWith("http://") || custom.startsWith("https://"))) {
      return custom.replace(/\/+$/, "");
    }
    if (window.location && window.location.hostname && window.location.hostname.includes("github.io")) {
      return "https://hostel-concert-concert-nominated.trycloudflare.com";
    }
    return "";
  }

 function apiUrl(path) {
 if (!path.startsWith("/")) path = "/" + path;
 const base = getApiBaseUrl();
 return base ? `${base}${path}` : path;
 }

 function jsonpFetch(url, timeoutMs = 8000) {
 return new Promise((resolve, reject) => {
 const cbName = "jsonp_cb_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
 const sep = url.includes("?") ? "&" : "?";
 const script = document.createElement("script");
 script.src = `${url}${sep}callback=${cbName}`;
 script.async = true;

 const timer = setTimeout(() => {
 cleanup();
 reject(new Error("通信タイムアウト（接続を確認してください）"));
 }, timeoutMs);

 function cleanup() {
 clearTimeout(timer);
 try {
 delete window[cbName];
 } catch (_) {
 window[cbName] = undefined;
 }
 if (script.parentNode) {
 script.parentNode.removeChild(script);
 }
 }

 window[cbName] = function (data) {
 cleanup();
 resolve(data);
 };

 script.onerror = function () {
 cleanup();
 reject(new Error("通信エラー（接続できませんでした）"));
 };

 (document.head || document.documentElement).appendChild(script);
 });
 }

 async function fetchServerLibrary() {
 try {
 const res = await fetch(apiUrl("/api/library"));
 if (res.ok) {
 const data = await res.json();
 if (data && Array.isArray(data.tracks)) {
 savedLibrary = data.tracks.map((t) => ({
 ...t,
 bpm: t.bpm ? engine.deck1._clampNaturalBpm(t.bpm) : 0,
 }));
 try {
 localStorage.setItem("flx4_saved_lib", JSON.stringify(savedLibrary));
 } catch (_) {}
 renderLibraryTable();
 renderSavedLibraryInAutoDj();
 return;
 }
 }
 } catch (_) {}

 // Fallback: restore saved library from browser localStorage when offline or hosted on GitHub Pages
 try {
 const cached = localStorage.getItem("flx4_saved_lib");
 if (cached) {
 const parsed = JSON.parse(cached);
 if (Array.isArray(parsed) && parsed.length > 0) {
 savedLibrary = parsed;
 renderLibraryTable();
 renderSavedLibraryInAutoDj();
 }
 }
 } catch (_) {}
 }

 function addTrackToAutoDjQueue(track) {
 if (!track) return;
 // Never retain heavy decoded AudioBuffer references on playlist items!
 if (track.buffer) {
 delete track.buffer;
 }
 if (track.bpm) {
 track.bpm = engine.deck1._clampNaturalBpm(track.bpm);
 }
 if (!autoDjQueue.some((t) => t.id === track.id)) {
 autoDjQueue.push(track);
 }
 renderAutoDjPlaylist();
 renderLibraryTable();
 renderSavedLibraryInAutoDj();
 }

 function preloadInitialAutoDjDecks() {
 if (autoDjQueue.length >= 1 && !engine.deck1.buffer && !deckReservedTrackId[1]) {
 loadTrackIntoDeck(1, autoDjQueue[0], 0);
 }
 if (autoDjQueue.length >= 2 && !engine.deck2.buffer && !deckReservedTrackId[2]) {
 const second = autoDjQueue.find((t) => t.id !== (deckReservedTrackId[1] || engine.deck1.track?.id));
 if (second) {
 loadTrackIntoDeck(2, second, 0);
 }
 }
 }

 async function deleteSavedTrack(trackId) {
 if (!trackId) return;
 try {
 await fetch(`/api/library/${encodeURIComponent(trackId)}`, { method: "DELETE" });
 } catch (_) {}
 savedLibrary = savedLibrary.filter((t) => t.id !== trackId);
 renderLibraryTable();
 renderSavedLibraryInAutoDj();
 }

 async function clearAllSavedLibrary() {
 try {
 await fetch("/api/library", { method: "DELETE" });
 } catch (_) {}
 savedLibrary = [];
 renderLibraryTable();
 renderSavedLibraryInAutoDj();
 }

 function syncDeckTempoSliderUI(deckId) {
 const deck = deckId === 1 ? engine.deck1 : engine.deck2;
 const btnKeyLock = document.getElementById(`btnKeyLock${deckId}`);
 if (btnKeyLock) {
 btnKeyLock.classList.toggle(deckId === 1 ? "active-d1" : "active-d2", deck.keyLock);
 }
 const slider = document.getElementById(`tempoSlider${deckId}`);
 const rangeVal = document.getElementById(`tempoRangeVal${deckId}`);
 if (slider) slider.value = deck.tempoSliderPos;
 if (rangeVal) rangeVal.textContent = Math.round(deck.tempoRange * 100);
 }

 function resetDeckToOriginalBpmUI(deckId) {
 engine.resetDeckToOriginalBpm(deckId);
 syncDeckTempoSliderUI(deckId);
 }

 function setDeckTargetBpmUI(deckId, targetBpm) {
 engine.setDeckTargetBpm(deckId, targetBpm);
 syncDeckTempoSliderUI(deckId);
 }

 function lockDeckTo128BpmUI(deckId, targetBpm = 128.0) {
 engine.lockDeckToTargetBpm(deckId, targetBpm);
 syncDeckTempoSliderUI(deckId);
 }

 function renderLibraryTable() {
 const tbody = document.getElementById("trackTableBody");
 if (!tbody) return;
 tbody.innerHTML = "";

 if (savedLibrary.length === 0) {
 const tr = document.createElement("tr");
 tr.innerHTML = `<td colspan="6" style="text-align:center;color:#9ca3af;padding:14px;">保存済みの曲はありません。上の検索バーからYouTube / YouTube Musicの曲を検索して自由に追加できます。</td>`;
 tbody.appendChild(tr);
 return;
 }

 savedLibrary.forEach((track) => {
 const inQueue = autoDjQueue.some((q) => q.id === track.id);
 const tr = document.createElement("tr");
 tr.innerHTML = `
 <td style="white-space:nowrap;">
 <button class="hdr-btn ${inQueue ? "btn-demo-gradient" : "btn-autodj-pro"}" style="padding:3px 7px;font-size:10px;" data-act="queue">
 ${inQueue ? " セット済" : " Auto DJ"}
 </button>
 <button class="hdr-btn btn-load-d1" style="padding:3px 7px;font-size:10px;" data-act="d1">Deck 1</button>
 <button class="hdr-btn btn-load-d2" style="padding:3px 7px;font-size:10px;" data-act="d2">Deck 2</button>
 </td>
 <td style="font-weight:700;">${escapeHtml(track.title)}</td>
 <td style="color:#9ca3af;">${escapeHtml(track.artist || "")}</td>
 <td style="font-family:monospace;">${track.bpm ? Number(track.bpm).toFixed(1) : "自動解析"}</td>
 <td style="font-family:monospace;">${formatShortTime(track.duration || 0)}</td>
 <td>
 <button class="hdr-btn btn-record" style="padding:2px 6px;font-size:10px;" data-act="del" title="履歴から削除"></button>
 </td>
 `;
 tr.querySelector('[data-act="queue"]').addEventListener("click", () => {
 addTrackToAutoDjQueue(track);
 preloadInitialAutoDjDecks();
 });
 tr.querySelector('[data-act="d1"]').addEventListener("click", () => {
 addTrackToAutoDjQueue(track);
 loadTrackIntoDeck(1, track);
 document.getElementById("youtubeModal").classList.add("hidden");
 });
 tr.querySelector('[data-act="d2"]').addEventListener("click", () => {
 addTrackToAutoDjQueue(track);
 loadTrackIntoDeck(2, track);
 document.getElementById("youtubeModal").classList.add("hidden");
 });
 tr.querySelector('[data-act="del"]').addEventListener("click", () => {
 deleteSavedTrack(track.id);
 });
 tbody.appendChild(tr);
 });
 }

 function renderSavedLibraryInAutoDj() {
 const tbody = document.getElementById("savedLibraryBody");
 const section = document.getElementById("savedLibrarySection");
 if (!tbody) return;
 tbody.innerHTML = "";

 if (savedLibrary.length === 0) {
 if (section) section.style.opacity = "0.75";
 const tr = document.createElement("tr");
 tr.innerHTML = `<td colspan="5" style="text-align:center;color:#9ca3af;padding:10px;font-size:11px;">保存済みのダウンロード履歴はありません（上の「 iPhone Musicアプリ / iTunes」またはファイル・YouTubeから自由に追加してください）</td>`;
 tbody.appendChild(tr);
 return;
 }
 if (section) section.style.opacity = "1";

 savedLibrary.forEach((track) => {
 const inQueue = autoDjQueue.some((q) => q.id === track.id);
 const tr = document.createElement("tr");
 tr.innerHTML = `
 <td style="width:130px;white-space:nowrap;">
 <button class="hdr-btn ${inQueue ? "btn-demo-gradient" : "btn-autodj-pro"}" style="padding:2px 7px;font-size:10px;" data-act="add">
 ${inQueue ? " 追加済み" : " セットに追加"}
 </button>
 </td>
 <td style="font-weight:700;color:#e5e7eb;">${escapeHtml(track.title)}</td>
 <td style="font-size:11px;color:#9ca3af;">${escapeHtml(track.artist || "")}</td>
 <td style="width:80px;font-family:monospace;color:#38bdf8;">${track.bpm ? `${Number(track.bpm).toFixed(1)} BPM` : "原曲自動"}</td>
 <td style="width:95px;text-align:right;white-space:nowrap;">
 <span style="font-family:monospace;color:#9ca3af;margin-right:6px;">${formatShortTime(track.duration || 0)}</span>
 <button class="hdr-btn btn-record" style="padding:2px 6px;font-size:9px;" data-act="del" title="履歴から削除"></button>
 </td>
 `;
 tr.querySelector('[data-act="add"]').addEventListener("click", () => {
 addTrackToAutoDjQueue(track);
 preloadInitialAutoDjDecks();
 });
 tr.querySelector('[data-act="del"]').addEventListener("click", () => {
 deleteSavedTrack(track.id);
 });
 tbody.appendChild(tr);
 });
 }

 function renderAutoDjPlaylist() {
 const tbody = document.getElementById("autoDjPlaylistBody");
 const countEl = document.getElementById("autoDjTrackCount");
 if (!tbody) return;
 tbody.innerHTML = "";
 if (countEl) countEl.textContent = `${autoDjQueue.length}曲 選択中`;

 if (autoDjQueue.length === 0) {
 const tr = document.createElement("tr");
 tr.innerHTML = `<td colspan="6" style="text-align:center;color:#f97316;padding:16px;font-weight:700;"> セットリストは空です — 上の「 iPhone Musicアプリ / iTunes」「ファイル選択」「YouTube」から好きな曲を追加してください！</td>`;
 tbody.appendChild(tr);
 return;
 }

 const badgeMap = {
 iphone_music: " Musicライブラリ",
 apple_music: " Apple Music",
 local: " 指定ファイル",
 upload: " 保存ファイル",
 youtube: "▶ YouTube",
 };

 autoDjQueue.forEach((track, idx) => {
 const bpmLabel = track.bpm
 ? autoDj.tempoMode === "lock128"
 ? `${Number(track.bpm).toFixed(1)} → 128`
 : `${Number(track.bpm).toFixed(1)} (原曲1.0x)`
 : "読込時に解析";
 const durLabel = track.duration ? formatShortTime(track.duration) : "--:--";
 const tr = document.createElement("tr");
 tr.innerHTML = `
 <td style="font-family:monospace;color:#f97316;font-weight:800;">#${idx + 1}</td>
 <td style="font-weight:700;color:#fff;">${escapeHtml(track.title)} <span style="font-weight:400;color:#9ca3af;font-size:10px;">${track.artist ? `- ${escapeHtml(track.artist)}` : ""}</span></td>
 <td style="font-size:10px;color:#9ca3af;">${badgeMap[track.source] || track.source || ""}</td>
 <td style="font-family:monospace;color:#38bdf8;font-weight:700;">${bpmLabel}</td>
 <td style="font-family:monospace;">${durLabel}</td>
 <td style="white-space:nowrap;">
 <button class="hdr-btn btn-load-d1" style="padding:2px 6px;font-size:9px;" data-act="d1" title="手動でDeck 1に読み込む">D1</button>
 <button class="hdr-btn btn-load-d2" style="padding:2px 6px;font-size:9px;" data-act="d2" title="手動でDeck 2に読み込む">D2</button>
 <button class="hdr-btn btn-qr" style="padding:2px 5px;font-size:9px;" data-act="up" ${idx === 0 ? "disabled" : ""} title="1つ上へ">⬆</button>
 <button class="hdr-btn btn-qr" style="padding:2px 5px;font-size:9px;" data-act="down" ${idx === autoDjQueue.length - 1 ? "disabled" : ""} title="1つ下へ">⬇</button>
 <button class="hdr-btn btn-record" style="padding:2px 6px;font-size:9px;" data-act="del" title="セットリストから除外"></button>
 </td>
 `;
 tr.querySelector('[data-act="d1"]').addEventListener("click", () => {
 loadTrackIntoDeck(1, track);
 });
 tr.querySelector('[data-act="d2"]').addEventListener("click", () => {
 loadTrackIntoDeck(2, track);
 });
 const upBtn = tr.querySelector('[data-act="up"]');
 if (upBtn) {
 upBtn.addEventListener("click", () => {
 if (idx <= 0) return;
 const tmp = autoDjQueue[idx - 1];
 autoDjQueue[idx - 1] = autoDjQueue[idx];
 autoDjQueue[idx] = tmp;
 renderAutoDjPlaylist();
 });
 }
 const downBtn = tr.querySelector('[data-act="down"]');
 if (downBtn) {
 downBtn.addEventListener("click", () => {
 if (idx >= autoDjQueue.length - 1) return;
 const tmp = autoDjQueue[idx + 1];
 autoDjQueue[idx + 1] = autoDjQueue[idx];
 autoDjQueue[idx] = tmp;
 renderAutoDjPlaylist();
 });
 }
 const delBtn = tr.querySelector('[data-act="del"]');
 if (delBtn) {
 delBtn.addEventListener("click", () => {
 autoDjQueue.splice(idx, 1);
 if (autoDj.playlistCursor >= autoDjQueue.length) {
 autoDj.playlistCursor = 0;
 }
 renderAutoDjPlaylist();
 renderLibraryTable();
 renderSavedLibraryInAutoDj();
 });
 }
 tbody.appendChild(tr);
 });
 }

 function stripId3v2Header(arrBuf) {
    try {
      const u8 = new Uint8Array(arrBuf);
      if (u8.length > 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) {
        const tagSize = ((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f);
        const totalHeader = 10 + tagSize;
        if (totalHeader > 0 && totalHeader < u8.length - 256) {
          return arrBuf.slice(totalHeader);
        }
      }
    } catch (_) {}
    return null;
  }

  async function decodeAudioDataSafe(arrBuf) {
    if (!arrBuf || arrBuf.byteLength === 0) {
      throw new Error("音声データが空です");
    }
    if (engine.ctx && engine.ctx.state !== "running") {
      try {
        await engine.ctx.resume();
      } catch (_) {}
    }

    const tryDecode = (bufToDecode) => {
      return new Promise((resolve, reject) => {
        let settled = false;
        const done = (buf) => {
          if (!settled) {
            settled = true;
            resolve(buf);
          }
        };
        const fail = (err) => {
          if (!settled) {
            settled = true;
            reject(err || new Error("Audio decode failed"));
          }
        };
        try {
          const copy = bufToDecode.slice(0);
          const p = engine.ctx.decodeAudioData(copy, done, fail);
          if (p && typeof p.then === "function") {
            p.then(done, fail);
          }
        } catch (err) {
          fail(err);
        }
      });
    };

    try {
      return await tryDecode(arrBuf);
    } catch (primaryErr) {
      const stripped = stripId3v2Header(arrBuf);
      if (stripped) {
        try {
          return await tryDecode(stripped);
        } catch (_) {}
      }
      throw primaryErr;
    }
  }

  async function fetchAndDecodeAudioUrl(rawUrl, transcodeUrl = null) {
    if (engine.ctx && engine.ctx.state !== "running") {
      try { await engine.ctx.resume(); } catch (_) {}
    }

    const candidateUrls = [];
    if (rawUrl.startsWith("/")) {
      candidateUrls.push(apiUrl(withSafeDecodeUrl(rawUrl)));
      if (transcodeUrl && transcodeUrl.startsWith("/")) {
        candidateUrls.push(apiUrl(withSafeDecodeUrl(transcodeUrl)));
      }
    } else if (rawUrl.includes("apple.com") || rawUrl.includes("mzstatic.com")) {
      candidateUrls.push(rawUrl);
      candidateUrls.push(`https://corsproxy.io/?url=${encodeURIComponent(rawUrl)}`);
      candidateUrls.push(`https://api.allorigins.win/raw?url=${encodeURIComponent(rawUrl)}`);
      const pApi = apiUrl(`/api/proxy-audio?url=${encodeURIComponent(rawUrl)}`);
      if (pApi && (pApi.startsWith("http://") || pApi.startsWith("https://") || !window.location.hostname.includes("github.io"))) {
        candidateUrls.push(pApi);
      }
    } else {
      candidateUrls.push(withSafeDecodeUrl(rawUrl));
      if (transcodeUrl) candidateUrls.push(withSafeDecodeUrl(transcodeUrl));
    }

    let lastErr = null;
    for (const u of candidateUrls) {
      try {
        const resp = await fetch(u, {
          headers: { Accept: "audio/*, */*" },
          signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined,
        });
        if (!resp.ok) continue;
        const cType = resp.headers.get("content-type") || "";
        if (cType.includes("text/html") || cType.includes("text/plain")) continue;
        let sBuf = await resp.arrayBuffer();
        if (!sBuf || sBuf.byteLength < 500) continue;
        const buf = await decodeAudioDataSafe(sBuf);
        if (buf) return buf;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("音声の取得・デコードに失敗しました");
  }

 // Determines intelligent mix-in cue point based on song's lyrics, rhythm, and transition strategy:
 // - 'smart_mashup': Cues 8 bars before the Chorus/Drop so the build-up layers over outgoing groove, landing on the drop!
 // - 'drop_direct': Cues directly to the Chorus/Drop (サビ・ドロップ直結) for instant peak impact
 // - 'buildup_layer': Cues 8〜16 bars before drop for live layering
 // - 'phrase_intro': Cues to the vocal verse / A-melody start (skipping silent/long intro)
 // - 'full_intro': Cues to 0:00
 function determineAutoDjMixInCue(deck, strategy = "smart_mashup", transBars = 8) {
 if (!deck || !deck.buffer || !deck.duration) return 0;
 if (strategy === "full_intro") return 0;

 const bpm = deck.baseBpm || 120.0;
 const grooveBpm = getMusicalGrooveBpm(bpm);
 const barSec = (60.0 / grooveBpm) * 4.0;
 const chorusStart = deck.chorusStartSec || 0;
 const phraseCue = deck.phraseCueSec || 0;
 const dur = deck.duration;

 if (strategy === "drop_direct") {
 if (chorusStart > 10.0 && chorusStart < dur - 15.0) {
 return chorusStart;
 }
 return phraseCue;
 }

 if (strategy === "phrase_intro") {
 return phraseCue;
 }

 // Default 'smart_mashup' & 'buildup_layer':
 // If track has a distinct chorus/drop, cue exactly transBars before the drop!
 // So the incoming vocal build-up / lyrics layer right over the outgoing groove,
 // and both tracks naturally reach the peak DROP on Beat 1!
 const effectiveTransBars = Number(transBars) > 0 ? Number(transBars) : 8;
 const neededLeadSec = barSec * effectiveTransBars;
 if (chorusStart > neededLeadSec + 4.0 && chorusStart < dur - 20.0) {
 const buildInSec = chorusStart - neededLeadSec;
 const firstBeat = deck.firstBeatSec || 0;
 const barNum = Math.round((buildInSec - firstBeat) / barSec);
 const snapSec = Math.max(0, firstBeat + barNum * barSec);
 return snapSec;
 }

 // If chorus is too early or not detected, cue to vocal verse start
 if (phraseCue > 2.0 && phraseCue < dur - 15.0) {
 return phraseCue;
 }

 return 0;
 }

 function loadTrackIntoDeck(deckId, track, startOffsetSec = 0) {
 if (!track) return Promise.resolve();
 engine.resume();

 // Never keep decoded AudioBuffers attached to playlist track objects
 if (track.buffer) {
 delete track.buffer;
 }

 // Deduplicate if this exact track is ALREADY being loaded onto this deck right now!
 if (deckReservedTrackId[deckId] === track.id && deckInFlightPromise[deckId]) {
 return deckInFlightPromise[deckId];
 }

 const deck = deckId === 1 ? engine.deck1 : engine.deck2;
 const titleEl = document.getElementById(`waveTitle${deckId}`);
 const stateEl = document.getElementById(`lcdState${deckId}`);

 deckReservedTrackId[deckId] = track.id;
 const mySeq = ++deckLoadSeq[deckId];

 if (titleEl) titleEl.textContent = `Loading: ${track.title}...`;
 if (stateEl) stateEl.textContent = "LOADING";

 // Strictly serialize all fetch + decodeAudioData operations across both decks so iOS WebKit never spikes RAM!
 const taskPromise = (audioDecodeChain = audioDecodeChain
 .catch(() => {})
 .then(async () => {
 // Skip if superseded by a newer track selection for this deck while waiting in queue
 if (deckLoadSeq[deckId] !== mySeq) return;

 try {
 const wasPlaying = deck.isPlaying;
 // Free previous track's PCM arrays on standby/paused deck BEFORE fetching & decoding the new track!
 if (!wasPlaying && deck.buffer) {
 deck.unloadTrack();
 await new Promise((r) => setTimeout(r, 16));
 }

 const isIOSClient =
 /iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
 (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
 const safeMaxSec = isIOSClient ? 600 : 900;
 const withSafeDecodeUrl = (u) => {
 if (!u) return u;
 if (!u.startsWith("/") && !u.includes("/media/")) return u;
 const qIdx = u.indexOf("?");
 let pathPart = qIdx >= 0 ? u.slice(0, qIdx) : u;
 const queryPart = qIdx >= 0 ? u.slice(qIdx + 1) : "";
 if (pathPart.includes("#")) {
 pathPart = pathPart.replace(/#/g, "%23");
 }
 const sep = queryPart ? `&max_sec=${safeMaxSec}` : `?max_sec=${safeMaxSec}`;
 return queryPart ? `${pathPart}?${queryPart}${queryPart.includes("max_sec=") ? "" : sep}` : `${pathPart}${sep}`;
 };

 let audioBuffer = null;
 if (track.fileBlob) {
 try {
 let arrBuf = await track.fileBlob.arrayBuffer();
 audioBuffer = await decodeAudioDataSafe(arrBuf);
 arrBuf = null;
 } catch (localDecErr) {
 // Fallback: try uploading to server if backend is accessible
 const upUrl = apiUrl("/api/upload");
 if (upUrl && (upUrl.startsWith("http://") || upUrl.startsWith("https://") || !window.location.hostname.includes("github.io"))) {
 try {
 const fd = new FormData();
 fd.append("file", track.fileBlob, track.fileBlob.name || "track.mp3");
 const upRes = await fetch(upUrl, { method: "POST", body: fd });
 if (upRes.ok) {
 const upData = await upRes.json();
 if (upData.ok && upData.track && upData.track.url) {
 track.url = upData.track.url;
 delete track.fileBlob;
 audioBuffer = await fetchAndDecodeAudioUrl(track.url, track.transcode_url);
 }
 }
 } catch (_) {}
 }
 if (!audioBuffer) {
 throw localDecErr;
 }
 }
 } else if (track.url) {
 audioBuffer = await fetchAndDecodeAudioUrl(track.url, track.transcode_url);
 }

 if (deckLoadSeq[deckId] !== mySeq || !audioBuffer) {
 audioBuffer = null;
 return;
 }

 deck.loadAudioBuffer(audioBuffer, track);
 // Drop reference to native C++ AudioBuffer immediately so WebKit frees AudioFloatArray RAM!
 audioBuffer = null;

 if (wasPlaying) {
 deck.isPlaying = true;
 }
 if (autoDj.enabled && autoDj.tempoMode === "lock128") {
 lockDeckTo128BpmUI(deckId, 128.0);
 } else {
 resetDeckToOriginalBpmUI(deckId);
 }
 let targetCue = startOffsetSec;
 if (autoDj.enabled && (!startOffsetSec || startOffsetSec <= 0)) {
 targetCue = determineAutoDjMixInCue(deck, autoDj.mixInStrategy, autoDj.transitionBars);
 } else if (!targetCue || targetCue <= 0) {
 targetCue = deck.phraseCueSec || 0;
 }
 if (targetCue > 0 && targetCue < deck.duration - 4) {
 deck.seekTo(targetCue);
 deck.cuePointSec = targetCue;
 }
 if (titleEl) {
 titleEl.textContent = track.artist ? `${track.title} — ${track.artist}` : track.title;
 }
 if (stateEl) stateEl.textContent = wasPlaying ? "PLAYING" : "PAUSED";
 const playBtn = document.getElementById(`btnPlay${deckId}`);
 if (playBtn) {
 playBtn.classList.toggle("playing", wasPlaying);
 playBtn.textContent = wasPlaying ? "" : "▶";
 }
 updateDeckPadLabels(deckId);
 renderLibraryTable();
 renderAutoDjPlaylist();
 renderSavedLibraryInAutoDj();
 syncBackgroundPlaybackAndLockScreen(true);
 } catch (err) {
 if (deckReservedTrackId[deckId] === track.id) {
 deckReservedTrackId[deckId] = null;
 }
 console.error("loadTrackIntoDeck error:", err);
 if (track.id === "demo1" || track.id === "demo2" || (track.url && (track.url.includes("Back%20to%20You") || track.url.includes("Burn.mp3")))) {
 resetEmptyDeckDisplay(deckId);
 } else {
 if (titleEl) titleEl.textContent = `読込エラー: ${track.title}`;
 if (stateEl) stateEl.textContent = "ERROR";
 }
 } finally {
 if (deckLoadSeq[deckId] === mySeq) {
 deckInFlightPromise[deckId] = null;
 }
 }
 }));

 deckInFlightPromise[deckId] = taskPromise;
 return taskPromise;
 }

 function createLocalTrackEntry(file) {
 if (!file) return null;
 const stem = (file.name || "Audio Track").replace(/\.[^/.]+$/, "");
 return {
 id: "loc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
 title: stem,
 artist: "Local Audio File",
 source: "local",
 bpm: 0, // Analyzed lazily on-demand when loaded onto Deck 1 / Deck 2
 duration: 0, // Populated on-demand (0 MB PCM RAM while waiting in queue!)
 fileBlob: file,
 };
 }

 async function handleLocalFileForDeck(file, deckId) {
 if (!file) return null;
 engine.resume();
 engine.unlockIosAudio();
 if (deckId) {
 const titleEl = document.getElementById(`waveTitle${deckId}`);
 if (titleEl) titleEl.textContent = `読込中: ${file.name}...`;
 }
 const newTrack = createLocalTrackEntry(file);
 addTrackToAutoDjQueue(newTrack);
 if (deckId) {
 await loadTrackIntoDeck(deckId, newTrack);
 } else {
 preloadInitialAutoDjDecks();
 }
 return newTrack;
 }

 function openMultiTrackFilePicker() {
 engine.resume();
 engine.unlockIosAudio();
 const autoDjFileInput = document.getElementById("autoDjFileInput");
 if (autoDjFileInput) {
 autoDjFileInput.click();
 return;
 }
 const dynInput = document.createElement("input");
 dynInput.type = "file";
 dynInput.multiple = true;
 dynInput.accept = ".mp3,.m4a,.wav,.aac,.flac,.aiff,.aif,.ogg,audio/*";
 dynInput.style.cssText = "position:fixed;left:-9999px;opacity:0;";
 document.body.appendChild(dynInput);
 retainedPickerInputs.push(dynInput);

 dynInput.addEventListener("change", (e) => {
 const files = Array.from(e.target.files || []);
 if (files.length === 0) {
 dynInput.remove();
 retainedPickerInputs = retainedPickerInputs.filter((el) => el !== dynInput);
 return;
 }
 engine.resume();
 engine.unlockIosAudio();
 for (let i = 0; i < files.length; i++) {
 const tr = createLocalTrackEntry(files[i]);
 if (tr && !autoDjQueue.some((q) => q.id === tr.id)) {
 autoDjQueue.push(tr);
 }
 }
 preloadInitialAutoDjDecks();
 renderAutoDjPlaylist();
 renderLibraryTable();
 renderSavedLibraryInAutoDj();
 dynInput.remove();
 retainedPickerInputs = retainedPickerInputs.filter((el) => el !== dynInput);
 });

 dynInput.click();
 }

 // ==================== AUTO DJ PRO: ORIGINAL TEMPO BASE + DYNAMIC TRANSITION ENGINE ====================
 function bindAutoDjPro() {
 const modal = document.getElementById("autoDjModal");
 const btnQuickNicky = document.getElementById("btnQuickNickyRomero");
 const btnOpenModal = document.getElementById("btnOpenAutoDjModal");
 const btnCloseModal = document.getElementById("btnCloseAutoDjModal");
 const fileInput = document.getElementById("autoDjFileInput");
 const selectTempoModal = document.getElementById("selectAutoDjTempoMode");
 const selectTempoLive = document.getElementById("selectAutoDjTempoModeLive");
 const selectStyleModal = document.getElementById("selectAutoDjStyle");
 const selectStyleLive = document.getElementById("selectAutoDjStyleLive");
 const selectCycleBars = document.getElementById("selectAutoDjCycleBars");
 const selectTransBarsModal = document.getElementById("selectAutoDjTransitionBars");
 const selectTransBarsLive = document.getElementById("selectAutoDjTransBarsLive");
 const selectEqModeModal = document.getElementById("selectAutoDjEqMode");
 const selectMixInModal = document.getElementById("selectAutoDjMixInStrategy");
 const btnSortSmartBpm = document.getElementById("btnSortSmartBpm");
 const btnSortDisneyStory = document.getElementById("btnSortDisneyStory");

 // 1-Click AUTO DJ PRO button on Top Bar (uses selected Pro Style — defaults to PRO ALL-STAR!)
 if (btnQuickNicky) {
 btnQuickNicky.addEventListener("click", async () => {
 if (autoDj.enabled) {
 stopAutoDjPerformance();
 } else {
 autoDj.style = selectStyleModal.value || "allstar";
 selectStyleLive.value = autoDj.style;
 await startAutoDjPerformance();
 }
 });
 }

 btnOpenModal.addEventListener("click", () => {
 renderAutoDjPlaylist();
 renderSavedLibraryInAutoDj();
 modal.classList.remove("hidden");
 });
 btnCloseModal.addEventListener("click", () => modal.classList.add("hidden"));
 modal.addEventListener("click", (e) => {
 if (e.target === modal) modal.classList.add("hidden");
 });

 document.getElementById("btnAutoDjSelectFiles").addEventListener("click", () => openMultiTrackFilePicker());
 document.getElementById("btnAutoDjAddFilesLive").addEventListener("click", () => openMultiTrackFilePicker());

 if (fileInput) {
 fileInput.addEventListener("change", (e) => {
 const files = Array.from(e.target.files || []);
 if (files.length === 0) return;
 engine.resume();
 engine.unlockIosAudio();
 for (let i = 0; i < files.length; i++) {
 const tr = createLocalTrackEntry(files[i]);
 if (tr && !autoDjQueue.some((q) => q.id === tr.id)) {
 autoDjQueue.push(tr);
 }
 }
 preloadInitialAutoDjDecks();
 renderAutoDjPlaylist();
 renderLibraryTable();
 renderSavedLibraryInAutoDj();
 e.target.value = "";
 });
 }

 const btnManualPlayClose = document.getElementById("btnUseManualMode");
 if (btnManualPlayClose) {
 btnManualPlayClose.addEventListener("click", () => {
 if (autoDj.enabled) {
 stopAutoDjPerformance();
 }
 preloadInitialAutoDjDecks();
 modal.classList.add("hidden");
 });
 }

 const btnOpenIphoneFromAutoDj = document.getElementById("btnAutoDjOpenIphoneMusic");
 if (btnOpenIphoneFromAutoDj) {
 btnOpenIphoneFromAutoDj.addEventListener("click", () => {
 modal.classList.add("hidden");
 openIphoneMusicModal();
 });
 }
 const btnOpenMusicLive = document.getElementById("btnAutoDjOpenMusicLive");
 if (btnOpenMusicLive) {
 btnOpenMusicLive.addEventListener("click", () => {
 openIphoneMusicModal();
 });
 }

 document.getElementById("btnAutoDjOpenYt").addEventListener("click", () => {
 modal.classList.add("hidden");
 document.getElementById("youtubeModal").classList.remove("hidden");
 renderLibraryTable();
 setTimeout(() => document.getElementById("inputYoutubeQuery").focus(), 50);
 });

 const btnClearQueue = document.getElementById("btnClearAutoDjQueue");
 if (btnClearQueue) {
 btnClearQueue.addEventListener("click", () => {
 if (autoDj.enabled) stopAutoDjPerformance();
 autoDjQueue = [];
 autoDj.playlistCursor = 0;
 retainedPickerInputs.forEach((el) => el.remove());
 retainedPickerInputs = [];
 resetEmptyDeckDisplay(1);
 resetEmptyDeckDisplay(2);
 renderAutoDjPlaylist();
 renderLibraryTable();
 renderSavedLibraryInAutoDj();
 });
 }

 if (btnSortSmartBpm) {
 btnSortSmartBpm.addEventListener("click", () => {
 if (autoDjQueue.length <= 1) return;
 // Sort with smart half/double tempo awareness and smooth progressive tempo arc
 autoDjQueue.sort((a, b) => {
 const bpmA = a.bpm > 0 ? (a.bpm < 75 ? a.bpm * 2 : (a.bpm > 155 ? a.bpm / 2 : a.bpm)) : 999;
 const bpmB = b.bpm > 0 ? (b.bpm < 75 ? b.bpm * 2 : (b.bpm > 155 ? b.bpm / 2 : b.bpm)) : 999;
 return bpmA - bpmB;
 });
 autoDj.playlistCursor = 0;
 renderAutoDjPlaylist();
 preloadInitialAutoDjDecks();
 });
 }

 if (btnSortDisneyStory) {
 btnSortDisneyStory.addEventListener("click", () => {
 if (autoDjQueue.length <= 1) return;
 // Thematic Disney Storytelling Arc:
 // 1. Villains / Halloween (Dark & Mysterious intro)
 // 2. Romantic Ballads & Nostalgia (Beauty & Beast / Small World)
 // 3. Main Street / Electrical Parades (Building excitement)
 // 4. Climax Party & Dance Anthems (Jamboree Mickey finale)
 function getDisneyStoryScore(title) {
 const t = (title || "").toLowerCase();
 if (/ヴィランズ|手下|villain|ハロウィ|halloween/.test(t)) {
 return /フレンジー|frenzy/.test(t) ? 12 : 10;
 }
 if (/フレンジー|frenzy/.test(t)) return 14;
 if (/美女と野獣|beauty|ア・ホール|aladdin|アラジン|ホール・ニュー・ワールド/.test(t)) return 20;
 if (/スモールワールド|small world|イッツ・ア/.test(t)) return 25;
 if (/エレクトリック|パレード|parade|electrical|baroque|ドリームライツ/.test(t)) return 30;
 if (/ジャンボリ|jamboree|クラブマウス|club mouse|ミッキー|mickey|ダンス|dance|party/.test(t)) return 40;
 return 35;
 }

 autoDjQueue.sort((a, b) => {
 const scoreA = getDisneyStoryScore(a.title);
 const scoreB = getDisneyStoryScore(b.title);
 if (scoreA !== scoreB) return scoreA - scoreB;
 return (a.bpm || 0) - (b.bpm || 0);
 });
 autoDj.playlistCursor = 0;
 renderAutoDjPlaylist();
 preloadInitialAutoDjDecks();
 });
 }

 const btnAddAllSaved = document.getElementById("btnAddAllSavedToQueue");
 if (btnAddAllSaved) {
 btnAddAllSaved.addEventListener("click", () => {
 savedLibrary.forEach((t) => addTrackToAutoDjQueue(t));
 preloadInitialAutoDjDecks();
 });
 }

 const btnClearSaved = document.getElementById("btnClearSavedLibrary");
 if (btnClearSaved) {
 btnClearSaved.addEventListener("click", () => {
 clearAllSavedLibrary();
 });
 }

 if (fileInput) {
 fileInput.addEventListener("change", (e) => {
 const files = Array.from(e.target.files || []);
 if (files.length === 0) return;
 engine.resume();
 for (let i = 0; i < files.length; i++) {
 const tr = createLocalTrackEntry(files[i]);
 if (tr && !autoDjQueue.some((q) => q.id === tr.id)) {
 autoDjQueue.push(tr);
 }
 }
 renderAutoDjPlaylist();
 renderLibraryTable();
 renderSavedLibraryInAutoDj();
 preloadInitialAutoDjDecks();
 });
 }

 if (selectTempoModal && selectTempoLive) {
 selectTempoModal.addEventListener("change", () => {
 autoDj.tempoMode = selectTempoModal.value;
 selectTempoLive.value = autoDj.tempoMode;
 if (autoDj.enabled && autoDj.tempoMode === "adaptive") {
 resetDeckToOriginalBpmUI(autoDj.activeDeckId);
 } else if (autoDj.enabled && autoDj.tempoMode === "lock128") {
 lockDeckTo128BpmUI(1, 128.0);
 lockDeckTo128BpmUI(2, 128.0);
 }
 renderAutoDjPlaylist();
 });
 selectTempoLive.addEventListener("change", () => {
 autoDj.tempoMode = selectTempoLive.value;
 selectTempoModal.value = autoDj.tempoMode;
 if (autoDj.enabled && autoDj.tempoMode === "adaptive") {
 resetDeckToOriginalBpmUI(autoDj.activeDeckId);
 } else if (autoDj.enabled && autoDj.tempoMode === "lock128") {
 lockDeckTo128BpmUI(1, 128.0);
 lockDeckTo128BpmUI(2, 128.0);
 }
 renderAutoDjPlaylist();
 });
 }

 function syncActiveAutoDjStyleConfig() {
 const eff = getEffectiveAutoDjStyle();
 updateAutoDjLiveBadgeUI(eff);
 if (autoDj.enabled) {
 const useEdmDrums = autoDj.edmDrumMode !== "off" && isProEdmStyle(eff);
 engine.deck1.setEdmRemixMode(useEdmDrums, !autoDj.pad5to8Fx);
 engine.deck2.setEdmRemixMode(useEdmDrums, !autoDj.pad5to8Fx);
 }
 }

 selectStyleModal.addEventListener("change", () => {
 autoDj.style = selectStyleModal.value;
 selectStyleLive.value = autoDj.style;
 syncActiveAutoDjStyleConfig();
 });
 selectStyleLive.addEventListener("change", () => {
 autoDj.style = selectStyleLive.value;
 selectStyleModal.value = autoDj.style;
 syncActiveAutoDjStyleConfig();
 });
 selectCycleBars.addEventListener("change", () => {
 autoDj.cycleMode = selectCycleBars.value || "club";
 refreshActiveAutoDjCycleBars();
 });

 if (selectTransBarsModal && selectTransBarsLive) {
 selectTransBarsModal.addEventListener("change", () => {
 autoDj.transitionBars = parseInt(selectTransBarsModal.value, 10) || 8;
 selectTransBarsLive.value = String(autoDj.transitionBars);
 });
 selectTransBarsLive.addEventListener("change", () => {
 autoDj.transitionBars = parseInt(selectTransBarsLive.value, 10) || 8;
 selectTransBarsModal.value = String(autoDj.transitionBars);
 });
 }

 if (selectEqModeModal) {
 selectEqModeModal.addEventListener("change", () => {
 autoDj.eqMode = selectEqModeModal.value || "low_swap";
 autoDj.vocalAntiClash = autoDj.eqMode === "low_swap";
 });
 }

 if (selectMixInModal) {
 selectMixInModal.addEventListener("change", () => {
 autoDj.mixInStrategy = selectMixInModal.value || "smart_mashup";
 });
 }

 // 4-on-the-Floor & Pad Drum Overlay Toggle (Default 'off' — 100% pure original song audio without added 4-on-the-floor kick!)
 const selectPad5to8Modal = document.getElementById("selectAutoDjPad5to8Fx");
 const btnPad5to8Live = document.getElementById("btnAutoDjPad5to8Toggle");
 function syncPad5to8Ui() {
 autoDj.pad5to8Fx = autoDj.edmDrumMode === "full";
 if (selectPad5to8Modal) {
 selectPad5to8Modal.value = autoDj.edmDrumMode;
 }
 if (btnPad5to8Live) {
 if (autoDj.edmDrumMode === "off") {
 btnPad5to8Live.textContent = " 4つ打ち追加音: OFF";
 } else if (autoDj.edmDrumMode === "kick") {
 btnPad5to8Live.textContent = " 4つ打ちのみ: ON";
 } else {
 btnPad5to8Live.textContent = " フルEDMドラム: ON";
 }
 const isAnyOn = autoDj.edmDrumMode !== "off";
 btnPad5to8Live.classList.toggle("btn-demo-gradient", isAnyOn);
 btnPad5to8Live.classList.toggle("btn-qr", !isAnyOn);
 }
 if (autoDj.enabled) {
 const useEdmDrums = autoDj.edmDrumMode !== "off" && isProEdmStyle(getEffectiveAutoDjStyle());
 engine.deck1.setEdmRemixMode(useEdmDrums, !autoDj.pad5to8Fx);
 engine.deck2.setEdmRemixMode(useEdmDrums, !autoDj.pad5to8Fx);
 }
 }
 if (selectPad5to8Modal) {
 selectPad5to8Modal.addEventListener("change", () => {
 autoDj.edmDrumMode = selectPad5to8Modal.value || "off";
 syncPad5to8Ui();
 });
 }
 if (btnPad5to8Live) {
 btnPad5to8Live.addEventListener("click", () => {
 const order = ["off", "kick", "full"];
 const nextIdx = (order.indexOf(autoDj.edmDrumMode) + 1) % order.length;
 autoDj.edmDrumMode = order[nextIdx];
 syncPad5to8Ui();
 });
 }
 syncPad5to8Ui();

 // Start Auto DJ Pro!
 document.getElementById("btnStartAutoDjNow").addEventListener("click", async () => {
 const started = await startAutoDjPerformance();
 if (started) {
 modal.classList.add("hidden");
 }
 });

 // Also reset force-drop echo state when user triggers immediate drop
 document.getElementById("btnAutoDjForceDrop").addEventListener("click", async () => {
 if (!autoDj.enabled) return;
 const activeId = autoDj.activeDeckId;
 const standbyId = activeId === 1 ? 2 : 1;
 const activeDeck = activeId === 1 ? engine.deck1 : engine.deck2;
 const standbyDeck = standbyId === 1 ? engine.deck1 : engine.deck2;
 const bpm = activeDeck.getCurrentBpm() || activeDeck.baseBpm || 120.0;
 const barSec = (60.0 / bpm) * 4.0;

 if (!autoDj.nextTrackPrepared && autoDjQueue.length > 0) {
 autoDj.nextTrackPrepared = true;
 autoDj.playlistCursor = (autoDj.playlistCursor + 1) % autoDjQueue.length;
 const nextTrack = autoDjQueue[autoDj.playlistCursor];
 const offset =
 autoDjQueue.length === 1
 ? (activeDeck.playheadSec + barSec * 4) % Math.max(10, activeDeck.duration - 16)
 : 0;
 await loadTrackIntoDeck(standbyId, nextTrack, offset);
 }
 if (standbyDeck.buffer && !standbyDeck.isPlaying) {
 engine.syncDeckToOther(standbyId);
 syncDeckTempoSliderUI(standbyId);
 }

 const buildUpStartBar = Math.max(3, autoDj.cycleBars - 4);
 autoDj.riserTriggered = false;
 autoDj.loopRollStage = 0;
 autoDj.echoFrozen = false;
 autoDj.cycleBeatsElapsed = buildUpStartBar * 4.0;
 autoDj.lastFrameAudioTime = engine.ctx.currentTime;
 });

 // Stop Auto DJ Pro
 document.getElementById("btnAutoDjStop").addEventListener("click", () => {
 stopAutoDjPerformance();
 });
 }

 async function startAutoDjPerformance() {
 engine.resume();

 // If queue is empty, pull in any tracks manually loaded onto Deck 1 / Deck 2
 if (autoDjQueue.length === 0) {
 if (engine.deck1.buffer && engine.deck1.track) addTrackToAutoDjQueue(engine.deck1.track);
 if (engine.deck2.buffer && engine.deck2.track) addTrackToAutoDjQueue(engine.deck2.track);
 }

 // If still 0 tracks selected, open the track selector modal so user can freely choose songs!
 if (autoDjQueue.length === 0) {
 renderAutoDjPlaylist();
 renderSavedLibraryInAutoDj();
 const modal = document.getElementById("autoDjModal");
 modal.classList.remove("hidden");
 const countEl = document.getElementById("autoDjTrackCount");
 if (countEl) {
 countEl.textContent = " まず曲を1曲以上追加してください！";
 }
 return false;
 }

 const tempoSelect = document.getElementById("selectAutoDjTempoMode");
 autoDj.tempoMode = tempoSelect ? tempoSelect.value : "smart_bpm";
 const tempoLive = document.getElementById("selectAutoDjTempoModeLive");
 if (tempoLive) tempoLive.value = autoDj.tempoMode;

 const transBarsSelect = document.getElementById("selectAutoDjTransitionBars");
 if (transBarsSelect) {
 autoDj.transitionBars = parseInt(transBarsSelect.value, 10) || 8;
 }
 const transBarsLive = document.getElementById("selectAutoDjTransBarsLive");
 if (transBarsLive) transBarsLive.value = String(autoDj.transitionBars);

 const eqModeSelect = document.getElementById("selectAutoDjEqMode");
 if (eqModeSelect) {
 autoDj.eqMode = eqModeSelect.value || "low_swap";
 autoDj.vocalAntiClash = autoDj.eqMode === "low_swap";
 }

 const mixInSelect = document.getElementById("selectAutoDjMixInStrategy");
 if (mixInSelect) {
 autoDj.mixInStrategy = mixInSelect.value || "smart_mashup";
 }

 const startBtn = document.getElementById("btnStartAutoDjNow");
 const origBtnText = startBtn ? startBtn.textContent : "";
 if (startBtn) startBtn.textContent = "⏳ 音源デコード＆原曲テンポ解析中...";

 // Load user's #1 and #2 setlist tracks onto Deck 1 & Deck 2 in exact order
 const firstTrack = autoDjQueue[0];
 const secondTrack = autoDjQueue.length > 1 ? autoDjQueue[1] : autoDjQueue[0];
 const secondOffset = autoDjQueue.length === 1 ? 15.0 : 0;

 if (!engine.deck1.buffer || engine.deck1.track?.id !== firstTrack.id) {
 await loadTrackIntoDeck(1, firstTrack, 0);
 }
 if (!engine.deck2.buffer || engine.deck2.track?.id !== secondTrack.id) {
 await loadTrackIntoDeck(2, secondTrack, secondOffset);
 }

 if (startBtn) startBtn.textContent = origBtnText;

 autoDj.enabled = true;
 autoDj.pausedInBackground = false;
 autoDj.style = document.getElementById("selectAutoDjStyle").value || "allstar";
 autoDj.cycleMode = document.getElementById("selectAutoDjCycleBars").value || "club";
 document.getElementById("selectAutoDjStyleLive").value = autoDj.style;

 // Set initial speed: Original Tempo (1.0x, +0.0%) in adaptive mode, or 128.0 BPM in lock128 mode!
 if (autoDj.tempoMode === "lock128") {
 lockDeckTo128BpmUI(1, 128.0);
 lockDeckTo128BpmUI(2, 128.0);
 } else {
 resetDeckToOriginalBpmUI(1);
 resetDeckToOriginalBpmUI(2);
 }
 renderAutoDjPlaylist();

 autoDj.activeDeckId = 1;
 // Deck 1 already holds [0] and Deck 2 already holds [1] (or [0] if single track), so mark Cycle 0 standby as prepared!
 autoDj.playlistCursor = autoDjQueue.length > 1 ? 1 : 0;
 autoDj.cycleCount = 0;
 autoDj.cycleBeatsElapsed = 0;
 autoDj.cycleStartPlayheadSec = engine.deck1.playheadSec || 0;
 refreshActiveAutoDjCycleBars();
 autoDj.lastFrameAudioTime = engine.ctx.currentTime;
 autoDj.lastBeatIndex = -1;
 autoDj.lastStep16Index = -1;
 autoDj.nextTrackPrepared = true;
 autoDj.riserTriggered = false;
 autoDj.loopRollStage = 0;
 autoDj.echoFrozen = false;

 engine.deck1.killEchoTail();
 engine.deck2.killEchoTail();

 const initEffStyle = getEffectiveAutoDjStyle();
 updateAutoDjLiveBadgeUI(initEffStyle);

 // Set initial mixer state for Deck 1 Drop: 100% pure studio-flat EQ (0.0 dB) for uncolored Hi-Fi audio
 engine.smartCfxEnabled = false;
 document.getElementById("btnSmartCfx")?.classList.remove("active");

 if (initEffStyle === "tokoto") {
 setCrossfaderProgrammatically(0.0);
 setChannelFaderProgrammatically(1, 0.94);
 setChannelFaderProgrammatically(2, 0.0);
 } else {
 setCrossfaderProgrammatically(-1.0);
 setChannelFaderProgrammatically(1, 0.94);
 setChannelFaderProgrammatically(2, 0.92);
 }
 setKnobProgrammatically("knobLow1", "low1", 0);
 setKnobProgrammatically("knobMid1", "mid1", 0);
 setKnobProgrammatically("knobHi1", "hi1", 0);
 setKnobProgrammatically("knobLow2", "low2", 0);
 setKnobProgrammatically("knobMid2", "mid2", 0);
 setKnobProgrammatically("knobHi2", "hi2", 0);
 setKnobProgrammatically("knobCfx1", "cfx1", 0);
 setKnobProgrammatically("knobCfx2", "cfx2", 0);

 // Default 'off': pure original track audio without added 4-on-the-floor kick or synthetic sidechain!
 const pad5to8Sel = document.getElementById("selectAutoDjPad5to8Fx");
 if (pad5to8Sel) {
 autoDj.edmDrumMode = pad5to8Sel.value || "off";
 autoDj.pad5to8Fx = autoDj.edmDrumMode === "full";
 }
 const useEdmRemix = autoDj.edmDrumMode !== "off" && isProEdmStyle(initEffStyle);
 engine.deck1.setEdmRemixMode(useEdmRemix, !autoDj.pad5to8Fx);
 engine.deck2.setEdmRemixMode(useEdmRemix, !autoDj.pad5to8Fx);

 // Start playing Deck 1 cleanly on phrase downbeat
 if (!engine.deck1.isPlaying) {
 document.getElementById("btnPlay1").click();
 }
 if (engine.deck2.isPlaying) {
 document.getElementById("btnPlay2").click();
 }

 // Optional Opening Impact ONLY when user explicitly enables added 4-on-the-floor EDM drums
 if (useEdmRemix && typeof engine.triggerMainstageDropImpact === "function") {
 engine.triggerMainstageDropImpact(autoDj.pad5to8Fx);
 }

 document.getElementById("autoDjLiveBar").classList.remove("hidden");
 document.getElementById("btnOpenAutoDjModal").classList.add("active-running");
 const btnQuickNicky = document.getElementById("btnQuickNickyRomero");
 if (btnQuickNicky) {
 btnQuickNicky.classList.add("active-running");
 }
 syncBackgroundPlaybackAndLockScreen(true);
 return true;
 }

 function stopAutoDjPerformance() {
 autoDj.enabled = false;
 autoDj.pausedInBackground = false;
 autoDj.riserTriggered = false;
 autoDj.loopRollStage = 0;
 autoDj.echoFrozen = false;
 engine.deck1.setEdmRemixMode(false);
 engine.deck2.setEdmRemixMode(false);
 engine.deck1.killEchoTail();
 engine.deck2.killEchoTail();
 engine.deck1.isScratching = false;
 engine.deck2.isScratching = false;
 engine.deck1.stopPadFx();
 engine.deck2.stopPadFx();
 if (engine.deck1.loopActive) engine.deck1.toggleReloopExit();
 if (engine.deck2.loopActive) engine.deck2.toggleReloopExit();
 updateLoopUI(1, engine.deck1);
 updateLoopUI(2, engine.deck2);

 // Restore original 1.0x speed (+0.0%) and studio-flat EQ when stopping Auto DJ
 engine.smartCfxEnabled = false;
 document.getElementById("btnSmartCfx")?.classList.remove("active");
 resetDeckToOriginalBpmUI(1);
 resetDeckToOriginalBpmUI(2);

 setChannelFaderProgrammatically(1, 0.92);
 setChannelFaderProgrammatically(2, 0.92);
 setKnobProgrammatically("knobCfx1", "cfx1", 0);
 setKnobProgrammatically("knobCfx2", "cfx2", 0);
 setKnobProgrammatically("knobLow1", "low1", 0);
 setKnobProgrammatically("knobLow2", "low2", 0);
 setKnobProgrammatically("knobMid1", "mid1", 0);
 setKnobProgrammatically("knobMid2", "mid2", 0);
 setKnobProgrammatically("knobHi1", "hi1", 0);
 setKnobProgrammatically("knobHi2", "hi2", 0);

 document.getElementById("autoDjLiveBar").classList.add("hidden");
 document.getElementById("btnOpenAutoDjModal").classList.remove("active-running");
 const btnQuickNicky = document.getElementById("btnQuickNickyRomero");
 if (btnQuickNicky) btnQuickNicky.classList.remove("active-running");
 syncBackgroundPlaybackAndLockScreen(true);
 }

 function setKnobProgrammatically(knobId, paramName, val) {
 const knob = document.getElementById(knobId);
 if (!knob) return;
 const min = parseFloat(knob.dataset.min);
 const max = parseFloat(knob.dataset.max);
 const clamped = Math.max(min, Math.min(max, val));
 knob.dataset.val = clamped;
 updateKnobVisual(knob);
 applyKnobParam(paramName, clamped);
 }

 function setCrossfaderProgrammatically(pos) {
 const xf = document.getElementById("crossfader");
 const clamped = Math.max(-1, Math.min(1, pos));
 if (xf) xf.value = clamped;
 engine.setCrossfader(clamped);
 }

 function setChannelFaderProgrammatically(deckId, val) {
 const fader = document.getElementById(`chFader${deckId}`);
 const clamped = Math.max(0, Math.min(1, val));
 if (fader) fader.value = clamped;
 const deck = deckId === 1 ? engine.deck1 : engine.deck2;
 deck.chFaderGain.gain.setTargetAtTime(clamped, engine.ctx.currentTime, 0.015);
 }

 function flashPadVisual(deckId, padIdx, durationMs = 200) {
 const pads = document.querySelectorAll(`#padsGrid${deckId} .hw-pad`);
 const pad = pads[padIdx];
 if (!pad) return;
 pad.classList.add("pad-active");
 setTimeout(() => pad.classList.remove("pad-active"), durationMs);
 }

 // Compute musical EDM drum/bar groove BPM from a deck's playback BPM
 // (keeps song audio at 100% original speed while folding extreme >152 or <72 BPM onto a natural dance pulse!)
 function getMusicalGrooveBpm(playbackBpm) {
 let g = Number(playbackBpm) || 120.0;
 if (g > 152.0) g *= 0.5;
 else if (g < 72.0) g *= 2.0;
 return g;
 }

 // Computes exact Phrase-Synced cycle length:
 // - 'club' (Club Dancefloor): 2〜3分構成 (64〜80小節) でサビ／ドロップ（16〜32小節）を完全に踊らせる！
 // - 'radio' (Radio Edit): 1分未満のショートダイジェスト (32小節)
 // - 'extended': 3分強のロング展開 (96小節)
 function computeAutoDjCycleBarsForDeck(deck, startPlayheadSec = 0) {
 const transBars = Number(autoDj.transitionBars) >= 0 ? Number(autoDj.transitionBars) : 8;
 if (!deck || !deck.buffer || !deck.duration) {
 return autoDj.cycleMode === "radio" ? 32 : 64;
 }
 const baseBpm = deck.baseBpm || 120.0;
 const grooveBpm = getMusicalGrooveBpm(baseBpm);
 const barSec = (60.0 / grooveBpm) * 4.0;
 const startSec = Math.max(0, startPlayheadSec || 0);
 const remainingSec = Math.max(16.0, deck.duration - startSec - 1.5);
 const maxSafeBars = Math.max(16, Math.floor(remainingSec / barSec));

 if (autoDj.cycleMode === "radio") {
 return Math.max(16, Math.min(maxSafeBars, 32));
 }
 if (autoDj.cycleMode === "extended" || autoDj.cycleMode === "96") {
 return Math.max(32, Math.min(maxSafeBars, 96));
 }
 if (autoDj.cycleMode === "32" || autoDj.cycleMode === "16" || autoDj.cycleMode === "64") {
 const b = parseInt(autoDj.cycleMode, 10);
 return Math.max(8, Math.min(maxSafeBars, b));
 }

 // Default 'club' / 'chorus' (Club Dancefloor): 2〜3分構成
 // Ensures: Intro + Verse + Build-up + FULL 16-32 BAR DROP/CHORUS completely plays out!
 const minClubBars = Math.min(maxSafeBars, 64);
 const targetChorusEndSec = deck.chorusEndSec && deck.chorusEndSec > startSec + barSec * 28
 ? deck.chorusEndSec + barSec * 16 // ensure the dancefloor rocks through the full drop!
 : startSec + barSec * minClubBars;

 const secUntilPastChorus = Math.max(barSec * 48, targetChorusEndSec - startSec);
 const phraseBlock = autoDj.phraseSync ? 16 : 4;
 // Snap Stage-1 groove length UP to a symmetric phrase block (16-bar dance block)
 const grooveBarsPastChorus = Math.ceil((secUntilPastChorus / barSec) / phraseBlock) * phraseBlock;
 const desiredTotalBars = grooveBarsPastChorus + transBars;
 return Math.max(32, Math.min(maxSafeBars, desiredTotalBars));
 }

 function refreshActiveAutoDjCycleBars() {
 const activeDeck = autoDj.activeDeckId === 2 ? engine.deck2 : engine.deck1;
 autoDj.cycleBars = computeAutoDjCycleBarsForDeck(activeDeck, autoDj.cycleStartPlayheadSec || 0);
 return autoDj.cycleBars;
 }

 // Pure Isolator Curve: eliminates low-frequency muddiness & clipping by ensuring LOW frequencies NEVER overlap!
 function applyAutoDjIsolatorLowSwap(activeDeckId, standbyDeckId, progress01) {
 const p = Math.max(0, Math.min(1, progress01));
 let actLow = 0;
 let stbLow = -26;

 if (autoDj.eqMode === "quick_cut") {
 // Hard Cut at 50%
 actLow = p < 0.5 ? 0 : -26;
 stbLow = p < 0.5 ? -26 : 0;
 } else {
 // 'low_swap' (Default Isolator): Rapid reciprocal handover around the transition center
 if (p < 0.40) {
 actLow = 0;
 stbLow = -26;
 } else if (p < 0.60) {
 const swapT = (p - 0.40) / 0.20;
 // Steep S-curve handover
 const steep = 0.5 - 0.5 * Math.cos(Math.PI * swapT);
 actLow = -26.0 * steep;
 stbLow = -26.0 * (1.0 - steep);
 } else {
 actLow = -26;
 stbLow = 0;
 }
 }

 setKnobProgrammatically(`knobLow${activeDeckId}`, `low${activeDeckId}`, actLow);
 setKnobProgrammatically(`knobLow${standbyDeckId}`, `low${standbyDeckId}`, stbLow);
 }

 // Dynamic Tempo Engine: supports Smart BPM (gentle tempo progression, half-time recognition, wide gap breakaways)
 function applyAutoDjDynamicTempo(activeId, standbyId, activeDeck, standbyDeck, currentBarIndex, mashupStartBar, totalCycleBars) {
 if (autoDj.tempoMode === "lock128") {
 if (Math.abs((activeDeck.getCurrentBpm() || 128.0) - 128.0) > 0.8 || !activeDeck.keyLock) {
 lockDeckTo128BpmUI(activeId, 128.0);
 }
 if (standbyDeck.buffer && (Math.abs((standbyDeck.getCurrentBpm() || 128.0) - 128.0) > 0.8 || !standbyDeck.keyLock)) {
 lockDeckTo128BpmUI(standbyId, 128.0);
 }
 return { tempoMorphActive: false, wideBpmGap: false, targetBpm: 128.0, isHalfTime: false };
 }

 const baseA = activeDeck.baseBpm || 120.0;

 // Handle post-drop BPM ramp-up in the first 4 bars of a new cycle
 if (autoDj.postDropRampActive && currentBarIndex < 4) {
 const rampProg = Math.min(1.0, (autoDj.cycleBeatsElapsed) / 16.0);
 const startBpm = autoDj.postDropRampStartBpm || baseA;
 const curTarget = startBpm + (baseA - startBpm) * rampProg;
 setDeckTargetBpmUI(activeId, curTarget);
 if (rampProg >= 0.99) {
 autoDj.postDropRampActive = false;
 resetDeckToOriginalBpmUI(activeId);
 }
 return { tempoMorphActive: true, wideBpmGap: false, targetBpm: baseA, isHalfTime: false };
 }

 // Stage 1 (Main Groove): Play Active Deck at 100% its Original Speed (+0.0%)!
 if (currentBarIndex < mashupStartBar || !standbyDeck.buffer) {
 const curA = activeDeck.getCurrentBpm() || baseA;
 if (Math.abs(curA - baseA) > 0.15) {
 const nextBpm = curA + (baseA - curA) * 0.15;
 if (Math.abs(nextBpm - baseA) < 0.2) {
 resetDeckToOriginalBpmUI(activeId);
 } else {
 setDeckTargetBpmUI(activeId, nextBpm);
 }
 } else if (activeDeck.tempoSliderPos !== 0 || !activeDeck.keyLock) {
 resetDeckToOriginalBpmUI(activeId);
 }
 return { tempoMorphActive: false, wideBpmGap: false, targetBpm: baseA, isHalfTime: false };
 }

 // Stages 2, 3, 4: Evaluate BPM difference and half/double tempo relationships
 const baseB = standbyDeck.baseBpm || baseA;
 const match = engine.getBestBeatGridMatch(baseA, baseB);
 const targetGridBpm = match.effectiveBaseBpm;
 const relDiff = match.relDiff;
 const isHalfTime = Math.abs(match.mult - 0.5) < 0.05 || Math.abs(match.mult - 2.0) < 0.05;
 const isChilloutBreak = relDiff > 0.22 && !isHalfTime; // e.g. 143 down to 94 ballad

 if (isChilloutBreak || autoDj.tempoMode === "adaptive") {
 // Ballad / Chillout break: Keep tracks at native pitch and use clean Echo-Wash / Vocal-Break Cut-In!
 if (activeDeck.tempoSliderPos !== 0 || Math.abs((activeDeck.getCurrentBpm() || baseA) - baseA) > 0.1) {
 resetDeckToOriginalBpmUI(activeId);
 }
 if (standbyDeck.tempoSliderPos !== 0 || Math.abs((standbyDeck.getCurrentBpm() || baseB) - baseB) > 0.1) {
 resetDeckToOriginalBpmUI(standbyId);
 }
 return {
 tempoMorphActive: false,
 wideBpmGap: true,
 targetBpm: baseB,
 isHalfTime: false
 };
 }

 // BPM RAMP-UP (BPMスロープ / テンポランプアップ)
 // 4〜6小節かけて前曲を次曲のテンポへ向けてじわじわ加速/減速（最大±5%）
 // 次曲はブリッジテンポで立ち上がり、ドロップ後の最初の4小節で目標テンポへスムーズに加速！
 const transStartBeat = mashupStartBar * 4.0;
 const transSpanBeats = Math.max(4.0, (totalCycleBars - mashupStartBar) * 4.0);
 const transT = Math.max(0, Math.min(1, (autoDj.cycleBeatsElapsed - transStartBeat) / transSpanBeats));
 const smoothMorph = 0.5 - 0.5 * Math.cos(Math.PI * transT);

 const maxRampPct = 0.052; // max safe ±5.2% glide
 const maxBpmDelta = baseA * maxRampPct;
 const rawDelta = (targetGridBpm - baseA) * smoothMorph;
 const clampedDelta = Math.max(-maxBpmDelta, Math.min(maxBpmDelta, rawDelta));
 const rampedActiveBpm = baseA + clampedDelta;

 setDeckTargetBpmUI(activeId, rampedActiveBpm);

 const standbyTargetBpm = rampedActiveBpm / match.mult;
 const clampedStandbyBpm = Math.max(baseB * 0.94, Math.min(baseB * 1.06, standbyTargetBpm));
 setDeckTargetBpmUI(standbyId, clampedStandbyBpm);

 autoDj.postDropRampStartBpm = clampedStandbyBpm;
 autoDj.postDropRampActive = Math.abs(clampedStandbyBpm - baseB) > 0.35;

 return {
 tempoMorphActive: true,
 wideBpmGap: false,
 targetBpm: baseB,
 isHalfTime
 };
 }

 // Called at 60fps from renderLoop when autoDj.enabled === true
 // Supports:
 // - David Guetta @ Tomorrowland 2026 MainStage (t=1336s Future Rave / Afro-Tech, Acapella Stem Mashup, 3/4-Beat Echo-Freeze Fader Slam)
 // - MITOMI TOKOTO @ ageHa (=KICK-ASS= Pioneer DJM Vertical Channel Fader Harmonic Blend, HPF+1/2-Beat Echo Pull, Beat-Synced Vertical Cut-Ins)
 // - Nicky Romero @ Tomorrowland 2019 MainStage (Vocal-Over-Drop Bootleg, 2B->1B CDJ Loop Roll, 1-Beat Pre-Drop Spotlight)
 // - PRO ALL-STAR (Rotates Guetta -> MITOMI TOKOTO -> Nicky Romero automatically each cycle!)
 function updateAutoDjFrame() {
 if (!autoDj.enabled || autoDj.pausedInBackground) return;

 const now = engine.ctx.currentTime;
 const dt = Math.max(0, Math.min(1.0, now - (autoDj.lastFrameAudioTime || now)));
 autoDj.lastFrameAudioTime = now;

 const activeId = autoDj.activeDeckId;
 const standbyId = activeId === 1 ? 2 : 1;
 const activeDeck = activeId === 1 ? engine.deck1 : engine.deck2;
 const standbyDeck = standbyId === 1 ? engine.deck1 : engine.deck2;

 if (!activeDeck.buffer) return;

 const effStyle = getEffectiveAutoDjStyle();
 updateAutoDjLiveBadgeUI(effStyle);

 // Ensure active deck never stops if track reaches end
 if (!activeDeck.isPlaying && activeDeck.duration > 0) {
 if (activeDeck.playheadSec >= activeDeck.duration - 1.0) {
 activeDeck.seekTo(activeDeck.phraseCueSec || 0);
 }
 activeDeck.isPlaying = true;
 const playBtn = document.getElementById(`btnPlay${activeId}`);
 playBtn.classList.add("playing");
 playBtn.textContent = "";
 }

 const totalCycleBars = autoDj.cycleBars;
 const totalCycleBeats = totalCycleBars * 4.0;
 const mashupStartBar = Math.max(2, totalCycleBars - 6); // Stage 2: Stem Mashup / Vertical-Fader Harmonic Blend (2 bars)
 const buildUpStartBar = Math.max(3, totalCycleBars - 4); // Stage 3: CDJ Loop / Filter+Echo Tension Pull (2 bars)
 const dropMixStartBar = Math.max(4, totalCycleBars - 2); // Stage 4: Echo-Freeze Slam / Vertical Fader Cut-Ins / Spotlight -> DROP (2 bars)

 const preBarIdx = Math.floor(autoDj.cycleBeatsElapsed / 4.0);
 const tempoInfo = applyAutoDjDynamicTempo(
 activeId,
 standbyId,
 activeDeck,
 standbyDeck,
 preBarIdx,
 mashupStartBar,
 totalCycleBars
 );

 const activeBpm = activeDeck.getCurrentBpm() || activeDeck.baseBpm || 120.0;
 const grooveBpm = getMusicalGrooveBpm(activeBpm);
 const beatSec = 60.0 / grooveBpm;
 const barSec = beatSec * 4.0;

 // Integrate elapsed musical beats smoothly across dynamic tempo changes!
 autoDj.cycleBeatsElapsed += dt * (grooveBpm / 60.0);

 const progressPct = Math.min(100, (autoDj.cycleBeatsElapsed / totalCycleBeats) * 100);
 const currentBeatFloat = autoDj.cycleBeatsElapsed;
 const currentBeatInt = Math.floor(currentBeatFloat);
 const currentStep16Int = Math.floor(currentBeatFloat * 4.0);
 const stepInBar16 = ((currentStep16Int % 16) + 16) % 16; // 0 .. 15
 const currentBarIndex = Math.floor(currentBeatInt / 4); // 0 .. totalCycleBars-1
 const beatInBar = (currentBeatInt % 4) + 1; // 1 .. 4

 // Smart Low-Cut Attack: 1拍目で9:30(-7.5dB)にカット、2〜4拍目でスムーズに12時(0dB)へ復帰
 if (autoDj.lowAttackRampActive) {
 if (currentBarIndex === 0 && autoDj.cycleBeatsElapsed < 4.0) {
 const rampT = Math.max(0, Math.min(1.0, (autoDj.cycleBeatsElapsed - 0.95) / 3.05));
 const curLow = -7.5 * (1.0 - rampT);
 setKnobProgrammatically(`knobLow${activeId}`, `low${activeId}`, curLow);
 if (rampT >= 1.0) {
 autoDj.lowAttackRampActive = false;
 setKnobProgrammatically(`knobLow${activeId}`, `low${activeId}`, 0);
 }
 } else {
 autoDj.lowAttackRampActive = false;
 setKnobProgrammatically(`knobLow${activeId}`, `low${activeId}`, 0);
 }
 }

 document.getElementById("autoDjProgressBar").style.width = `${progressPct.toFixed(1)}%`;

 // Graphical countdown in Bar Counter (e.g. BAR 12/64 [TRANSITION IN: 8])
 const barsUntilTrans = Math.max(0, mashupStartBar - currentBarIndex);
 const barsUntilDrop = Math.max(0, totalCycleBars - currentBarIndex);
 const countdownSuffix =
 currentBarIndex < mashupStartBar
 ? ` [TRANS IN: ${barsUntilTrans}]`
 : ` [DROP IN: ${barsUntilDrop}]`;
 document.getElementById("autoDjBarCounter").textContent = `BAR ${currentBarIndex + 1}/${totalCycleBars}${countdownSuffix}`;

 const isNewBeat = currentBeatInt !== autoDj.lastBeatIndex;
 if (isNewBeat) {
 autoDj.lastBeatIndex = currentBeatInt;
 }

 const isNewStep16 = currentStep16Int !== autoDj.lastStep16Index;
 if (isNewStep16) {
 autoDj.lastStep16Index = currentStep16Int;
 }

 const statusEl = document.getElementById("autoDjStatusText");
 const totalBuildSpanBeats = Math.max(4.0, (totalCycleBars - buildUpStartBar) * 4.0);
 const overallBuildProg =
 currentBarIndex >= buildUpStartBar
 ? Math.max(0, Math.min(1, (autoDj.cycleBeatsElapsed - buildUpStartBar * 4.0) / totalBuildSpanBeats))
 : 0;

 const mixSpanBeatsAll = Math.max(4.0, (totalCycleBars - dropMixStartBar) * 4.0);
 const stage4MixT =
 currentBarIndex >= dropMixStartBar
 ? Math.max(0, Math.min(1, (autoDj.cycleBeatsElapsed - dropMixStartBar * 4.0) / mixSpanBeatsAll))
 : 0;

 // Style-specific pre-drop kick-cut / suspension windows:
 const isNickySpotlightBeat =
 (effStyle === "nicky" || effStyle === "festival") &&
 autoDj.cycleBeatsElapsed >= totalCycleBeats - 1.0 &&
 autoDj.cycleBeatsElapsed < totalCycleBeats;

 const isGuettaEchoSlamWindow =
 effStyle === "guetta" &&
 currentBarIndex >= dropMixStartBar &&
 stage4MixT >= 0.55 &&
 autoDj.cycleBeatsElapsed < totalCycleBeats;

 const isTokotoPreDropLift =
 effStyle === "tokoto" &&
 currentBarIndex >= dropMixStartBar &&
 stage4MixT >= 0.80 &&
 autoDj.cycleBeatsElapsed < totalCycleBeats;

 // ==================== OPTIONAL 16-STEP EDM DRUM SEQUENCER (DEFAULT OFF = PURE ORIGINAL SONG AUDIO!) ====================
 if (isNewStep16 && autoDj.cycleBeatsElapsed < totalCycleBeats) {
 if (autoDj.edmDrumMode !== "off" && isProEdmStyle(effStyle)) {
 engine.deck1.setEdmRemixMode(true, !autoDj.pad5to8Fx);
 engine.deck2.setEdmRemixMode(true, !autoDj.pad5to8Fx);

 let phaseMode = "groove";
 if (isNickySpotlightBeat || isGuettaEchoSlamWindow || isTokotoPreDropLift) {
 phaseMode = "vocal_spotlight";
 } else if (currentBarIndex >= buildUpStartBar) {
 phaseMode = "buildup";
 } else if (currentBarIndex >= mashupStartBar) {
 phaseMode = "mashup";
 }
 const rootHz =
 currentBarIndex >= dropMixStartBar && standbyDeck.rootFreq
 ? standbyDeck.rootFreq
 : activeDeck.rootFreq || 55.0;

 engine.triggerEdmRemixStep(
 stepInBar16,
 currentBarIndex,
 phaseMode,
 rootHz,
 beatSec,
 overallBuildProg,
 autoDj.cycleCount,
 autoDj.pad5to8Fx
 );

 const flashDeck = currentBarIndex >= dropMixStartBar ? standbyId : activeId;
 if (stepInBar16 % 4 === 0) {
 flashPadVisual(flashDeck, (stepInBar16 / 4) % 4, 110);
 } else if (autoDj.pad5to8Fx && stepInBar16 % 4 === 2) {
 flashPadVisual(flashDeck, 4 + (((stepInBar16 - 2) / 4) % 4), 90);
 }
 } else {
 engine.deck1.setEdmRemixMode(false);
 engine.deck2.setEdmRemixMode(false);
 }
 }

 const startXf = activeId === 1 ? -1.0 : 1.0;
 const endXf = standbyId === 1 ? -1.0 : 1.0;

 // ==================== CYCLE BOUNDARY (BEAT 1): MASSIVE DROP AT NEW TRACK'S ORIGINAL TEMPO! ====================
 if (autoDj.cycleBeatsElapsed >= totalCycleBeats) {
 activeDeck.loopActive = false;
 standbyDeck.loopActive = false;
 activeDeck.stopPadFx();
 standbyDeck.stopPadFx();
 activeDeck.isScratching = false;
 standbyDeck.isScratching = false;
 // Keep outgoing activeDeck's frozen echo tail ringing naturally across Bar 1 of the new drop if Echo-Frozen!
 if (!autoDj.echoFrozen) {
 activeDeck.killEchoTail();
 }
 standbyDeck.killEchoTail();
 updateLoopUI(1, engine.deck1);
 updateLoopUI(2, engine.deck2);

 // Land cleanly on Incoming Track's 100% Original Speed (+0.0%) and studio-flat EQ!
 engine.smartCfxEnabled = false;
 document.getElementById("btnSmartCfx")?.classList.remove("active");
 if (autoDj.tempoMode === "adaptive") {
 resetDeckToOriginalBpmUI(standbyId);
 resetDeckToOriginalBpmUI(activeId);
 }

 // Advance cycle count first so we know next cycle's effective style for seamless fader positioning
 const finishingStyle = effStyle;
 autoDj.activeDeckId = standbyId;
 autoDj.cycleCount += 1;
 const nextEffStyle = getEffectiveAutoDjStyle();
 updateAutoDjLiveBadgeUI(nextEffStyle);

 if (nextEffStyle === "tokoto" || finishingStyle === "tokoto") {
 setCrossfaderProgrammatically(nextEffStyle === "tokoto" ? 0.0 : endXf);
 setChannelFaderProgrammatically(standbyId, 0.94);
 setChannelFaderProgrammatically(activeId, nextEffStyle === "tokoto" ? 0.0 : 0.92);
 } else {
 setChannelFaderProgrammatically(standbyId, 0.94);
 setChannelFaderProgrammatically(activeId, 0.92);
 setCrossfaderProgrammatically(endXf);
 }

 // Smart Low-Cut Attack: 1拍目で9:30(-7.5dB)にカット、2〜4拍目で12時フラットへ滑らか復帰
 if (autoDj.smartLowAttack) {
 setKnobProgrammatically(`knobLow${standbyId}`, `low${standbyId}`, -7.5);
 autoDj.lowAttackRampActive = true;
 } else {
 setKnobProgrammatically(`knobLow${standbyId}`, `low${standbyId}`, 0);
 }
 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 0);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0);
 setKnobProgrammatically(`knobLow${activeId}`, `low${activeId}`, 0);
 setKnobProgrammatically(`knobMid${activeId}`, `mid${activeId}`, 0);
 setKnobProgrammatically(`knobHi${activeId}`, `hi${activeId}`, 0);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 0);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, 0);

 if (activeDeck.isPlaying) {
 document.getElementById(`btnPlay${activeId}`).click();
 }

 if (autoDj.edmDrumMode !== "off" && isProEdmStyle(finishingStyle)) {
 if (typeof engine.triggerMainstageDropImpact === "function") {
 engine.triggerMainstageDropImpact(autoDj.pad5to8Fx);
 }
 flashPadVisual(standbyId, 0, 480);
 flashPadVisual(standbyId, 3, 480);
 if (autoDj.pad5to8Fx) {
 flashPadVisual(standbyId, 7, 480);
 }
 } else if (autoDj.edmDrumMode !== "off" && (finishingStyle === "club" || finishingStyle === "scratch")) {
 if (autoDj.pad5to8Fx) {
 engine.triggerSamplerPad(3);
 }
 flashPadVisual(standbyId, 3, 450);
 }

 autoDj.cycleBeatsElapsed = 0;
 autoDj.cycleStartPlayheadSec = standbyDeck.playheadSec || 0;
 refreshActiveAutoDjCycleBars();
 autoDj.lastBeatIndex = -1;
 autoDj.lastStep16Index = -1;
 autoDj.nextTrackPrepared = false;
 autoDj.riserTriggered = false;
 autoDj.loopRollStage = 0;
 autoDj.echoFrozen = false;
 syncBackgroundPlaybackAndLockScreen(true);
 return;
 }

 // Prepare standby track silently after Bar 1 of the cycle
 if (!autoDj.nextTrackPrepared && currentBarIndex >= 1 && autoDjQueue.length > 0) {
 standbyDeck.killEchoTail();
 autoDj.nextTrackPrepared = true;
 autoDj.playlistCursor = (autoDj.playlistCursor + 1) % autoDjQueue.length;
 const nextTrack = autoDjQueue[autoDj.playlistCursor];
 const offset =
 autoDjQueue.length === 1
 ? (activeDeck.playheadSec + barSec * 4) % Math.max(10, activeDeck.duration - 16)
 : 0;
 loadTrackIntoDeck(standbyId, nextTrack, offset);
 }

 // ==================== WIDE BPM GAP OR LIVE MASHUP / LAYERING TRANSITION ====================
 // Prevents extreme BPM warping on ballads, or activates Live Mashup Layering on dance tracks!
 if ((tempoInfo.wideBpmGap || autoDj.vocalAntiClash || autoDj.mixInStrategy === "smart_mashup") && currentBarIndex >= mashupStartBar) {
 activeDeck.isScratching = false;

 // ---------- STAGE 2 & 3 (mashupStartBar to dropMixStartBar) ----------
 if (currentBarIndex < dropMixStartBar) {
 if (tempoInfo.wideBpmGap) {
 // Ballad / Chillout Break: Play active deck clean, prep standby deck silently
 if (currentBarIndex === dropMixStartBar - 1) {
 const preEchoT = Math.max(0, Math.min(1, (autoDj.cycleBeatsElapsed - (dropMixStartBar - 1) * 4.0) / 4.0));
 activeDeck.setEchoSend(preEchoT * 0.18, beatSec * 1.0, 0.62);
 } else {
 activeDeck.killEchoTail();
 }
 setChannelFaderProgrammatically(activeId, 0.94);
 if (effStyle === "tokoto") {
 setCrossfaderProgrammatically(0.0);
 if (!standbyDeck.isPlaying) setChannelFaderProgrammatically(standbyId, 0.0);
 } else {
 setCrossfaderProgrammatically(startXf);
 }
 setKnobProgrammatically(`knobLow${activeId}`, `low${activeId}`, 0);
 setKnobProgrammatically(`knobMid${activeId}`, `mid${activeId}`, 0);
 setKnobProgrammatically(`knobHi${activeId}`, `hi${activeId}`, 0);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, 0);

 const gapLabel = tempoInfo.isHalfTime ? " [HALF-TEMPO]" : " [WIDE BPM GAP]";
 statusEl.textContent = `[CHILLOUT BREAK] DECK ${activeId} 原曲速度 ${activeBpm.toFixed(1)} BPM 次曲 ${standbyDeck.track?.title || "待機中"} (${(standbyDeck.baseBpm || 120).toFixed(1)} BPM)${gapLabel} クリーン切替準備`;
 return;
 }

 // ---------- LIVE MASHUP & LAYERING (STEM EQ SEPARATION) ----------
 // Starts standby deck at its build-up / vocal hook in exact beat-sync!
 // Track A plays Kick & Bass (LOW 0dB), Track B layers Vocals/Melody on top (LOW -26dB, MID +1dB)
 if (standbyDeck.buffer && !standbyDeck.isPlaying) {
 engine.syncDeckToOther(standbyId);
 syncDeckTempoSliderUI(standbyId);
 document.getElementById(`btnPlay${standbyId}`).click();
 }

 const mashupSpanBeats = Math.max(4.0, (dropMixStartBar - mashupStartBar) * 4.0);
 const mashupT = Math.max(0, Math.min(1.0, (autoDj.cycleBeatsElapsed - mashupStartBar * 4.0) / mashupSpanBeats));
 const smoothBlend = 0.5 - 0.5 * Math.cos(Math.PI * mashupT);

 // Deck A (Rhythm/Groove Foundation): LOW 0dB (driving room), MID -2.2dB (leaves room for incoming lyrics)
 setKnobProgrammatically(`knobLow${activeId}`, `low${activeId}`, 0);
 setKnobProgrammatically(`knobMid${activeId}`, `mid${activeId}`, -2.2 * smoothBlend);
 setKnobProgrammatically(`knobHi${activeId}`, `hi${activeId}`, 0);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, 0);
 setChannelFaderProgrammatically(activeId, 0.94);

 // Deck B (Incoming Vocal / Top Layer): LOW -26dB (zero bass conflict!), MID +1.0dB (vocals shine)
 setKnobProgrammatically(`knobLow${standbyId}`, `low${standbyId}`, -26);
 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 1.2 * smoothBlend);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0.0);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 0);

 // Channel Faders & Crossfader: Center crossfader, blend in Deck B
 const inFader = 0.88 * Math.min(1.0, mashupT * 1.4);
 setChannelFaderProgrammatically(standbyId, inFader);
 setCrossfaderProgrammatically(0.0);

 const barsToDrop = Math.max(1, totalCycleBars - currentBarIndex);
 const countdownTag = barsToDrop === 1 ? "DROP NEXT BAR!" : `DROP IN: ${barsToDrop} BARS`;
 const tempoTag = tempoInfo.tempoMorphActive
 ? `テンポ同調 ${activeBpm.toFixed(1)} ${tempoInfo.targetBpm.toFixed(1)} BPM`
 : `${activeBpm.toFixed(1)} BPM`;

 statusEl.textContent = `[LIVE MASHUP & LAYERING] DECK ${activeId} リズム × DECK ${standbyId} ボーカル・ビルドアップ重ね (${tempoTag}) [${countdownTag}]`;
 return;
 }

 // Stage 4 (Final 2 bars): Execute 1-beat Freeze Echo + HPF Washout on outgoing vocals, then Clean Attack on Incoming Downbeat!
 if (standbyDeck.buffer && !standbyDeck.isPlaying) {
 if (autoDj.tempoMode === "adaptive" || autoDj.tempoMode === "smart_bpm") {
 resetDeckToOriginalBpmUI(standbyId);
 }
 setKnobProgrammatically(`knobLow${standbyId}`, `low${standbyId}`, -26);
 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 0);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 0);
 setChannelFaderProgrammatically(standbyId, 0.94);
 document.getElementById(`btnPlay${standbyId}`).click();
 }

 const mixT = stage4MixT;

 // 1. Outgoing Deck: 1-Beat Stereo Freeze Echo + High-Pass Filter Washout (lifts vocals into space)
 if (mixT >= 0.30 && !autoDj.echoFrozen) {
 autoDj.echoFrozen = true;
 activeDeck.freezeEchoTail(0.78);
 }
 activeDeck.setEchoSend(0.24 + mixT * 0.45, beatSec * 1.0, 0.78);
 // Smooth power-law curve: keeps audio presence alive right up to the Downbeat (zero dead air)
 const outFader = 0.94 * Math.max(0, 1.0 - Math.pow(mixT, 1.6));
 setChannelFaderProgrammatically(activeId, outFader);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, mixT * 30.0); // Smooth HPF sweep

 // Energy management: Trigger white noise sweep / riser on the final 1.5 beats to fill the acoustic gap
 if (mixT >= 0.75 && !autoDj.riserTriggered) {
 autoDj.riserTriggered = true;
 engine.triggerTransitionRiser(beatSec * 2.0);
 }

 // 2. Pure Isolator Low Swap: guarantees kick/bass frequencies NEVER clash!
 applyAutoDjIsolatorLowSwap(activeId, standbyId, mixT);

 // 3. Incoming Deck: Clean Attack on phrase downbeat
 const smoothFade = 0.5 - 0.5 * Math.cos(Math.PI * mixT);
 if (effStyle === "tokoto") {
 setCrossfaderProgrammatically(0.0);
 setChannelFaderProgrammatically(standbyId, 0.94 * Math.min(1, mixT * 1.5));
 } else {
 setChannelFaderProgrammatically(standbyId, 0.94);
 setCrossfaderProgrammatically(startXf + (endXf - startXf) * smoothFade);
 }
 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 0);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 0);

 const barsToDrop = Math.max(1, totalCycleBars - currentBarIndex);
 const countdownTag = barsToDrop === 1 ? "DROP NEXT BAR!" : `DROP IN: ${barsToDrop} BARS`;
 statusEl.textContent = `[PHRASE ATTACK] セリフ被り防止 1拍エコー浮遊 + ${countdownTag} -> DECK ${standbyId} (${(standbyDeck.baseBpm || 120).toFixed(1)} BPM) 1拍目着地 (${Math.round(mixT * 100)}%)`;
 return;
 }

 // ==================== STAGE 1 & STAGE 2: PURE HI-FI GROOVE & SMOOTH HARMONIC BLEND ====================
 if (currentBarIndex < buildUpStartBar) {
 activeDeck.killEchoTail();

 // ---------- STAGE 2: STYLE-SPECIFIC SMOOTH HARMONIC BLEND (CLOSE BPMs <= 6%) ----------
 if (currentBarIndex >= mashupStartBar && standbyDeck.buffer) {
 const blendSpanBeats = Math.max(4.0, (buildUpStartBar - mashupStartBar) * 4.0);
 const blendT = Math.max(0, Math.min(1, (autoDj.cycleBeatsElapsed - mashupStartBar * 4.0) / blendSpanBeats));
 const smoothBlend = 0.5 - 0.5 * Math.cos(Math.PI * blendT);
 const tempoTag = tempoInfo.tempoMorphActive
 ? `テンポ同調 ${activeBpm.toFixed(1)} ${tempoInfo.targetBpm.toFixed(1)} BPM`
 : `${activeBpm.toFixed(1)} BPM`;

 // Apply Pure Isolator Low Swap during blend
 applyAutoDjIsolatorLowSwap(activeId, standbyId, smoothBlend * 0.4);

 if (effStyle === "guetta") {
 if (!standbyDeck.isPlaying) {
 engine.syncDeckToOther(standbyId);
 syncDeckTempoSliderUI(standbyId);
 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 0.4);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0.0);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 6);
 setChannelFaderProgrammatically(standbyId, 0.35);
 document.getElementById(`btnPlay${standbyId}`).click();
 }
 setChannelFaderProgrammatically(activeId, 0.94);
 setChannelFaderProgrammatically(standbyId, 0.35 + smoothBlend * 0.45);
 setKnobProgrammatically(`knobMid${activeId}`, `mid${activeId}`, 0);
 setKnobProgrammatically(`knobHi${activeId}`, `hi${activeId}`, 0);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, 0);
 setCrossfaderProgrammatically(startXf * (1.0 - smoothBlend * 0.75));
 statusEl.textContent = ` [DAVID GUETTA STEM BLEND] DECK ${activeId} × DECK ${standbyId} ハーモニック重ね (${tempoTag})`;
 return;
 }

 if (effStyle === "tokoto") {
 if (!standbyDeck.isPlaying) {
 engine.syncDeckToOther(standbyId);
 syncDeckTempoSliderUI(standbyId);
 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 0.3);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0.0);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 5);
 setChannelFaderProgrammatically(standbyId, 0.16);
 document.getElementById(`btnPlay${standbyId}`).click();
 }
 setCrossfaderProgrammatically(0.0);
 setChannelFaderProgrammatically(activeId, 0.94);
 setChannelFaderProgrammatically(standbyId, 0.16 + smoothBlend * 0.62);
 setKnobProgrammatically(`knobMid${activeId}`, `mid${activeId}`, 0);
 setKnobProgrammatically(`knobHi${activeId}`, `hi${activeId}`, 0);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, 0);
 statusEl.textContent = ` [MITOMI TOKOTO @ ageHa] 縦フェーダー CH${standbyId} ハーモニック調合中 (${tempoTag})`;
 return;
 }

 // Nicky Romero @ TML 2019 & other styles: Clean Vocal-Over-Groove Blend
 if (!standbyDeck.isPlaying) {
 engine.syncDeckToOther(standbyId);
 syncDeckTempoSliderUI(standbyId);
 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 0.4);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0.0);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 6);
 setChannelFaderProgrammatically(standbyId, 0.90);
 document.getElementById(`btnPlay${standbyId}`).click();
 }
 setChannelFaderProgrammatically(activeId, 0.94);
 setKnobProgrammatically(`knobMid${activeId}`, `mid${activeId}`, 0);
 setKnobProgrammatically(`knobHi${activeId}`, `hi${activeId}`, 0);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, 0);
 const curXf = startXf * (1.0 - smoothBlend * 0.55);
 setCrossfaderProgrammatically(curXf);
 statusEl.textContent = ` [HARMONIC BLEND] DECK ${activeId} × DECK ${standbyId} スムース重ね (${tempoTag})`;
 return;
 }

 // ---------- STAGE 1: 100% BIT-PURE HI-FI MAIN GROOVE (ZERO PERIODIC CHOPS OR FILTER DIPS!) ----------
 const speedDesc = autoDj.tempoMode === "adaptive" || autoDj.tempoMode === "smart_bpm"
 ? `原曲速度 ${activeBpm.toFixed(1)} BPM (+0.0%)`
 : "128.0 BPM 固定";
 const nextTitle = standbyDeck.track?.title || "待機中";

 setKnobProgrammatically(`knobLow${activeId}`, `low${activeId}`, 0);
 setKnobProgrammatically(`knobMid${activeId}`, `mid${activeId}`, 0);
 setKnobProgrammatically(`knobHi${activeId}`, `hi${activeId}`, 0);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, 0);
 setChannelFaderProgrammatically(activeId, 0.94);

 if (effStyle === "tokoto") {
 activeDeck.isScratching = false;
 setCrossfaderProgrammatically(0.0);
 if (!standbyDeck.isPlaying) {
 setChannelFaderProgrammatically(standbyId, 0.0);
 }
 statusEl.textContent = ` [MITOMI TOKOTO @ ageHa] DECK ${activeId} (${speedDesc} / 次曲: ${nextTitle})`;
 return;
 }

 setCrossfaderProgrammatically(startXf);

 if (effStyle === "guetta") {
 activeDeck.isScratching = false;
 statusEl.textContent = ` [DAVID GUETTA @ TML 2026] DECK ${activeId} (${speedDesc} / 次曲: ${nextTitle})`;
 return;
 }

 if (effStyle === "scratch" && autoDj.pad5to8Fx) {
 const barMod = currentBarIndex % 4;
 if (barMod === 2 && beatInBar >= 3) {
 statusEl.textContent = ` [DECK ${activeId}] リズミック・スクラッチ実演中 (${activeBpm.toFixed(1)} BPM)`;
 activeDeck.isScratching = true;
 const scratchOsc = Math.sin(now * 24.0) * 1.4;
 activeDeck.scratchVelocity = scratchOsc;
 activeDeck.platterAngle = (activeDeck.platterAngle + scratchOsc * 4.0) % 360;
 } else {
 activeDeck.isScratching = false;
 statusEl.textContent = ` [DECK ${activeId}] ${speedDesc} グルーヴ再生中 (次曲: ${nextTitle})`;
 }
 return;
 }

 activeDeck.isScratching = false;
 statusEl.textContent = ` [NICKY ROMERO @ TML 2019] DECK ${activeId} (${speedDesc} / 次曲: ${nextTitle})`;
 return;
 }

 // ==================== STAGE 3: SMOOTH HI-FI BUILD-UP (WARM FILTER + ECHO SWELL) ====================
 if (currentBarIndex >= buildUpStartBar && currentBarIndex < dropMixStartBar) {
 activeDeck.isScratching = false;
 const buildSpanBeats = Math.max(4.0, (dropMixStartBar - buildUpStartBar) * 4.0);
 const buildT = Math.max(
 0,
 Math.min(1, (autoDj.cycleBeatsElapsed - buildUpStartBar * 4.0) / buildSpanBeats)
 );
 const smoothRise = 0.5 - 0.5 * Math.cos(Math.PI * buildT);

 // Low Swap during build-up: activeDeck LOW gradually closes while standbyDeck LOW is held at -26dB
 applyAutoDjIsolatorLowSwap(activeId, standbyId, 0.35 + smoothRise * 0.25);

 if (standbyDeck.buffer && !standbyDeck.isPlaying) {
 engine.syncDeckToOther(standbyId);
 syncDeckTempoSliderUI(standbyId);
 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 0.3);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0.0);
 setChannelFaderProgrammatically(standbyId, effStyle === "tokoto" ? 0.84 : 0.90);
 document.getElementById(`btnPlay${standbyId}`).click();
 }

 if (!autoDj.riserTriggered) {
 autoDj.riserTriggered = true;
 if (autoDj.pad5to8Fx && typeof engine.triggerFestivalWhiteNoiseRiser === "function") {
 engine.triggerFestivalWhiteNoiseRiser((buildSpanBeats + 7.0) * beatSec);
 }
 }

 const tempoTransitionMsg = tempoInfo.tempoMorphActive
 ? ` ＆ 次曲 (${tempoInfo.targetBpm.toFixed(1)} BPM) へ滑らか同期`
 : "";

 if (effStyle === "guetta") {
 if (autoDj.pad5to8Fx) {
 if (autoDj.loopRollStage === 0) {
 activeDeck.triggerAutoLoop4Beat();
 activeDeck.scaleLoop(0.5);
 autoDj.loopRollStage = 1;
 updateLoopUI(activeId, activeDeck);
 } else if (buildT >= 0.5 && autoDj.loopRollStage === 1) {
 activeDeck.scaleLoop(0.5);
 autoDj.loopRollStage = 2;
 updateLoopUI(activeId, activeDeck);
 }
 }
 activeDeck.setEchoSend(0.14 + smoothRise * 0.24, beatSec * 0.75, 0.65);
 setCrossfaderProgrammatically(0.0);
 setChannelFaderProgrammatically(activeId, 0.92 - smoothRise * 0.14);
 setChannelFaderProgrammatically(standbyId, 0.86 + smoothRise * 0.06);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, smoothRise * 24);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 6 * (1.0 - smoothRise));
 statusEl.textContent = ` [GUETTA ECHO BUILD] DECK ${activeId} 3/4拍エコー＆LOW完全スワップ${tempoTransitionMsg} (${Math.round(buildT * 100)}%)`;
 return;
 }

 if (effStyle === "tokoto") {
 activeDeck.setEchoSend(0.12 + smoothRise * 0.24, beatSec * 0.5, 0.62);
 setCrossfaderProgrammatically(0.0);
 setChannelFaderProgrammatically(activeId, 0.92 - smoothRise * 0.22);
 setChannelFaderProgrammatically(standbyId, 0.84 + smoothRise * 0.08);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, smoothRise * 24);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 5 * (1.0 - smoothRise));
 statusEl.textContent = ` [MITOMI TOKOTO FILTER+ECHO] スムースフィルター＆LOW完全スワップ${tempoTransitionMsg} (${Math.round(buildT * 100)}%)`;
 return;
 }

 if (autoDj.pad5to8Fx && (effStyle === "nicky" || effStyle === "festival")) {
 if (autoDj.loopRollStage === 0) {
 activeDeck.triggerAutoLoop4Beat();
 activeDeck.scaleLoop(0.5);
 autoDj.loopRollStage = 1;
 updateLoopUI(activeId, activeDeck);
 } else if (buildT >= 0.5 && autoDj.loopRollStage === 1) {
 activeDeck.scaleLoop(0.5);
 autoDj.loopRollStage = 2;
 updateLoopUI(activeId, activeDeck);
 }
 }

 activeDeck.setEchoSend(0.10 + smoothRise * 0.20, beatSec * 0.75, 0.60);
 const curXf = startXf * 0.45 * (1.0 - smoothRise);
 setCrossfaderProgrammatically(curXf);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, smoothRise * 22);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 6 * (1.0 - smoothRise));

 statusEl.textContent = ` [SMOOTH BUILD-UP] DECK ${activeId} LOW完全スワップ移行中${tempoTransitionMsg} (${Math.round(buildT * 100)}%)`;
 return;
 }

 // ==================== STAGE 4: CLEAN HI-FI CLIMAX -> SMOOTH ECHO-FREEZE -> FLAT 0dB DROP! ====================
 if (currentBarIndex >= dropMixStartBar) {
 if (standbyDeck.buffer && !standbyDeck.isPlaying) {
 engine.syncDeckToOther(standbyId);
 syncDeckTempoSliderUI(standbyId);
 document.getElementById(`btnPlay${standbyId}`).click();
 }

 const mixT = stage4MixT;
 const smoothMix = 0.5 - 0.5 * Math.cos(Math.PI * mixT);

 // Apply complete Isolator Low Swap in Stage 4 handover (zero low overlap)
 applyAutoDjIsolatorLowSwap(activeId, standbyId, 0.60 + smoothMix * 0.40);

 if (effStyle === "guetta") {
 if (mixT < 0.60) {
 const preT = mixT / 0.60;
 activeDeck.setEchoSend(0.32, beatSec * 0.75, 0.68);
 setCrossfaderProgrammatically(endXf * preT * 0.5);
 setChannelFaderProgrammatically(activeId, 0.78 * (1.0 - preT * 0.45));
 setChannelFaderProgrammatically(standbyId, 0.94);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, 22 + preT * 8);
 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 0);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 0);
 statusEl.textContent = ` [GUETTA 3/4 ECHO MIX] スムースエコー移行中 (${Math.round(mixT * 100)}%)`;
 } else {
 if (!autoDj.echoFrozen) {
 autoDj.echoFrozen = true;
 activeDeck.freezeEchoTail(0.65);
 if (activeDeck.loopActive) {
 activeDeck.toggleReloopExit();
 updateLoopUI(activeId, activeDeck);
 }
 }
 if ((autoDj.tempoMode === "adaptive" || autoDj.tempoMode === "smart_bpm") && mixT >= 0.85) {
 resetDeckToOriginalBpmUI(standbyId);
 }
 const tailT = (mixT - 0.60) / 0.40;
 setChannelFaderProgrammatically(activeId, 0.42 * (1.0 - tailT));
 setChannelFaderProgrammatically(standbyId, 0.94);
 setCrossfaderProgrammatically(endXf);
 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 0);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 0);
 statusEl.textContent = ` [GUETTA ECHO TRANSITION] 残響エコー浮遊 DECK ${standbyId} (${(standbyDeck.baseBpm || 120).toFixed(1)} BPM) DROP!!`;
 }
 return;
 }

 if (effStyle === "tokoto") {
 if (!autoDj.echoFrozen && mixT >= 0.5) {
 autoDj.echoFrozen = true;
 activeDeck.freezeEchoTail(0.62);
 }
 setCrossfaderProgrammatically(0.0);
 setChannelFaderProgrammatically(activeId, 0.70 * (1.0 - smoothMix));
 const inGain = autoDj.pad5to8Fx && mixT < 0.75 ? (stepInBar16 % 2 === 0 ? 0.94 : 0.45) : 0.94;
 setChannelFaderProgrammatically(standbyId, inGain);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, 22 + smoothMix * 8);
 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 0);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 0);
 if ((autoDj.tempoMode === "adaptive" || autoDj.tempoMode === "smart_bpm") && mixT >= 0.85) {
 resetDeckToOriginalBpmUI(standbyId);
 }
 statusEl.textContent = ` [MITOMI TOKOTO VERTICAL MIX] 縦フェーダースムース切替 DECK ${standbyId} (${(standbyDeck.baseBpm || 120).toFixed(1)} BPM) (${Math.round(mixT * 100)}%)`;
 return;
 }

 const sCurve = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, mixT / 0.90));
 setCrossfaderProgrammatically(endXf * sCurve);
 setChannelFaderProgrammatically(activeId, 0.92 * (1.0 - sCurve * 0.35));
 setChannelFaderProgrammatically(standbyId, 0.94);

 if (isNickySpotlightBeat) {
 if (activeDeck.loopActive) {
 activeDeck.toggleReloopExit();
 updateLoopUI(activeId, activeDeck);
 }
 if (autoDj.tempoMode === "adaptive" || autoDj.tempoMode === "smart_bpm") {
 resetDeckToOriginalBpmUI(standbyId);
 }
 setCrossfaderProgrammatically(endXf);
 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 0);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 0);
 statusEl.textContent = ` [PRE-DROP TRANSITION] 次拍 DECK ${standbyId} 原曲テンポ (${(standbyDeck.baseBpm || 120).toFixed(1)} BPM) 着地!!`;
 return;
 }

 setKnobProgrammatically(`knobMid${standbyId}`, `mid${standbyId}`, 0);
 setKnobProgrammatically(`knobHi${standbyId}`, `hi${standbyId}`, 0);
 setKnobProgrammatically(`knobCfx${activeId}`, `cfx${activeId}`, 20 + sCurve * 8);
 setKnobProgrammatically(`knobCfx${standbyId}`, `cfx${standbyId}`, 0);

 statusEl.textContent = ` [SMOOTH TRANSITION] クライマックス移行 DECK ${standbyId} 原曲テンポ ${(standbyDeck.baseBpm || 120).toFixed(1)} BPM (${Math.round(mixT * 100)}%)`;
 }
 }

 // ==================== TOP HEADER BAR ====================
 function bindTopBar() {
 const btnAudioInit = document.getElementById("btnAudioInit");
 btnAudioInit.addEventListener("click", () => {
 engine.resume();
 engine.unlockIosAudio();
 btnAudioInit.textContent = "Audio Ready";
 });
 window.addEventListener("pointerdown", () => {
 engine.resume();
 engine.unlockIosAudio();
 }, { once: true });

 // Direct File Load Deck 1 & Deck 2
 const directFile1 = document.getElementById("directFileDeck1");
 const directFile2 = document.getElementById("directFileDeck2");

 document.getElementById("btnDirectFile1").addEventListener("click", () => {
 engine.resume();
 engine.unlockIosAudio();
 directFile1.click();
 });
 document.getElementById("btnDirectFile2").addEventListener("click", () => {
 engine.resume();
 engine.unlockIosAudio();
 directFile2.click();
 });

 const btnOpenIphoneMusic = document.getElementById("btnOpenIphoneMusicModal");
 if (btnOpenIphoneMusic) {
 btnOpenIphoneMusic.addEventListener("click", () => openIphoneMusicModal());
 }

 directFile1.addEventListener("change", (e) => {
 if (e.target.files && e.target.files[0]) {
 handleLocalFileForDeck(e.target.files[0], 1);
 e.target.value = "";
 }
 });
 directFile2.addEventListener("change", (e) => {
 if (e.target.files && e.target.files[0]) {
 handleLocalFileForDeck(e.target.files[0], 2);
 e.target.value = "";
 }
 });

 // Record Mix / Screen + Audio Video Recording (Default: 'screen' = 画面＋音声録画)
 const selectRecMode = document.getElementById("selectRecMode");
 const btnRecMix = document.getElementById("btnRecMix");
 const recLabel = document.getElementById("recLabel");
 const recTimer = document.getElementById("recTimer");

 if (selectRecMode) {
 recActiveMode = selectRecMode.value || "screen";
 selectRecMode.addEventListener("change", () => {
 if (!engine.isRecording) {
 recActiveMode = selectRecMode.value || "screen";
 }
 });
 }

 function stopAppRecordingUI() {
 btnRecMix.classList.remove("recording");
 recLabel.textContent = "RECORD";
 recTimer.textContent = "";
 if (selectRecMode) selectRecMode.disabled = false;
 if (recInterval) {
 clearInterval(recInterval);
 recInterval = null;
 }
 if (recCanvasTimer) {
 clearInterval(recCanvasTimer);
 recCanvasTimer = null;
 }
 }

 btnRecMix.addEventListener("click", async () => {
 engine.unlockIosAudio();
 if (engine.isRecording) {
 engine.stopRecordingSession();
 stopAppRecordingUI();
 return;
 }

 let chosenMode = selectRecMode ? selectRecMode.value : "screen";
 let videoStream = null;

 if (chosenMode === "display") {
 if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function") {
 try {
 videoStream = await navigator.mediaDevices.getDisplayMedia({
 video: { frameRate: 30 },
 audio: false,
 preferCurrentTab: true,
 selfBrowserSurface: "include"
 });
 } catch (err) {
 // User cancelled screen picker -> abort cleanly without starting
 return;
 }
 } else {
 // Automatic fallback to built-in HD Controller Screen Canvas capture on iPhone / HTTP LAN
 chosenMode = "screen";
 if (selectRecMode) selectRecMode.value = "screen";
 }
 }

 if (chosenMode === "screen") {
 if (!recScreenCanvas) {
 recScreenCanvas = document.createElement("canvas");
 recScreenCanvas.width = 1280;
 recScreenCanvas.height = 720;
 }
 recStartTime = Date.now();
 drawLiveControllerRecordingFrame();
 if (typeof recScreenCanvas.captureStream === "function") {
 videoStream = recScreenCanvas.captureStream(30);
 }
 }

 recActiveMode = chosenMode;
 recStartTime = Date.now();
 const started = engine.startRecordingSession({
 videoStream,
 stopVideoTracksOnEnd: true,
 onComplete: (res) => {
 stopAppRecordingUI();
 presentRecordingComplete(res);
 },
 onExternalStop: () => {
 stopAppRecordingUI();
 }
 });

 if (started) {
 btnRecMix.classList.add("recording");
 recLabel.textContent = "STOP";
 if (selectRecMode) selectRecMode.disabled = true;
 recInterval = setInterval(() => {
 const sec = Math.floor((Date.now() - recStartTime) / 1000);
 recTimer.textContent = `(${formatShortTime(sec)})`;
 }, 500);
 if (chosenMode === "screen") {
 recCanvasTimer = setInterval(() => {
 if (engine.isRecording && (document.hidden || performance.now() - lastRecFrameMs > 45)) {
 drawLiveControllerRecordingFrame();
 }
 }, 33);
 }
 } else {
 if (videoStream) {
 try {
 videoStream.getTracks().forEach((t) => t.stop());
 } catch (_) {}
 }
 stopAppRecordingUI();
 }
 });

 // Recording Result Preview & Save Modal Bindings
 const recResultModal = document.getElementById("recResultModal");
 const closeRecModal = () => {
 if (!recResultModal) return;
 recResultModal.classList.add("hidden");
 const previewWrap = document.getElementById("recPreviewContainer");
 if (previewWrap) {
 const mediaEl = previewWrap.querySelector("video, audio");
 if (mediaEl && typeof mediaEl.pause === "function") mediaEl.pause();
 }
 };
 document.getElementById("btnCloseRecResultModal")?.addEventListener("click", closeRecModal);
 document.getElementById("btnRecDoneClose")?.addEventListener("click", closeRecModal);
 document.getElementById("btnRecShareSave")?.addEventListener("click", async () => {
 if (!lastRecordedResult || !navigator.share) return;
 try {
 const file = new File([lastRecordedResult.blob], lastRecordedResult.filename, {
 type: lastRecordedResult.mimeType || (lastRecordedResult.isVideo ? "video/mp4" : "audio/mp4")
 });
 await navigator.share({
 title: lastRecordedResult.filename,
 files: [file]
 });
 } catch (_) {}
 });

 // QR Modal
 const qrModal = document.getElementById("qrModal");
 document.getElementById("btnOpenQrModal").addEventListener("click", async () => {
 qrModal.classList.remove("hidden");
 await refreshNetworkQrInfo();
 });
 document.getElementById("btnCloseQrModal").addEventListener("click", () => {
 qrModal.classList.add("hidden");
 });
 document.getElementById("btnStartTunnel").addEventListener("click", async () => {
 const box = document.getElementById("boxTunnelQr");
 box.innerHTML = `<span style="font-size:11px;color:#f97316;">発行中...</span>`;
 try {
 const res = await fetch("/api/tunnel/start", { method: "POST" });
 const data = await res.json();
 if (data.tunnel_url && data.tunnel_qr) {
 box.innerHTML = `<img src="${data.tunnel_qr}" alt="Tunnel QR" />`;
 const link = document.getElementById("linkTunnelUrl");
 link.href = data.tunnel_url;
 link.textContent = data.tunnel_url;
 } else {
 setTimeout(refreshNetworkQrInfo, 2500);
 }
 } catch (_) {}
 });
 }

 async function refreshNetworkQrInfo() {
 try {
 const res = await fetch("/api/network-info");
 const data = await res.json();
 if (data.lan_qr) {
 document.getElementById("imgLanQr").src = data.lan_qr;
 const lanLink = document.getElementById("linkLanUrl");
 lanLink.href = data.lan_url;
 lanLink.textContent = data.lan_url;
 }
 if (data.tunnel_url && data.tunnel_qr) {
 document.getElementById("boxTunnelQr").innerHTML = `<img src="${data.tunnel_qr}" alt="Tunnel QR" />`;
 const tLink = document.getElementById("linkTunnelUrl");
 tLink.href = data.tunnel_url;
 tLink.textContent = data.tunnel_url;
 }
 } catch (_) {}
 }

 // ==================== DECK CONTROLS ====================
 function bindDeckControls(deckId, deck) {
 const deckUnit = document.getElementById(`deckUnit${deckId}`);
 const btnPlay = document.getElementById(`btnPlay${deckId}`);
 const btnCue = document.getElementById(`btnCue${deckId}`);
 const btnSync = document.getElementById(`btnSync${deckId}`);
 const btnKeyLock = document.getElementById(`btnKeyLock${deckId}`);
 const tempoSlider = document.getElementById(`tempoSlider${deckId}`);
 const btnTempoRange = document.getElementById(`btnTempoRange${deckId}`);
 const tempoRangeVal = document.getElementById(`tempoRangeVal${deckId}`);

 deck.tempoRange = 0.08;

 deckUnit.addEventListener("dragover", (e) => e.preventDefault());
 deckUnit.addEventListener("drop", (e) => {
 e.preventDefault();
 if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
 handleLocalFileForDeck(e.dataTransfer.files[0], deckId);
 }
 });

 btnPlay.addEventListener("click", () => {
 if (autoDj.enabled && autoDj.pausedInBackground) {
 autoDj.pausedInBackground = false;
 autoDj.lastFrameAudioTime = engine.ctx.currentTime;
 }
 const playing = deck.togglePlay();
 btnPlay.classList.toggle("playing", playing);
 btnPlay.textContent = playing ? "" : "▶";
 document.getElementById(`lcdState${deckId}`).textContent = playing ? "PLAYING" : "PAUSED";
 syncBackgroundPlaybackAndLockScreen(true);
 });

 btnCue.addEventListener("pointerdown", (e) => {
 e.preventDefault();
 deck.pressCue();
 btnCue.classList.add("active");
 btnPlay.classList.remove("playing");
 btnPlay.textContent = "▶";
 document.getElementById(`lcdState${deckId}`).textContent = "CUE";
 syncBackgroundPlaybackAndLockScreen(false);
 });
 const endCue = () => {
 deck.releaseCue();
 btnCue.classList.remove("active");
 };
 btnCue.addEventListener("pointerup", endCue);
 btnCue.addEventListener("pointercancel", endCue);
 btnCue.addEventListener("pointerleave", endCue);

 btnSync.addEventListener("click", () => {
 engine.syncDeckToOther(deckId);
 tempoSlider.value = deck.tempoSliderPos;
 const activeClass = deckId === 1 ? "active-d1" : "active-d2";
 btnSync.classList.add(activeClass);
 setTimeout(() => btnSync.classList.remove(activeClass), 500);
 });

 btnKeyLock.addEventListener("click", () => {
 deck.keyLock = !deck.keyLock;
 const activeClass = deckId === 1 ? "active-d1" : "active-d2";
 btnKeyLock.classList.toggle(activeClass, deck.keyLock);
 });

 const ranges = [0.08, 0.16, 0.50];
 let rangeIdx = 0;
 btnTempoRange.addEventListener("click", () => {
 rangeIdx = (rangeIdx + 1) % ranges.length;
 deck.tempoRange = ranges[rangeIdx];
 tempoRangeVal.textContent = Math.round(deck.tempoRange * 100);
 });

 tempoSlider.addEventListener("input", () => {
 deck.tempoSliderPos = parseFloat(tempoSlider.value);
 });
 tempoSlider.addEventListener("dblclick", () => {
 deck.tempoSliderPos = 0;
 tempoSlider.value = 0;
 });

 document.getElementById(`btnLoopIn${deckId}`).addEventListener("click", () => {
 deck.setLoopIn();
 updateLoopUI(deckId, deck);
 });
 document.getElementById(`btnLoopOut${deckId}`).addEventListener("click", () => {
 deck.setLoopOut();
 updateLoopUI(deckId, deck);
 });
 document.getElementById(`btnLoop4Beat${deckId}`).addEventListener("click", () => {
 deck.triggerAutoLoop4Beat();
 updateLoopUI(deckId, deck);
 });
 document.getElementById(`btnLoopExit${deckId}`).addEventListener("click", () => {
 deck.toggleReloopExit();
 updateLoopUI(deckId, deck);
 });

 bindJogWheel(deckId, deck);
 bindPerformancePads(deckId, deck);
 }

 function updateLoopUI(deckId, deck) {
 document.getElementById(`btnLoop4Beat${deckId}`).classList.toggle("active", deck.loopActive);
 document.getElementById(`btnLoopExit${deckId}`).classList.toggle("active", deck.loopActive);
 }

 function bindJogWheel(deckId, deck) {
 const jogEl = document.getElementById(`jogWheel${deckId}`);
 let activePointerId = null;
 let prevAngle = 0;
 let lastMoveTime = 0;

 function getAngle(clientX, clientY) {
 const rect = jogEl.getBoundingClientRect();
 const cx = rect.left + rect.width / 2;
 const cy = rect.top + rect.height / 2;
 return Math.atan2(clientY - cy, clientX - cx) * (180 / Math.PI);
 }

 jogEl.addEventListener("pointerdown", (e) => {
 e.preventDefault();
 engine.resume();
 activePointerId = e.pointerId;
 jogEl.setPointerCapture(e.pointerId);
 prevAngle = getAngle(e.clientX, e.clientY);
 lastMoveTime = performance.now();
 deck.isScratching = true;
 deck.scratchVelocity = 0;
 document.getElementById(`lcdBpm${deckId}`).textContent = "SCRATCH";
 });

 jogEl.addEventListener("pointermove", (e) => {
 if (e.pointerId !== activePointerId) return;
 const now = performance.now();
 const dt = Math.max(4, now - lastMoveTime) / 1000;
 const curAngle = getAngle(e.clientX, e.clientY);

 let deltaDeg = curAngle - prevAngle;
 if (deltaDeg > 180) deltaDeg -= 360;
 if (deltaDeg < -180) deltaDeg += 360;

 prevAngle = curAngle;
 lastMoveTime = now;

 const degPerSec = deltaDeg / dt;
 deck.scratchVelocity = Math.max(-4.0, Math.min(4.0, degPerSec / 180));
 deck.platterAngle = (deck.platterAngle + deltaDeg) % 360;
 });

 const stopJog = (e) => {
 if (e.pointerId !== activePointerId) return;
 activePointerId = null;
 deck.isScratching = false;
 deck.scratchVelocity = 0;
 document.getElementById(`lcdBpm${deckId}`).textContent = deck.isPlaying ? "PLAY" : "READY";
 };

 jogEl.addEventListener("pointerup", stopJog);
 jogEl.addEventListener("pointercancel", stopJog);

 const centerCap = document.getElementById(`jogCenterCap${deckId}`);
 if (centerCap) {
 centerCap.addEventListener("pointerdown", (e) => {
 e.stopPropagation();
 });
 centerCap.addEventListener("click", (e) => {
 e.stopPropagation();
 deck.cycleJogLcdMode();
 updateDeckTelemetry(deckId, deck);
 });
 }
 }

 // ==================== PERFORMANCE PADS ====================
 function bindPerformancePads(deckId, deck) {
 const activeTabClass = deckId === 1 ? "active-d1" : "active-d2";
 const modeBtns = document.querySelectorAll(`.pad-modes-bar[data-deck="${deckId}"] .pad-mode-tab`);
 modeBtns.forEach((btn) => {
 btn.addEventListener("click", () => {
 modeBtns.forEach((b) => b.classList.remove("active-d1", "active-d2"));
 btn.classList.add(activeTabClass);
 deck.padMode = btn.dataset.mode;
 updateDeckPadLabels(deckId);
 });
 });

 const pads = document.querySelectorAll(`#padsGrid${deckId} .hw-pad`);
 pads.forEach((padBtn, padIdx) => {
 padBtn.addEventListener("pointerdown", (e) => {
 e.preventDefault();
 engine.resume();
 padBtn.classList.add("pad-active");

 if (deck.padMode === "hotcue") {
 if (e.shiftKey || e.button === 2) {
 deck.hotCues[padIdx] = null;
 } else if (deck.hotCues[padIdx] === null) {
 deck.hotCues[padIdx] = deck.playheadSec;
 } else {
 deck.seekTo(deck.hotCues[padIdx]);
 }
 updateDeckPadLabels(deckId);
 } else if (deck.padMode === "padfx") {
 deck.startPadFx(padIdx);
 } else if (deck.padMode === "beatjump") {
 const beats = BEAT_JUMP_BEATS[padIdx];
 const beatSec = 60.0 / deck.getCurrentBpm();
 deck.seekTo(deck.playheadSec + beats * beatSec);
 } else if (deck.padMode === "sampler") {
 engine.triggerSamplerPad(padIdx);
 }
 });

 const releasePad = () => {
 padBtn.classList.remove("pad-active");
 if (deck.padMode === "padfx") deck.stopPadFx();
 };

 padBtn.addEventListener("pointerup", releasePad);
 padBtn.addEventListener("pointerleave", releasePad);
 padBtn.addEventListener("pointercancel", releasePad);
 padBtn.addEventListener("contextmenu", (e) => {
 e.preventDefault();
 if (deck.padMode === "hotcue") {
 deck.hotCues[padIdx] = null;
 updateDeckPadLabels(deckId);
 }
 });
 });

 updateDeckPadLabels(deckId);
 }

 function updateDeckPadLabels(deckId) {
 const deck = deckId === 1 ? engine.deck1 : engine.deck2;
 const pads = document.querySelectorAll(`#padsGrid${deckId} .hw-pad`);

 pads.forEach((padBtn, idx) => {
 const titleSpan = padBtn.querySelector(".pad-title");
 const subSpan = padBtn.querySelector(".pad-sub");
 padBtn.classList.remove("pad-filled");

 if (deck.padMode === "hotcue") {
 titleSpan.textContent = String(idx + 1);
 const cueSec = deck.hotCues[idx];
 if (cueSec !== null) {
 subSpan.textContent = "";
 padBtn.classList.add("pad-filled");
 } else {
 subSpan.textContent = "";
 }
 } else if (deck.padMode === "padfx") {
 titleSpan.textContent = PAD_FX_LABELS[idx][0];
 subSpan.textContent = "";
 } else if (deck.padMode === "beatjump") {
 titleSpan.textContent = BEAT_JUMP_LABELS[idx];
 subSpan.textContent = "";
 } else if (deck.padMode === "sampler") {
 titleSpan.textContent = engine.samplerNames[idx].split(" ")[0];
 subSpan.textContent = "";
 }
 });
 }

 // ==================== CENTER MIXER ====================
 function bindMixerControls() {
 const chFader1 = document.getElementById("chFader1");
 const chFader2 = document.getElementById("chFader2");
 chFader1.addEventListener("input", () => {
 engine.deck1.chFaderGain.gain.setTargetAtTime(parseFloat(chFader1.value), engine.ctx.currentTime, 0.015);
 });
 chFader2.addEventListener("input", () => {
 engine.deck2.chFaderGain.gain.setTargetAtTime(parseFloat(chFader2.value), engine.ctx.currentTime, 0.015);
 });

 const btnSmartCfx = document.getElementById("btnSmartCfx");
 btnSmartCfx.addEventListener("click", () => {
 engine.smartCfxEnabled = !engine.smartCfxEnabled;
 btnSmartCfx.classList.toggle("active", engine.smartCfxEnabled);
 const val1 = parseFloat(document.getElementById("knobCfx1").dataset.val || "0");
 const val2 = parseFloat(document.getElementById("knobCfx2").dataset.val || "0");
 engine.deck1.setCfxValue(val1, engine.smartCfxEnabled, engine.smartCfxPreset);
 engine.deck2.setCfxValue(val2, engine.smartCfxEnabled, engine.smartCfxPreset);
 });

 const btnSmartFader = document.getElementById("btnSmartFader");
 const crossfader = document.getElementById("crossfader");
 btnSmartFader.addEventListener("click", () => {
 engine.smartFaderEnabled = !engine.smartFaderEnabled;
 btnSmartFader.classList.toggle("active", engine.smartFaderEnabled);
 engine.setCrossfader(parseFloat(crossfader.value));
 });

 crossfader.addEventListener("input", () => {
 engine.setCrossfader(parseFloat(crossfader.value));
 });
 crossfader.addEventListener("dblclick", () => {
 crossfader.value = 0;
 engine.setCrossfader(0);
 });
 }

 function bindRotaryKnobs() {
 const knobs = document.querySelectorAll(".rotary-knob");
 knobs.forEach((knob) => {
 updateKnobVisual(knob);
 let activePtr = null;
 let startY = 0;
 let startVal = 0;

 knob.addEventListener("pointerdown", (e) => {
 e.preventDefault();
 engine.resume();
 activePtr = e.pointerId;
 knob.setPointerCapture(e.pointerId);
 startY = e.clientY;
 startVal = parseFloat(knob.dataset.val);
 });

 knob.addEventListener("pointermove", (e) => {
 if (e.pointerId !== activePtr) return;
 const min = parseFloat(knob.dataset.min);
 const max = parseFloat(knob.dataset.max);
 const dy = startY - e.clientY;
 let nextVal = startVal + (dy / 100) * (max - min);
 nextVal = Math.max(min, Math.min(max, nextVal));
 knob.dataset.val = nextVal;
 updateKnobVisual(knob);
 applyKnobParam(knob.dataset.param, nextVal);
 });

 const endKnob = (e) => {
 if (e.pointerId === activePtr) activePtr = null;
 };
 knob.addEventListener("pointerup", endKnob);
 knob.addEventListener("pointercancel", endKnob);

 knob.addEventListener("dblclick", () => {
 const def = parseFloat(knob.dataset.default);
 knob.dataset.val = def;
 updateKnobVisual(knob);
 applyKnobParam(knob.dataset.param, def);
 });
 });
 }

 function updateKnobVisual(knob) {
 const min = parseFloat(knob.dataset.min);
 const max = parseFloat(knob.dataset.max);
 const val = parseFloat(knob.dataset.val);
 const norm = (val - min) / (max - min);
 const deg = -135 + norm * 270;
 knob.style.setProperty("--knob-deg", `${deg.toFixed(1)}deg`);
 }

 function applyKnobParam(param, val) {
 switch (param) {
 case "trim1": engine.deck1.setTrimDb(val); break;
 case "trim2": engine.deck2.setTrimDb(val); break;
 case "hi1": engine.deck1.setEqDb("hi", val); break;
 case "mid1": engine.deck1.setEqDb("mid", val); break;
 case "low1": engine.deck1.setEqDb("low", val); break;
 case "hi2": engine.deck2.setEqDb("hi", val); break;
 case "mid2": engine.deck2.setEqDb("mid", val); break;
 case "low2": engine.deck2.setEqDb("low", val); break;
 case "cfx1": engine.deck1.setCfxValue(val, engine.smartCfxEnabled, engine.smartCfxPreset); break;
 case "cfx2": engine.deck2.setCfxValue(val, engine.smartCfxEnabled, engine.smartCfxPreset); break;
 case "master": engine.masterOutputGain.gain.setTargetAtTime(val, engine.ctx.currentTime, 0.015); break;
 case "sampler": engine.samplerGain.gain.setTargetAtTime(val, engine.ctx.currentTime, 0.015); break;
 }
 }

 // ==================== WAVEFORMS ====================
 function bindWaveformCanvases() {
 [1, 2].forEach((deckId) => {
 const deck = deckId === 1 ? engine.deck1 : engine.deck2;
 const ovCanvas = document.getElementById(`overviewWave${deckId}`);
 const zmCanvas = document.getElementById(`zoomWave${deckId}`);

 const seekFromOverview = (e) => {
 if (!deck.duration) return;
 const rect = ovCanvas.getBoundingClientRect();
 const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
 deck.seekTo(ratio * deck.duration);
 };
 let ovDragging = false;
 ovCanvas.addEventListener("pointerdown", (e) => {
 ovDragging = true;
 ovCanvas.setPointerCapture(e.pointerId);
 seekFromOverview(e);
 });
 ovCanvas.addEventListener("pointermove", (e) => {
 if (ovDragging) seekFromOverview(e);
 });
 ovCanvas.addEventListener("pointerup", () => { ovDragging = false; });

 let zmDragging = false;
 let zmLastX = 0;
 zmCanvas.addEventListener("pointerdown", (e) => {
 zmDragging = true;
 zmLastX = e.clientX;
 zmCanvas.setPointerCapture(e.pointerId);
 });
 zmCanvas.addEventListener("pointermove", (e) => {
 if (!zmDragging || !deck.duration) return;
 const dx = e.clientX - zmLastX;
 zmLastX = e.clientX;
 const secPerPx = waveZoomFactor / zmCanvas.clientWidth;
 deck.seekTo(deck.playheadSec - dx * secPerPx);
 });
 zmCanvas.addEventListener("pointerup", () => { zmDragging = false; });
 });
 }

 // ==================== YOUTUBE & LIBRARY MODAL ====================
 function bindYoutubeAndLibraryModal() {
 const ytModal = document.getElementById("youtubeModal");
 document.getElementById("btnOpenYoutubeModal").addEventListener("click", () => {
 ytModal.classList.remove("hidden");
 renderLibraryTable();
 setTimeout(() => document.getElementById("inputYoutubeQuery").focus(), 50);
 });
 document.getElementById("btnCloseYoutubeModal").addEventListener("click", () => {
 ytModal.classList.add("hidden");
 });
 ytModal.addEventListener("click", (e) => {
 if (e.target === ytModal) ytModal.classList.add("hidden");
 });
 const qrModalEl = document.getElementById("qrModal");
 if (qrModalEl) {
 qrModalEl.addEventListener("click", (e) => {
 if (e.target === qrModalEl) qrModalEl.classList.add("hidden");
 });
 }

 const inputYtQuery = document.getElementById("inputYoutubeQuery");
 const ytResultsGrid = document.getElementById("ytResultsGrid");

 document.getElementById("btnYoutubeSearch").addEventListener("click", doYoutubeSearch);
 inputYtQuery.addEventListener("keydown", (e) => {
 if (e.key === "Enter") doYoutubeSearch();
 });

 const btnYtDirectQueue = document.getElementById("btnYtDirectQueue");
 if (btnYtDirectQueue) {
 btnYtDirectQueue.addEventListener("click", () => {
 const q = inputYtQuery.value.trim();
 if (q) startYoutubeExtraction(q, "queue");
 });
 }

 document.getElementById("btnYtDirectD1").addEventListener("click", () => {
 const q = inputYtQuery.value.trim();
 if (q) startYoutubeExtraction(q, 1);
 });
 document.getElementById("btnYtDirectD2").addEventListener("click", () => {
 const q = inputYtQuery.value.trim();
 if (q) startYoutubeExtraction(q, 2);
 });

 const btnClearLibModal = document.getElementById("btnClearLibModal");
 if (btnClearLibModal) {
 btnClearLibModal.addEventListener("click", () => {
 clearAllSavedLibrary();
 });
 }

 async function doYoutubeSearch() {
 const q = inputYtQuery.value.trim();
 if (!q) return;
 ytResultsGrid.innerHTML = `<div style="font-size:11px;color:#f97316;">検索中: 「${escapeHtml(q)}」...</div>`;

 let ytResults = [];

 // 1. Try YouTube backend server if online (Local PC / Tunnel / Cloud)
 try {
 const yUrl = apiUrl(`/api/youtube/search?q=${encodeURIComponent(q)}`);
 if (yUrl && (yUrl.startsWith("http://") || yUrl.startsWith("https://") || !window.location.hostname.includes("github.io"))) {
 const res = await fetch(yUrl, { signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined });
 if (res.ok) {
 const data = await res.json();
 if (data && data.ok && Array.isArray(data.results) && data.results.length > 0) {
 ytResults = data.results;
 }
 }
 }
 } catch (_) {}

 if (ytResults.length > 0) {
 ytResultsGrid.innerHTML = "";
 ytResults.forEach((item) => {
 const card = document.createElement("div");
 card.className = "yt-card";
 card.innerHTML = `
 <img class="yt-thumb" src="${escapeHtml(item.thumbnail)}" alt="thumb" loading="lazy" />
 <div class="yt-info">
 <div class="yt-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
 <div class="yt-meta">${escapeHtml(item.artist)} • ${formatShortTime(item.duration || 0)}</div>
 <div style="display:flex;gap:4px;flex-wrap:wrap;">
 <button class="hdr-btn btn-autodj-pro" style="padding:2px 6px;font-size:9px;" data-act="queue">Auto DJへ追加</button>
 <button class="hdr-btn btn-load-d1" style="padding:2px 6px;font-size:9px;" data-act="d1">Deck 1</button>
 <button class="hdr-btn btn-load-d2" style="padding:2px 6px;font-size:9px;" data-act="d2">Deck 2</button>
 </div>
 </div>
 `;
 card.querySelector('[data-act="queue"]').addEventListener("click", () => startYoutubeExtraction(item.url || item.id, "queue"));
 card.querySelector('[data-act="d1"]').addEventListener("click", () => startYoutubeExtraction(item.url || item.id, 1));
 card.querySelector('[data-act="d2"]').addEventListener("click", () => startYoutubeExtraction(item.url || item.id, 2));
 ytResultsGrid.appendChild(card);
 });
 return;
 }

 // 2. Direct high-speed Apple / iTunes search via JSONP (100% works on iPhone Safari & GitHub Pages without PC!)
 try {
 const appleUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&country=jp&media=music&entity=song&limit=30`;
 const aData = await jsonpFetch(appleUrl, 7000);
 if (aData && Array.isArray(aData.results) && aData.results.length > 0) {
 ytResultsGrid.innerHTML = `
 <div style="font-size:11px;color:#38bdf8;padding:8px;background:rgba(56,189,248,0.1);border-radius:6px;margin-bottom:8px;line-height:1.5;">
 公式高音質音源から「${escapeHtml(q)}」を取得しました。ワンタップでデッキに読み込みDJプレイが可能です。
 </div>`;
 aData.results.filter((r) => r.previewUrl).forEach((r) => {
 const item = {
 id: "apple_" + r.trackId,
 apple_id: String(r.trackId),
 title: r.trackName,
 artist: r.artistName || "",
 album: r.collectionName || "",
 thumbnail: (r.artworkUrl100 || "").replace("100x100bb", "300x300bb"),
 preview_url: r.previewUrl,
 url: r.previewUrl,
 duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 30,
 bpm: 120,
 source: "apple_music",
 };
 const inQueue = autoDjQueue.some((x) => x.id === item.id);
 const card = document.createElement("div");
 card.className = "yt-card";
 card.innerHTML = `
 <img class="yt-thumb" src="${escapeHtml(item.thumbnail)}" alt="thumb" loading="lazy" />
 <div class="yt-info">
 <div class="yt-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
 <div class="yt-meta">${escapeHtml(item.artist)} • ${formatShortTime(item.duration || 0)}</div>
 <div style="display:flex;gap:4px;flex-wrap:wrap;">
 <button class="hdr-btn ${inQueue ? "btn-demo-gradient" : "btn-autodj-pro"}" style="padding:2px 6px;font-size:9px;" data-act="queue">
 ${inQueue ? "セット済" : "Auto DJへ追加"}
 </button>
 <button class="hdr-btn btn-load-d1" style="padding:2px 6px;font-size:9px;" data-act="d1">Deck 1</button>
 <button class="hdr-btn btn-load-d2" style="padding:2px 6px;font-size:9px;" data-act="d2">Deck 2</button>
 </div>
 </div>
 `;
 card.querySelector('[data-act="queue"]').addEventListener("click", async (ev) => {
 const btn = ev.currentTarget;
 btn.textContent = "追加中...";
 await importAppleMusicTrackItem(item, "queue");
 btn.textContent = "セット済";
 });
 card.querySelector('[data-act="d1"]').addEventListener("click", async () => {
 await importAppleMusicTrackItem(item, 1);
 document.getElementById("youtubeModal").classList.add("hidden");
 });
 card.querySelector('[data-act="d2"]').addEventListener("click", async () => {
 await importAppleMusicTrackItem(item, 2);
 document.getElementById("youtubeModal").classList.add("hidden");
 });
 ytResultsGrid.appendChild(card);
 });
 return;
 }
 } catch (_) {}

 ytResultsGrid.innerHTML = `
 <div style="font-size:11px;color:#ef4444;line-height:1.6;padding:8px;background:rgba(239,68,68,0.1);border-radius:6px;">
 検索結果が見つかりませんでした。<br>
 ※ キーワード（曲名やアーティスト名）を変えて再検索するか、「Load Deck 1/2」から端末内の音源（.mp3 / .m4a）を選択してください。
 </div>`;
 }

 async function startYoutubeExtraction(urlOrId, target) {
 const ytJobBox = document.getElementById("ytJobBox");
 const ytJobText = document.getElementById("ytJobText");
 const ytJobPct = document.getElementById("ytJobPct");
 const ytJobBar = document.getElementById("ytJobBar");
 const startTimeStr = document.getElementById("inputYtStart").value.trim();
 const endTimeStr = document.getElementById("inputYtEnd").value.trim();

 ytJobBox.classList.remove("hidden");
 ytJobText.textContent = "YouTube / YouTube Music 音源を抽出・変換中...";
 ytJobPct.textContent = "5%";
 ytJobBar.style.width = "5%";

 try {
 const res = await fetch(apiUrl("/api/youtube/extract"), {
 method: "POST",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify({
 url: urlOrId,
 start_time: startTimeStr || null,
 end_time: endTimeStr || null,
 }),
 });
 const data = await res.json();
 if (!data.ok || !data.job_id) {
 ytJobText.textContent = `エラー: ${data.error || "失敗"}`;
 return;
 }
 const jobId = data.job_id;
 const pollTimer = setInterval(async () => {
 try {
 const stRes = await fetch(apiUrl(`/api/youtube/jobs/${jobId}`));
 const job = await stRes.json();
 ytJobText.textContent = job.message || "処理中...";
 ytJobPct.textContent = `${job.progress || 0}%`;
 ytJobBar.style.width = `${job.progress || 0}%`;

 if (job.status === "completed" && job.track) {
 clearInterval(pollTimer);
 job.track.bpm = engine.deck1._clampNaturalBpm(job.track.bpm);
 savedLibrary = [job.track, ...savedLibrary.filter((x) => x.id !== job.track.id)];
 addTrackToAutoDjQueue(job.track);

 if (target === 1 || target === 2) {
 await loadTrackIntoDeck(target, job.track);
 ytJobBox.classList.add("hidden");
 ytModal.classList.add("hidden");
 } else {
 // Added directly to Auto DJ queue! Safely preload Deck 1 / Deck 2 if empty
 preloadInitialAutoDjDecks();
 ytJobText.textContent = ` Auto DJセットリストに追加完了: ${job.track.title}（続けて追加できます）`;
 ytJobPct.textContent = "100%";
 ytJobBar.style.width = "100%";
 }
 } else if (job.status === "error") {
 clearInterval(pollTimer);
 }
 } catch (_) {
 clearInterval(pollTimer);
 }
 }, 700);
 } catch (err) {
 ytJobText.textContent = `通信エラー: ${err.message}`;
 }
 }
 }

 // ==================== iPhone MUSIC APP / iTUNES / APPLE MUSIC MODAL ====================
 let musicModalInitialized = false;
 let musicSearchDebounceTimer = null;

 async function openIphoneMusicModal(initialTab = null) {
 const modal = document.getElementById("iphoneMusicModal");
 if (!modal) return;
 modal.classList.remove("hidden");

 if (!initialTab) {
 const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || "");
 initialTab = isMobile ? "apple" : "local";
 }
 switchIphoneMusicTab(initialTab);

 if (!musicModalInitialized) {
 musicModalInitialized = true;
 await fetchLocalMusicLibrary(false);
 await updateShortcutBridgeUrlDisplay();
 } else {
 // Re-render badges so "セット済" stays up-to-date
 renderLocalMusicTable();
 }
 }

 function switchIphoneMusicTab(tabName) {
 document.querySelectorAll(".music-tab-btn").forEach((btn) => {
 btn.classList.toggle("active", btn.dataset.mtab === tabName);
 });
 ["local", "apple", "shortcut"].forEach((paneId) => {
 const pane = document.getElementById(`musicPane_${paneId}`);
 if (pane) pane.classList.toggle("hidden", paneId !== tabName);
 });
 }

 async function updateShortcutBridgeUrlDisplay() {
 const codeEl = document.getElementById("shortcutBridgeUrlDisplay");
 if (!codeEl) return;
 let baseOrigin = window.location.origin;
 try {
 const res = await fetch("/api/network-info");
 const info = await res.json();
 if (info.tunnel_url) {
 baseOrigin = info.tunnel_url.replace(/\/$/, "");
 } else if (info.lan_url && (baseOrigin.includes("127.0.0.1") || baseOrigin.includes("localhost"))) {
 baseOrigin = info.lan_url.replace(/\/$/, "");
 }
 } catch (_) {}
 codeEl.textContent = `${baseOrigin}/?iphone_music=`;
 }

 async function fetchLocalMusicLibrary(forceRefresh = false) {
 const qInput = document.getElementById("inputMusicLocalSearch");
 const artistSelect = document.getElementById("selectMusicLocalArtist");
 const badgeEl = document.getElementById("musicLocalTotalBadge");
 const summaryEl = document.getElementById("musicLocalSummary");

 const q = (qInput ? qInput.value : "").trim();
 const artist = artistSelect ? artistSelect.value : "";

 try {
 if (summaryEl) summaryEl.textContent = "Musicライブラリを読み込み中...";
 const params = new URLSearchParams({
 q,
 artist,
 limit: "100",
 });
 if (forceRefresh) params.set("refresh", "1");

 const res = await fetch(apiUrl(`/api/music-app/local?${params.toString()}`));
 const data = await res.json();
 if (!data.ok) throw new Error(data.error || "読み込みエラー");

 if (badgeEl) {
 badgeEl.textContent = `${Number(data.total_library_count || 0).toLocaleString()}曲`;
 }

 if (artistSelect && artistSelect.options.length <= 1 && Array.isArray(data.artists)) {
 const prevVal = artistSelect.value;
 artistSelect.innerHTML = `<option value="">すべてのアーティスト (${Number(data.total_library_count || 0).toLocaleString()}曲)</option>`;
 data.artists.forEach((a) => {
 const opt = document.createElement("option");
 opt.value = a.name;
 opt.textContent = `${a.name} (${a.count}曲)`;
 artistSelect.appendChild(opt);
 });
 artistSelect.value = prevVal;
 }

 localMusicShownTracks = data.tracks || [];
 if (summaryEl) {
 if (data.total_library_count === 0) {
 summaryEl.textContent =
 "PC内の Music / iTunes フォルダに曲が見つかりませんでした。「Apple Music検索」タブまたは端末ファイル選択をご利用ください。";
 } else {
 summaryEl.textContent = `同期済み Music / iTunes ライブラリ 全 ${Number(data.total_library_count).toLocaleString()}曲中 ${Number(
 data.matched_count
 ).toLocaleString()}曲が一致（先頭 ${localMusicShownTracks.length}曲を表示中・原曲スピード再生対応）`;
 }
 }
 renderLocalMusicTable();
 } catch (err) {
 if (badgeEl) badgeEl.textContent = "PC接続時";
 if (summaryEl) {
 summaryEl.innerHTML = `
 <div style="padding:10px;background:rgba(239,68,68,0.08);border-radius:6px;line-height:1.6;color:#fda4af;font-size:11px;">
 PCのiTunes/Musicフォルダとの直接同期は、PCで ddj_flx4_app.py 実行時に利用可能です。<br>
 iPhone単体（PCオフライン）でご利用の場合は、隣の<strong>「Apple Music検索」</strong>タブから曲名や歌手名で検索してワンタップでデッキに読み込み可能です。
 </div>`;
 }
 }
 }

 function renderLocalMusicTable() {
 const tbody = document.getElementById("musicLocalTableBody");
 if (!tbody) return;
 tbody.innerHTML = "";

 if (!localMusicShownTracks || localMusicShownTracks.length === 0) {
 const tr = document.createElement("tr");
 tr.innerHTML = `<td colspan="4" style="text-align:center;color:#9ca3af;padding:18px;">該当する曲がありません。検索ワードを変えるか「Apple Music検索」タブをお試しください。</td>`;
 tbody.appendChild(tr);
 return;
 }

 localMusicShownTracks.forEach((track) => {
 const inQueue = autoDjQueue.some((q) => q.id === track.id);
 const tr = document.createElement("tr");
 tr.innerHTML = `
 <td style="white-space:nowrap;">
 <button class="hdr-btn ${inQueue ? "btn-demo-gradient" : "btn-autodj-pro"}" style="padding:3px 8px;font-size:10px;" data-act="queue">
 ${inQueue ? " セット済" : " Auto DJ"}
 </button>
 <button class="hdr-btn btn-load-d1" style="padding:3px 7px;font-size:10px;" data-act="d1">Deck 1</button>
 <button class="hdr-btn btn-load-d2" style="padding:3px 7px;font-size:10px;" data-act="d2">Deck 2</button>
 </td>
 <td style="font-weight:700;color:#f3f4f6;">${escapeHtml(track.title)}</td>
 <td style="color:#fda4af;font-size:11px;">${escapeHtml(track.artist || "")}</td>
 <td style="color:#9ca3af;font-size:11px;">${escapeHtml(track.album || "")}</td>
 `;

 tr.querySelector('[data-act="queue"]').addEventListener("click", () => {
 addTrackToAutoDjQueue(track);
 renderLocalMusicTable();
 preloadInitialAutoDjDecks();
 });

 tr.querySelector('[data-act="d1"]').addEventListener("click", async () => {
 addTrackToAutoDjQueue(track);
 await loadTrackIntoDeck(1, track);
 document.getElementById("iphoneMusicModal").classList.add("hidden");
 });

 tr.querySelector('[data-act="d2"]').addEventListener("click", async () => {
 addTrackToAutoDjQueue(track);
 await loadTrackIntoDeck(2, track);
 document.getElementById("iphoneMusicModal").classList.add("hidden");
 });

 tbody.appendChild(tr);
 });
 }

 function stopPreviewAudio() {
 if (previewAudioEl) {
 previewAudioEl.pause();
 previewAudioEl.src = "";
 previewAudioEl = null;
 }
 }

 async function importAppleMusicTrackItem(item, target = "queue") {
 const statusBox = document.getElementById("appleMusicStatusBox");
 const statusText = document.getElementById("appleMusicStatusText");
 if (statusBox) statusBox.classList.remove("hidden");

 // 1. Matched directly in local synced Music / iTunes library
 if (item.local_track) {
 const localTrack = item.local_track;
 addTrackToAutoDjQueue(localTrack);
 if (target === 1 || target === 2) {
 await loadTrackIntoDeck(target, localTrack);
 document.getElementById("iphoneMusicModal").classList.add("hidden");
 } else {
 preloadInitialAutoDjDecks();
 }
 if (statusText) {
 statusText.textContent = `Musicライブラリから追加完了: ${localTrack.title} - ${localTrack.artist}`;
 }
 return localTrack;
 }

 // 2. Direct high-quality Apple official audio stream loading (100% works on iPhone without PC/backend!)
 if (item.preview_url || item.url) {
 const trackObj = {
 id: item.id || ("apple_" + (item.apple_id || Date.now())),
 apple_id: item.apple_id,
 title: item.title,
 artist: item.artist || "",
 album: item.album || "",
 thumbnail: item.thumbnail || "",
 url: item.preview_url || item.url,
 duration: item.duration || 30,
 bpm: 120, // will be auto-calculated upon audio decode
 source: "apple_music"
 };

 addTrackToAutoDjQueue(trackObj);
 if (target === 1 || target === 2) {
 if (statusText) statusText.textContent = `Deck ${target}へ読み込み中: ${trackObj.title}...`;
 await loadTrackIntoDeck(target, trackObj);
 document.getElementById("iphoneMusicModal").classList.add("hidden");
 } else {
 preloadInitialAutoDjDecks();
 }
 if (statusText) {
 statusText.textContent = `Apple Musicからセットリストへ追加完了: ${trackObj.title} - ${trackObj.artist}`;
 }
 return trackObj;
 }

 // 3. Fallback: if backend extraction is requested and backend is online
 const searchQuery = `${item.artist || ""} ${item.title || ""} official audio`.trim();
 if (statusText) {
 statusText.textContent = `Apple Music曲をフル音源取得中: ${item.title} - ${item.artist || ""}...`;
 }

 try {
 const res = await fetch(apiUrl("/api/youtube/extract"), {
 method: "POST",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify({
 search_query: searchQuery,
 title: item.title,
 artist: item.artist,
 thumbnail: item.thumbnail,
 source: "apple_music",
 }),
 });
 const data = await res.json();
 if (!data.ok) {
 if (statusText) statusText.textContent = `エラー: ${data.error || "音源取得失敗"}`;
 return null;
 }

 const jobId = data.job_id;
 return await new Promise((resolve) => {
 const poll = setInterval(async () => {
 try {
 const stRes = await fetch(apiUrl(`/api/youtube/jobs/${jobId}`));
 const job = await stRes.json();
 if (statusText) {
 statusText.textContent = `${item.title}: ${job.message || "処理中..."} (${job.progress || 0}%)`;
 }
 if (job.status === "completed" && job.track) {
 clearInterval(poll);
 job.track.bpm = engine.deck1._clampNaturalBpm(job.track.bpm);
 savedLibrary = [job.track, ...savedLibrary.filter((x) => x.id !== job.track.id)];
 addTrackToAutoDjQueue(job.track);

 if (target === 1 || target === 2) {
 await loadTrackIntoDeck(target, job.track);
 document.getElementById("iphoneMusicModal").classList.add("hidden");
 } else {
 preloadInitialAutoDjDecks();
 }
 if (statusText) {
 statusText.textContent = `Auto DJセットリストへ追加完了: ${job.track.title} (${Number(job.track.bpm || 120).toFixed(1)} BPM)`;
 }
 resolve(job.track);
 } else if (job.status === "error") {
 clearInterval(poll);
 if (statusText) statusText.textContent = `取得エラー: ${job.message || "失敗"}`;
 resolve(null);
 }
 } catch (_) {
 clearInterval(poll);
 resolve(null);
 }
 }, 700);
 });
 } catch (err) {
 if (statusText) statusText.textContent = `通信エラー: ${err.message}`;
 return null;
 }
 }

 async function resolveAndImportAppleMusicInput(rawText) {
 const clean = (rawText || "").trim();
 if (!clean) return;
 const statusBox = document.getElementById("appleMusicStatusBox");
 const statusText = document.getElementById("appleMusicStatusText");
 if (statusBox) statusBox.classList.remove("hidden");
 if (statusText) statusText.textContent = "iPhone「ミュージック」の共有リンク / 曲を解析中...";

 try {
 let tracks = [];

 // Pattern 1: Track ID in Apple Music URL (?i=123456 or /song/.../123456)
 const trackIdMatch = clean.match(/[?&]i=(\d+)/) || clean.match(/\/song\/[^/]+\/(\d+)/);
 if (trackIdMatch) {
 const trackId = trackIdMatch[1];
 if (statusText) statusText.textContent = `Apple Music 曲ID (${trackId}) を直接取得中...`;
 try {
 const data = await jsonpFetch(`https://itunes.apple.com/lookup?id=${trackId}&country=jp`);
 if (data && Array.isArray(data.results) && data.results.length > 0) {
 const r = data.results[0];
 if (r.previewUrl) {
 tracks.push({
 id: "apple_" + r.trackId,
 apple_id: String(r.trackId),
 title: r.trackName,
 artist: r.artistName || "",
 album: r.collectionName || "",
 thumbnail: (r.artworkUrl100 || "").replace("100x100bb", "300x300bb"),
 preview_url: r.previewUrl,
 url: r.previewUrl,
 duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 30,
 bpm: 120,
 source: "apple_music",
 });
 }
 }
 } catch (_) {}
 }

 // Pattern 2: Album or Playlist ID in Apple Music URL (/album/.../123456)
 if (tracks.length === 0) {
 const albumMatch = clean.match(/\/album\/(?:[^/]+\/)?(\d+)/);
 if (albumMatch) {
 const albumId = albumMatch[1];
 if (statusText) statusText.textContent = `Apple Music アルバムID (${albumId}) を取得中...`;
 try {
 const data = await jsonpFetch(`https://itunes.apple.com/lookup?id=${albumId}&entity=song&country=jp&limit=50`);
 if (data && Array.isArray(data.results)) {
 data.results.filter(r => r.wrapperType === "track" && r.previewUrl).forEach((r) => {
 tracks.push({
 id: "apple_" + r.trackId,
 apple_id: String(r.trackId),
 title: r.trackName,
 artist: r.artistName || "",
 album: r.collectionName || "",
 thumbnail: (r.artworkUrl100 || "").replace("100x100bb", "300x300bb"),
 preview_url: r.previewUrl,
 url: r.previewUrl,
 duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 30,
 bpm: 120,
 source: "apple_music",
 });
 });
 }
 } catch (_) {}
 }
 }

 // Pattern 3: If not a direct Apple Music ID, search by text query via JSONP
 if (tracks.length === 0) {
 const searchTerm = clean.replace(/https?:\/\/[^\s]+/g, "").trim() || clean;
 try {
 const data = await jsonpFetch(`https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&country=jp&media=music&entity=song&limit=15`);
 if (data && Array.isArray(data.results)) {
 data.results.filter(r => r.previewUrl).forEach((r) => {
 tracks.push({
 id: "apple_" + r.trackId,
 apple_id: String(r.trackId),
 title: r.trackName,
 artist: r.artistName || "",
 album: r.collectionName || "",
 thumbnail: (r.artworkUrl100 || "").replace("100x100bb", "300x300bb"),
 preview_url: r.previewUrl,
 url: r.previewUrl,
 duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 30,
 bpm: 120,
 source: "apple_music",
 });
 });
 }
 } catch (_) {}
 }

 // Pattern 4: Fallback to local server endpoint if available
 if (tracks.length === 0) {
 try {
 const res = await fetch(apiUrl("/api/music-app/resolve-apple-url"), {
 method: "POST",
 headers: { "Content-Type": "application/json" },
 body: JSON.stringify({ text: clean }),
 });
 if (res.ok) {
 const data = await res.json();
 if (data && data.ok && Array.isArray(data.tracks)) {
 tracks = data.tracks;
 }
 }
 } catch (_) {}
 }

 if (tracks.length === 0) {
 if (statusText) statusText.textContent = "曲が見つかりませんでした。曲名やアーティスト名で検索してください。";
 return;
 }

 for (const it of tracks) {
 addTrackToAutoDjQueue(it);
 }
 preloadInitialAutoDjDecks();

 if (statusText) {
 statusText.textContent = `合計 ${tracks.length}曲をセットリストへ追加しました（先頭: ${tracks[0].title} - ${tracks[0].artist}）`;
 }
 } catch (err) {
 if (statusText) statusText.textContent = `解析エラー: ${err.message}`;
 }
 }

 function bindIphoneMusicModal() {
 const modal = document.getElementById("iphoneMusicModal");
 if (!modal) return;

 document.getElementById("btnCloseIphoneMusicModal").addEventListener("click", () => {
 stopPreviewAudio();
 modal.classList.add("hidden");
 });
 modal.addEventListener("click", (e) => {
 if (e.target === modal) {
 stopPreviewAudio();
 modal.classList.add("hidden");
 }
 });

 document.querySelectorAll(".music-tab-btn").forEach((btn) => {
 btn.addEventListener("click", () => {
 stopPreviewAudio();
 switchIphoneMusicTab(btn.dataset.mtab);
 });
 });

 
    // Direct PC Music Folder Picker (works on Chrome, Edge, Safari on PC!)
    const btnPickFolder = document.getElementById("btnPickLocalMusicFolder");
    const inputFolder = document.getElementById("inputLocalMusicFolder");
    if (btnPickFolder) {
      btnPickFolder.addEventListener("click", async () => {
        const summaryEl = document.getElementById("musicLocalSummary");
        // Modern File System Access API
        if (window.showDirectoryPicker) {
          try {
            const dirHandle = await window.showDirectoryPicker();
            if (summaryEl) summaryEl.textContent = "PCフォルダ内をスキャン中: " + dirHandle.name + "...";
            const files = [];
            async function scanDir(handle, currentPath = "") {
              for await (const entry of handle.values()) {
                if (entry.kind === "file") {
                  const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
                  if ([".mp3", ".m4a", ".wav", ".aac", ".flac", ".aiff", ".aif", ".ogg"].includes(ext)) {
                    const file = await entry.getFile();
                    files.push({ file, relPath: currentPath ? currentPath + "/" + entry.name : entry.name });
                  }
                } else if (entry.kind === "directory") {
                  await scanDir(entry, currentPath ? currentPath + "/" + entry.name : entry.name);
                }
              }
            }
            await scanDir(dirHandle);
            loadScannedLocalFilesIntoTable(files);
            return;
          } catch (err) {
            if (err.name === "AbortError") return;
            console.warn("showDirectoryPicker failed, falling back to input:", err);
          }
        }
        if (inputFolder) inputFolder.click();
      });
    }

    if (inputFolder) {
      inputFolder.addEventListener("change", (e) => {
        const rawFiles = Array.from(e.target.files || []);
        const files = rawFiles
          .filter((f) => {
            const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
            return [".mp3", ".m4a", ".wav", ".aac", ".flac", ".aiff", ".aif", ".ogg"].includes(ext);
          })
          .map((file) => ({ file, relPath: file.webkitRelativePath || file.name }));
        loadScannedLocalFilesIntoTable(files);
      });
    }

    function loadScannedLocalFilesIntoTable(scannedFiles) {
      const summaryEl = document.getElementById("musicLocalSummary");
      const badgeEl = document.getElementById("musicLocalTotalBadge");
      const artistSelect = document.getElementById("selectMusicLocalArtist");

      if (!scannedFiles || scannedFiles.length === 0) {
        if (summaryEl) summaryEl.textContent = "指定されたフォルダ内に音声ファイル（.mp3 / .m4a / .wav）が見つかりませんでした。";
        return;
      }

      const tracks = scannedFiles.map((item, idx) => {
        const parts = item.relPath.split(/[/\\]/);
        const fileName = parts[parts.length - 1];
        const album = parts.length >= 2 ? parts[parts.length - 2] : "";
        const artist = parts.length >= 3 ? parts[parts.length - 3] : (album || "PC Music");
        const title = fileName.replace(/\.[^/.]+$/, "").replace(/^[0-9]+[\s._-]+/, "").trim() || fileName;

        return {
          id: "local_pc_" + idx + "_" + Date.now(),
          title: title,
          artist: artist,
          album: album,
          fileBlob: item.file,
          duration: 180,
          bpm: 120,
          source: "local"
        };
      });

      scannedFolderTracks = tracks;
      localMusicShownTracks = tracks;
      if (badgeEl) badgeEl.textContent = tracks.length.toLocaleString() + "曲";
      if (summaryEl) {
        summaryEl.innerHTML = `<span style="color:#34d399;font-weight:700;"> PCフォルダから ${tracks.length.toLocaleString()}曲の読み込みが完了しました！</span> デッキ読込ボタンですぐに再生できます。`;
      }

      // Populate artist dropdown
      if (artistSelect) {
        const artistMap = {};
        tracks.forEach(t => { artistMap[t.artist] = (artistMap[t.artist] || 0) + 1; });
        const sorted = Object.keys(artistMap).sort().map(name => ({ name, count: artistMap[name] }));
        artistSelect.innerHTML = `<option value="">すべてのアーティスト (${tracks.length.toLocaleString()}曲)</option>`;
        sorted.forEach(a => {
          const opt = document.createElement("option");
          opt.value = a.name;
          opt.textContent = `${a.name} (${a.count}曲)`;
          artistSelect.appendChild(opt);
        });
      }

      renderLocalMusicTable();
    }

    // iPhone Audio File Picker button in Local Tab
    const btnPickIphoneLocal = document.getElementById("btnPickIphoneAudioFilesLocal");
    if (btnPickIphoneLocal) {
      btnPickIphoneLocal.addEventListener("click", () => {
        modal.classList.add("hidden");
        openMultiTrackFilePicker();
      });
    }
  
// Tab 1: Local synced Music / iTunes library controls
 const searchInput = document.getElementById("inputMusicLocalSearch");
 const artistSelect = document.getElementById("selectMusicLocalArtist");
 if (searchInput) {
 searchInput.addEventListener("input", () => {
 clearTimeout(musicSearchDebounceTimer);
 musicSearchDebounceTimer = setTimeout(() => fetchLocalMusicLibrary(false), 220);
 });
 }
 if (artistSelect) {
 artistSelect.addEventListener("change", () => fetchLocalMusicLibrary(false));
 }
 document.getElementById("btnMusicRefreshLocal").addEventListener("click", () => {
 fetchLocalMusicLibrary(true);
 });
 document.getElementById("btnMusicAddShownToQueue").addEventListener("click", () => {
 if (!localMusicShownTracks.length) return;
 const slice = localMusicShownTracks.slice(0, 30);
 slice.forEach((tr) => addTrackToAutoDjQueue(tr));
 renderLocalMusicTable();
 preloadInitialAutoDjDecks();
 const summaryEl = document.getElementById("musicLocalSummary");
 if (summaryEl) {
 summaryEl.textContent = ` 表示中の ${slice.length}曲を Auto DJ セットリストへ一括追加しました！`;
 }
 });

 // Tab 2: iPhone Music Share Link & Apple Music Catalog Search
 const shareInput = document.getElementById("inputAppleShareUrl");
 document.getElementById("btnPasteAppleUrl").addEventListener("click", async () => {
 try {
 if (navigator.clipboard && navigator.clipboard.readText) {
 const clip = await navigator.clipboard.readText();
 if (clip && clip.trim()) {
 shareInput.value = clip.trim();
 await resolveAndImportAppleMusicInput(clip.trim());
 return;
 }
 }
 } catch (_) {}
 if (shareInput.value.trim()) {
 await resolveAndImportAppleMusicInput(shareInput.value.trim());
 } else {
 shareInput.focus();
 }
 });

 document.getElementById("btnResolveAppleUrl").addEventListener("click", () => {
 resolveAndImportAppleMusicInput(shareInput.value);
 });
 shareInput.addEventListener("keydown", (e) => {
 if (e.key === "Enter") resolveAndImportAppleMusicInput(shareInput.value);
 });

 // Apple Music Catalog Search (Direct Apple Search API + Local Sync fallback)
 const catalogInput = document.getElementById("inputAppleCatalogSearch");
 const catalogGrid = document.getElementById("appleCatalogResultsGrid");
 async function doAppleCatalogSearch() {
 const q = (catalogInput.value || "").trim();
 if (!q) return;
 stopPreviewAudio();
 catalogGrid.innerHTML = `<div style="padding:14px;color:#fda4af;">Apple Music / iTunes カタログを検索中: 「${escapeHtml(q)}」...</div>`;
 try {
 let results = [];

 // 1. Direct CORS fetch to Apple iTunes Search API (Fastest on iOS Safari)
 try {
 const appleUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&country=jp&media=music&entity=song&limit=30`;
 const res = await fetch(appleUrl, { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined });
 if (res.ok) {
 const aData = await res.json();
 if (aData && Array.isArray(aData.results) && aData.results.length > 0) {
 results = aData.results
 .filter((r) => r.trackName && r.previewUrl)
 .map((r) => ({
 id: "apple_" + r.trackId,
 apple_id: String(r.trackId),
 title: r.trackName,
 artist: r.artistName || "",
 album: r.collectionName || "",
 thumbnail: (r.artworkUrl100 || "").replace("100x100bb", "300x300bb"),
 preview_url: r.previewUrl,
 url: r.previewUrl,
 duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 30,
 bpm: 120,
 source: "apple_music",
 }));
 }
 }
 } catch (_) {}

 // 2. Direct Apple iTunes API Search via JSONP
 if (results.length === 0) {
 try {
 const appleUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&country=jp&media=music&entity=song&limit=30`;
 const aData = await jsonpFetch(appleUrl, 6000);
 if (aData && Array.isArray(aData.results) && aData.results.length > 0) {
 results = aData.results
 .filter((r) => r.trackName && r.previewUrl)
 .map((r) => ({
 id: "apple_" + r.trackId,
 apple_id: String(r.trackId),
 title: r.trackName,
 artist: r.artistName || "",
 album: r.collectionName || "",
 thumbnail: (r.artworkUrl100 || "").replace("100x100bb", "300x300bb"),
 preview_url: r.previewUrl,
 url: r.previewUrl,
 duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 30,
 bpm: 120,
 source: "apple_music",
 }));
 }
 } catch (itunesErr) {
 console.warn("iTunes JSONP search failed:", itunesErr);
 }
 }

 // 3. Public CORS proxy fallback
 if (results.length === 0) {
 try {
 const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&country=jp&media=music&entity=song&limit=30`)}`;
 const res = await fetch(proxyUrl, { signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined });
 if (res.ok) {
 const aData = await res.json();
 if (aData && Array.isArray(aData.results) && aData.results.length > 0) {
 results = aData.results
 .filter((r) => r.trackName && r.previewUrl)
 .map((r) => ({
 id: "apple_" + r.trackId,
 apple_id: String(r.trackId),
 title: r.trackName,
 artist: r.artistName || "",
 album: r.collectionName || "",
 thumbnail: (r.artworkUrl100 || "").replace("100x100bb", "300x300bb"),
 preview_url: r.previewUrl,
 url: r.previewUrl,
 duration: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 30,
 bpm: 120,
 source: "apple_music",
 }));
 }
 }
 } catch (_) {}
 }

 // 4. Server endpoint fallback if connected
 if (results.length === 0) {
 try {
 const sUrl = apiUrl(`/api/music-app/apple-search?q=${encodeURIComponent(q)}`);
 if (sUrl && (sUrl.startsWith("http://") || sUrl.startsWith("https://") || !window.location.hostname.includes("github.io"))) {
 const res = await fetch(sUrl, { signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined });
 if (res.ok) {
 const cType = res.headers.get("content-type") || "";
 if (cType.includes("application/json")) {
 const data = await res.json();
 if (data && data.ok && Array.isArray(data.results)) {
 results = data.results;
 }
 }
 }
 }
 } catch (_) {}
 }

 catalogGrid.innerHTML = "";
 if (results.length === 0) {
 catalogGrid.innerHTML = `<div style="padding:14px;color:#9ca3af;">「${escapeHtml(q)}」に一致する曲が見つかりませんでした。別のキーワード（歌手名や曲名）でお試しください。</div>`;
 return;
 }

 results.forEach((item) => {
 const isLocal = Boolean(item.local_track);
 const inQueue = isLocal && autoDjQueue.some((x) => x.id === item.local_track.id);
 const card = document.createElement("div");
 card.className = "yt-item-card";
 card.innerHTML = `
 <img class="yt-thumb" src="${escapeHtml(item.thumbnail || "")}" alt="" />
 <div class="yt-meta">
 <div class="yt-title">
 ${escapeHtml(item.title)}
 ${
 isLocal
 ? '<span style="background:#065f46;color:#6ee7b7;font-size:9px;padding:1px 6px;border-radius:999px;margin-left:6px;">同期曲あり・即読込</span>'
 : ""
 }
 </div>
 <div class="yt-sub">${escapeHtml(item.artist)} · ${escapeHtml(item.album || "")} (${formatShortTime(item.duration || 0)})</div>
 </div>
 <div class="yt-actions">
 ${
 item.preview_url
 ? '<button class="hdr-btn btn-qr" style="padding:4px 7px;font-size:10px;" data-act="preview">試聴</button>'
 : ""
 }
 <button class="hdr-btn ${inQueue ? "btn-demo-gradient" : "btn-autodj-pro"}" style="padding:4px 8px;font-size:10px;" data-act="queue">
 ${inQueue ? "セット済" : "Auto DJ"}
 </button>
 <button class="hdr-btn btn-load-d1" style="padding:4px 8px;font-size:10px;" data-act="d1">Deck 1</button>
 <button class="hdr-btn btn-load-d2" style="padding:4px 8px;font-size:10px;" data-act="d2">Deck 2</button>
 </div>
 `;

 const prevBtn = card.querySelector('[data-act="preview"]');
 if (prevBtn && item.preview_url) {
 prevBtn.addEventListener("click", () => {
 if (previewAudioEl && previewAudioEl.dataset.appleId === item.apple_id && !previewAudioEl.paused) {
 stopPreviewAudio();
 prevBtn.textContent = "試聴";
 return;
 }
 stopPreviewAudio();
 document.querySelectorAll('#appleCatalogResultsGrid [data-act="preview"]').forEach((b) => {
 b.textContent = "試聴";
 });
 engine.resume();
 previewAudioEl = new Audio(item.preview_url);
 previewAudioEl.dataset.appleId = item.apple_id;
 previewAudioEl.volume = 0.8;
 previewAudioEl.play().catch(() => {});
 prevBtn.textContent = "停止";
 previewAudioEl.addEventListener("ended", () => {
 prevBtn.textContent = "試聴";
 });
 });
 }

 card.querySelector('[data-act="queue"]').addEventListener("click", async (ev) => {
 const btn = ev.currentTarget;
 btn.textContent = "追加中...";
 const added = await importAppleMusicTrackItem(item, "queue");
 btn.textContent = added ? "セット済" : "Auto DJ";
 });
 card.querySelector('[data-act="d1"]').addEventListener("click", async () => {
 await importAppleMusicTrackItem(item, 1);
 document.getElementById("iphoneMusicModal").classList.add("hidden");
 });
 card.querySelector('[data-act="d2"]').addEventListener("click", async () => {
 await importAppleMusicTrackItem(item, 2);
 document.getElementById("iphoneMusicModal").classList.add("hidden");
 });
 catalogGrid.appendChild(card);
 });
 } catch (err) {
 catalogGrid.innerHTML = `<div style="padding:14px;color:#ef4444;">検索エラー: ${escapeHtml(err.message)}</div>`;
 }
 }

 document.getElementById("btnAppleCatalogSearch").addEventListener("click", doAppleCatalogSearch);
 catalogInput.addEventListener("keydown", (e) => {
 if (e.key === "Enter") doAppleCatalogSearch();
 });

 // Tab 3: Native iPhone Shortcut & Direct Audio File Picker
 document.getElementById("btnIphoneDirectAudioFiles").addEventListener("click", () => {
 modal.classList.add("hidden");
 openMultiTrackFilePicker();
 });

 document.getElementById("btnCopyShortcutUrl").addEventListener("click", async () => {
 const urlText = document.getElementById("shortcutBridgeUrlDisplay").textContent;
 const msgEl = document.getElementById("copyShortcutUrlMsg");
 try {
 await navigator.clipboard.writeText(urlText);
 if (msgEl) msgEl.textContent = " コピーしました！";
 setTimeout(() => {
 if (msgEl) msgEl.textContent = "";
 }, 2500);
 } catch (_) {
 if (msgEl) msgEl.textContent = "URLを長押ししてコピーしてください";
 }
 });
 }

 function checkUrlIphoneMusicImport() {
 try {
 const params = new URLSearchParams(window.location.search);
 const imported = params.get("iphone_music");
 if (!imported || !imported.trim()) return;

 // Clean query parameter from address bar so refreshing doesn't re-import
 const cleanUrl = window.location.pathname + window.location.hash;
 window.history.replaceState({}, document.title, cleanUrl);

 openIphoneMusicModal("apple");
 const shareInput = document.getElementById("inputAppleShareUrl");
 if (shareInput) shareInput.value = imported.trim();
 resolveAndImportAppleMusicInput(imported.trim());
 } catch (_) {}
 }

 // ==================== KEYBOARD & MIDI ====================
 function bindKeyboardShortcuts() {
 window.addEventListener("keydown", (e) => {
 if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || e.target.tagName === "TEXTAREA") return;
 const key = e.key.toLowerCase();
 if (key === "escape") {
 stopPreviewAudio();
 document.getElementById("youtubeModal").classList.add("hidden");
 document.getElementById("qrModal").classList.add("hidden");
 document.getElementById("autoDjModal").classList.add("hidden");
 document.getElementById("iphoneMusicModal").classList.add("hidden");
 } else if (key === " " || key === "q") {
 e.preventDefault();
 document.getElementById("btnPlay1").click();
 } else if (key === "p") {
 e.preventDefault();
 document.getElementById("btnPlay2").click();
 } else if (key === "w") {
 engine.deck1.pressCue();
 setTimeout(() => engine.deck1.releaseCue(), 150);
 } else if (key === "o") {
 engine.deck2.pressCue();
 setTimeout(() => engine.deck2.releaseCue(), 150);
 } else if (key === "e") {
 document.getElementById("btnSync1").click();
 } else if (key === "i") {
 document.getElementById("btnSync2").click();
 }
 });
 }

 function initWebMIDI() {
 const midiBtn = document.getElementById("btnMidiStatus");
 if (!navigator.requestMIDIAccess) return;
 navigator.requestMIDIAccess().then((midiAccess) => {
 const updatePorts = () => {
 const inputs = Array.from(midiAccess.inputs.values());
 if (inputs.length > 0) {
 midiBtn.innerHTML = `<span class="dot-green"></span> WebMIDI: ${escapeHtml(inputs[0].name.slice(0, 18))}`;
 inputs.forEach((input) => {
 input.onmidimessage = (msg) => {
 const [status, data1, data2] = msg.data;
 const cmd = status & 0xf0;
 const ch = status & 0x0f;
 if (cmd === 0x90 && data2 > 0) {
 if (data1 === 0x0b) document.getElementById(ch === 0 ? "btnPlay1" : "btnPlay2").click();
 else if (data1 === 0x0c) (ch === 0 ? engine.deck1 : engine.deck2).pressCue();
 else if (data1 === 0x58) document.getElementById(ch === 0 ? "btnSync1" : "btnSync2").click();
 } else if (cmd === 0xb0) {
 const norm = data2 / 127.0;
 if (data1 === 0x1f) {
 const pos = norm * 2 - 1;
 document.getElementById("crossfader").value = pos;
 engine.setCrossfader(pos);
 } else if (data1 === 0x13) {
 if (ch === 0) {
 document.getElementById("chFader1").value = norm;
 engine.deck1.chFaderGain.gain.setTargetAtTime(norm, engine.ctx.currentTime, 0.01);
 } else if (ch === 1) {
 document.getElementById("chFader2").value = norm;
 engine.deck2.chFaderGain.gain.setTargetAtTime(norm, engine.ctx.currentTime, 0.01);
 }
 }
 }
 };
 });
 }
 };
 midiAccess.onstatechange = updatePorts;
 updatePorts();
 });
 }

 // ==================== iPHONE SCREEN-CLOSED BACKGROUND AUDIO & LOCK SCREEN CONTROLS ====================
 let lastLockScreenTrackKey = "";
 let manualAdvanceBusy = false;
 let screenWakeLockSentinel = null;

 function setDeckPlayingStateUI(deckId, shouldPlay) {
 const deck = deckId === 1 ? engine.deck1 : engine.deck2;
 if (!deck) return;
 deck.endedNaturally = false;
 if (shouldPlay) {
 engine.resume();
 if (deck.duration > 0 && deck.playheadSec >= deck.duration - 0.15) {
 deck.playheadSec = 0;
 }
 deck.isPlaying = true;
 } else {
 deck.isPlaying = false;
 }
 const btnPlay = document.getElementById(`btnPlay${deckId}`);
 if (btnPlay) {
 btnPlay.classList.toggle("playing", deck.isPlaying);
 btnPlay.textContent = deck.isPlaying ? "" : "▶";
 }
 const stateEl = document.getElementById(`lcdState${deckId}`);
 if (stateEl) {
 stateEl.textContent = deck.isPlaying ? "PLAYING" : "PAUSED";
 }
 }

 async function updateScreenWakeLock(shouldHold) {
 if (!("wakeLock" in navigator)) return;
 try {
 if (shouldHold && !document.hidden) {
 if (!screenWakeLockSentinel) {
 screenWakeLockSentinel = await navigator.wakeLock.request("screen");
 screenWakeLockSentinel.addEventListener("release", () => {
 screenWakeLockSentinel = null;
 });
 }
 } else if (!shouldHold && screenWakeLockSentinel) {
 await screenWakeLockSentinel.release();
 screenWakeLockSentinel = null;
 }
 } catch (_) {}
 }

 function getActiveNowPlayingDeck() {
 if (autoDj.enabled) {
 return autoDj.activeDeckId === 2 ? engine.deck2 : engine.deck1;
 }
 if (engine.deck1.isPlaying) return engine.deck1;
 if (engine.deck2.isPlaying) return engine.deck2;
 if (engine.deck1.buffer) return engine.deck1;
 if (engine.deck2.buffer) return engine.deck2;
 return engine.deck1;
 }

 function syncBackgroundPlaybackAndLockScreen(forceMetadata = false) {
 const isAutoDjRunning = Boolean(autoDj.enabled && !autoDj.pausedInBackground);
 const anyPlaying = Boolean(isAutoDjRunning || engine.deck1.isPlaying || engine.deck2.isPlaying);

 engine.setBackgroundPlaybackActive(anyPlaying);
 updateScreenWakeLock(anyPlaying);

 if (!("mediaSession" in navigator)) return;
 try {
 navigator.mediaSession.playbackState = anyPlaying ? "playing" : "paused";
 const activeDeck = getActiveNowPlayingDeck();
 const tr = activeDeck && activeDeck.track ? activeDeck.track : null;
 const trackKey = tr
 ? `${tr.id || ""}|${tr.title || ""}|${autoDj.enabled ? "autodj" : "manual"}`
 : "idle";

 if ((forceMetadata || trackKey !== lastLockScreenTrackKey) && typeof MediaMetadata !== "undefined") {
 lastLockScreenTrackKey = trackKey;
 const artworkList = [];
 if (tr && tr.thumbnail) {
 artworkList.push({ src: tr.thumbnail, sizes: "480x360", type: "image/jpeg" });
 }
 artworkList.push({ src: "/icon-512.svg", sizes: "512x512", type: "image/svg+xml" });

 navigator.mediaSession.metadata = new MediaMetadata({
 title: tr ? tr.title : "DDJ-FLX4 Web DJ",
 artist: tr && tr.artist ? tr.artist : "Pioneer DJ DDJ-FLX4",
 album: autoDj.enabled ? "AUTO DJ PRO (Background Live Mix)" : "DDJ-FLX4 Manual DJ Mode",
 artwork: artworkList,
 });
 }
 } catch (_) {}
 }

 async function checkManualModeNaturalTrackEnd() {
 if (autoDj.enabled || manualAdvanceBusy) return;

 const d1Ended = engine.deck1.endedNaturally;
 const d2Ended = engine.deck2.endedNaturally;
 if (!d1Ended && !d2Ended) return;

 const finishedDeckId = d1Ended ? 1 : 2;
 const finishedDeck = finishedDeckId === 1 ? engine.deck1 : engine.deck2;
 const otherDeck = finishedDeckId === 1 ? engine.deck2 : engine.deck1;

 finishedDeck.endedNaturally = false;
 setDeckPlayingStateUI(finishedDeckId, false);

 // If the user queued multiple tracks in the setlist and is listening in Manual Mode (e.g. with iPhone screen closed),
 // automatically load and play the next track in order so playback never stops after 1 track!
 if (!otherDeck.isPlaying && autoDjQueue.length > 1) {
 manualAdvanceBusy = true;
 try {
 const curId = finishedDeck.track ? finishedDeck.track.id : null;
 const curIdx = autoDjQueue.findIndex((t) => t.id === curId);
 const nextIdx = curIdx >= 0 ? (curIdx + 1) % autoDjQueue.length : 0;
 const nextTrack = autoDjQueue[nextIdx];
 if (nextTrack) {
 // Ensure crossfader/channel fader make this deck audible
 setChannelFaderProgrammatically(finishedDeckId, 0.95);
 await loadTrackIntoDeck(finishedDeckId, nextTrack, 0);
 setDeckPlayingStateUI(finishedDeckId, true);
 syncBackgroundPlaybackAndLockScreen(true);
 return;
 }
 } catch (_) {
 } finally {
 manualAdvanceBusy = false;
 }
 }

 syncBackgroundPlaybackAndLockScreen(false);
 }

 async function triggerLockScreenTrackStep(direction = 1) {
 engine.unlockIosAudio();
 if (autoDj.enabled) {
 autoDj.pausedInBackground = false;
 const forceDropBtn = document.getElementById("btnAutoDjForceDrop");
 if (direction < 0 && autoDjQueue.length > 1) {
 autoDj.playlistCursor = (autoDj.playlistCursor - 2 + autoDjQueue.length * 2) % autoDjQueue.length;
 autoDj.nextTrackPrepared = false;
 }
 if (forceDropBtn) {
 forceDropBtn.click();
 }
 syncBackgroundPlaybackAndLockScreen(true);
 return;
 }

 // Manual Mode Lock Screen Next / Previous Track
 const activeDeckId = engine.deck2.isPlaying && !engine.deck1.isPlaying ? 2 : 1;
 const activeDeck = activeDeckId === 1 ? engine.deck1 : engine.deck2;
 if (direction < 0 && activeDeck.playheadSec > 5.0) {
 activeDeck.seekTo(0);
 setDeckPlayingStateUI(activeDeckId, true);
 syncBackgroundPlaybackAndLockScreen(true);
 return;
 }
 if (autoDjQueue.length > 0) {
 const curId = activeDeck.track ? activeDeck.track.id : null;
 const curIdx = autoDjQueue.findIndex((t) => t.id === curId);
 const nextIdx =
 curIdx >= 0
 ? (curIdx + direction + autoDjQueue.length) % autoDjQueue.length
 : 0;
 const targetTrack = autoDjQueue[nextIdx];
 if (targetTrack) {
 await loadTrackIntoDeck(activeDeckId, targetTrack, 0);
 setDeckPlayingStateUI(activeDeckId, true);
 syncBackgroundPlaybackAndLockScreen(true);
 }
 }
 }

 function runBackgroundDjLoop() {
 if (engine.bgKeepAliveWanted && engine.ctx.state !== "running") {
 engine.resume();
 }
 updateAutoDjFrame();
 checkManualModeNaturalTrackEnd();
 }

 function initBackgroundPlaybackSupport() {
 // 1. Unlock iOS AudioContext + <audio> Playback Session on very first touch/click anywhere
 const gestureUnlock = () => {
 engine.unlockIosAudio();
 };
 window.addEventListener("touchstart", gestureUnlock, { passive: true });
 window.addEventListener("pointerdown", gestureUnlock, { passive: true });
 window.addEventListener("click", gestureUnlock, { passive: true });

 // 2. Drive Auto DJ & Manual Track Auto-Advance from unthrottled Web Audio clock + timer fallback when screen is closed!
 engine.onBackgroundTick = () => {
 runBackgroundDjLoop();
 };
 setInterval(() => {
 if (document.hidden || performance.now() - (engine.lastForegroundFrameMs || 0) > 120) {
 runBackgroundDjLoop();
 }
 }, 200);

 // 3. Handle iPhone Screen Lock / Unlock transitions cleanly
 document.addEventListener("visibilitychange", () => {
 const isAutoDjRunning = Boolean(autoDj.enabled && !autoDj.pausedInBackground);
 const anyPlaying = Boolean(isAutoDjRunning || engine.deck1.isPlaying || engine.deck2.isPlaying);
 if (document.hidden) {
 if (anyPlaying) {
 autoDj.lastFrameAudioTime = engine.ctx.currentTime;
 engine.setBackgroundPlaybackActive(true);
 }
 } else {
 if (anyPlaying) {
 engine.resume();
 updateScreenWakeLock(true);
 }
 setDeckPlayingStateUI(1, engine.deck1.isPlaying);
 setDeckPlayingStateUI(2, engine.deck2.isPlaying);
 syncBackgroundPlaybackAndLockScreen(true);
 }
 });

 window.addEventListener("pageshow", () => {
 if (engine.bgKeepAliveWanted) {
 engine.resume();
 }
 });

 // 4. Register iPhone Lock Screen / Control Center / Dynamic Island / AirPods MediaSession Controls
 if ("mediaSession" in navigator) {
 const safeSetHandler = (action, fn) => {
 try {
 navigator.mediaSession.setActionHandler(action, fn);
 } catch (_) {}
 };

 safeSetHandler("play", () => {
 engine.unlockIosAudio();
 if (autoDj.enabled) {
 autoDj.pausedInBackground = false;
 autoDj.lastFrameAudioTime = engine.ctx.currentTime;
 setDeckPlayingStateUI(autoDj.activeDeckId, true);
 } else {
 const targetId = engine.deck1.buffer ? 1 : engine.deck2.buffer ? 2 : 0;
 if (targetId) setDeckPlayingStateUI(targetId, true);
 }
 syncBackgroundPlaybackAndLockScreen(true);
 });

 safeSetHandler("pause", () => {
 if (autoDj.enabled) {
 autoDj.pausedInBackground = true;
 }
 setDeckPlayingStateUI(1, false);
 setDeckPlayingStateUI(2, false);
 syncBackgroundPlaybackAndLockScreen(true);
 });

 safeSetHandler("nexttrack", () => {
 triggerLockScreenTrackStep(1);
 });

 safeSetHandler("previoustrack", () => {
 triggerLockScreenTrackStep(-1);
 });
 }
 }

 // ==================== 60FPS RENDER LOOP ====================
 function renderLoop() {
 try {
 engine.lastForegroundFrameMs = performance.now();
 updateAutoDjFrame();
 checkManualModeNaturalTrackEnd();
 updateDeckTelemetry(1, engine.deck1);
 updateDeckTelemetry(2, engine.deck2);

 drawStyledZoomWaveform(engine.deck1, document.getElementById("zoomWave1"), "orange");
 drawStyledZoomWaveform(engine.deck2, document.getElementById("zoomWave2"), "blue");

 drawStyledOverviewWaveform(engine.deck1, document.getElementById("overviewWave1"), "orange");
 drawStyledOverviewWaveform(engine.deck2, document.getElementById("overviewWave2"), "blue");

 if (engine.isRecording && recActiveMode === "screen" && performance.now() - lastRecFrameMs >= 30) {
 drawLiveControllerRecordingFrame();
 }
 } catch (err) {
 console.error("[renderLoop Frame Error]", err);
 } finally {
 requestAnimationFrame(renderLoop);
 }
 }

 function updateDeckTelemetry(deckId, deck) {
 const curBpm = deck.getCurrentBpm();
 const pitchPct = deck.baseBpm > 0 ? ((curBpm - deck.baseBpm) / deck.baseBpm) * 100 : 0;
 const sign = pitchPct >= 0 ? "+" : "";

 document.getElementById(`waveBpm${deckId}`).textContent = curBpm.toFixed(2);
 document.getElementById(`wavePitch${deckId}`).textContent = `${sign}${pitchPct.toFixed(1)}%`;

 document.getElementById(`waveTime${deckId}`).textContent = formatTime(deck.playheadSec);
 document.getElementById(`waveRemain${deckId}`).textContent = formatTime(deck.duration || 0);

 // Bar & Beat Count (e.g. BAR 16.1)
 const barBadge = document.getElementById(`waveBarCount${deckId}`);
 if (barBadge) {
 if (deck.buffer && deck.duration > 0 && typeof deck.getBarAndBeat === "function") {
 const bb = deck.getBarAndBeat();
 barBadge.textContent = `BAR ${bb.displayStr}`;
 } else {
 barBadge.textContent = "BAR 1.1";
 }
 }

 const platter = document.getElementById(`jogPlatter${deckId}`);
 platter.style.transform = `rotate(${deck.platterAngle.toFixed(1)}deg)`;

 // Center On-Jog LCD display (BPM / REMAIN / BAR / LOOP)
 const modeLabelEl = document.getElementById(`jogLcdMode${deckId}`);
 const lcdValEl = document.getElementById(`lcdBpm${deckId}`);
 if (lcdValEl) {
 if (deck.isScratching) {
 if (modeLabelEl) modeLabelEl.textContent = "SCRATCH";
 lcdValEl.textContent = "VINYL";
 } else if (!deck.buffer) {
 if (modeLabelEl) modeLabelEl.textContent = `DECK ${deckId}`;
 lcdValEl.textContent = "READY";
 } else {
 const mode = deck.jogLcdMode || "bpm";
 if (mode === "remain") {
 if (modeLabelEl) modeLabelEl.textContent = "REMAIN";
 const remSec = Math.max(0, Math.floor((deck.duration || 0) - deck.playheadSec));
 lcdValEl.textContent = `-${formatShortTime(remSec)}`;
 } else if (mode === "bar") {
 if (modeLabelEl) modeLabelEl.textContent = "BAR";
 const bb = typeof deck.getBarAndBeat === "function" ? deck.getBarAndBeat() : { displayStr: "1.1" };
 lcdValEl.textContent = `${bb.displayStr}`;
 } else if (mode === "loop") {
 if (modeLabelEl) modeLabelEl.textContent = "LOOP";
 lcdValEl.textContent = deck.loopActive ? `${deck.loopLengthBeats}B ON` : `${deck.loopLengthBeats}B`;
 } else {
 if (modeLabelEl) modeLabelEl.textContent = "BPM";
 lcdValEl.textContent = curBpm.toFixed(1);
 }
 }
 }

 const vuLevel = deck.getVuLevel();
 const leds = document.querySelectorAll(`#vuCol${deckId} .vu-seg`);
 const thresholds = [0.05, 0.14, 0.24, 0.36, 0.48, 0.62, 0.76, 0.90];
 leds.forEach((led) => {
 const idx = parseInt(led.dataset.lvl, 10);
 led.classList.toggle("on", vuLevel >= thresholds[idx]);
 });
 }

 function resizeCanvasIfNeeded(canvas) {
 const w = canvas.clientWidth;
 const h = canvas.clientHeight;
 if (canvas.width !== w || canvas.height !== h) {
 canvas.width = w;
 canvas.height = h;
 }
 }

 function drawStyledZoomWaveform(deck, canvas, theme) {
 resizeCanvasIfNeeded(canvas);
 const ctx = canvas.getContext("2d");
 const w = canvas.width;
 const h = canvas.height;
 ctx.clearRect(0, 0, w, h);

 if (!deck.duration || deck.rgbPeaks.length === 0) return;

 const centerX = w * 0.5;
 const visibleSec = waveZoomFactor;
 const startSec = deck.playheadSec - visibleSec * 0.5;
 const endSec = startSec + visibleSec;
 const pxPerSec = w / visibleSec;

 // Active Loop Region
 if (deck.loopInSec !== null && deck.loopOutSec !== null) {
 const lx1 = centerX + (deck.loopInSec - deck.playheadSec) * pxPerSec;
 const lx2 = centerX + (deck.loopOutSec - deck.playheadSec) * pxPerSec;
 ctx.fillStyle = deck.loopActive ? "rgba(249, 115, 22, 0.25)" : "rgba(255, 255, 255, 0.08)";
 ctx.fillRect(lx1, 0, lx2 - lx1, h);
 }

 // 1. BEATGRID & BAR LINES (Downbeat = Red line + Bar number, Beat ticks = subtle line)
 const rawBpm = deck.getCurrentBpm() || deck.baseBpm || 120.0;
 const bpm = Math.max(20.0, Math.min(300.0, Number.isFinite(rawBpm) ? rawBpm : 120.0));
 const beatSec = 60.0 / bpm;
 const barSec = beatSec * 4.0;
 const firstBeat = Number.isFinite(deck.firstBeatSec) ? deck.firstBeatSec : 0;

 const minBeatIdx = Math.floor((startSec - firstBeat) / beatSec);
 const maxBeatIdx = Math.ceil((endSec - firstBeat) / beatSec);
 const safeMinBeat = Math.max(-500, Number.isFinite(minBeatIdx) ? minBeatIdx : 0);
 const safeMaxBeat = Math.min(safeMinBeat + 300, Number.isFinite(maxBeatIdx) ? maxBeatIdx : 0);

 for (let bi = safeMinBeat; bi <= safeMaxBeat; bi++) {
 const beatTime = firstBeat + bi * beatSec;
 if (beatTime < 0 || beatTime > deck.duration) continue;
 const bx = centerX + (beatTime - deck.playheadSec) * pxPerSec;
 if (bx < -20 || bx > w + 20) continue;

 const isDownbeat = ((bi % 4) + 4) % 4 === 0;
 if (isDownbeat) {
 const barNum = Math.floor(bi / 4) + 1;
 // Red solid Downbeat Bar Line (Pioneer DJ Style)
 ctx.strokeStyle = "rgba(239, 68, 68, 0.75)";
 ctx.lineWidth = 1.5;
 ctx.beginPath();
 ctx.moveTo(bx, 0);
 ctx.lineTo(bx, h);
 ctx.stroke();

 // Bar Number Tag at Top
 ctx.fillStyle = "#ef4444";
 ctx.font = "800 8.5px Consolas, monospace";
 ctx.textAlign = "center";
 ctx.fillText(String(barNum), bx, 9);
 } else {
 // Subtle Beat Grid Line
 ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
 ctx.lineWidth = 1;
 ctx.beginPath();
 ctx.moveTo(bx, 10);
 ctx.lineTo(bx, h - 3);
 ctx.stroke();
 }
 }

 // 2. 3-BAND REKORDBOX FREQUENCY WAVEFORM (Low = Deep Blue/Cyan, Mid = Amber/Orange, Hi = White/Ice)
 const numBins = deck.rgbPeaks.length;
 const midY = h / 2;

 for (let x = 0; x < w; x += 2) {
 const sec = startSec + (x / w) * visibleSec;
 if (sec < 0 || sec >= deck.duration) continue;
 const binIdx = Math.floor((sec / deck.duration) * numBins);
 const peak = deck.rgbPeaks[binIdx];
 if (!peak) continue;

 // 3Band Pro Separation:
 // LOW (Kick / Sub-bass): deep saturated cyan/blue
 const hLow = peak.low * (h * 0.46);
 ctx.fillStyle = "#0ea5e9";
 ctx.fillRect(x, midY - hLow, 1.5, hLow * 2);

 // MID (Vocals / Synths / Snares): energetic amber/orange
 const hMid = peak.mid * (h * 0.32);
 ctx.fillStyle = "#f59e0b";
 ctx.fillRect(x, midY - hMid, 1.5, hMid * 2);

 // HI (Hi-hats / Cymbals / Air): crisp white-cyan core
 const hHi = peak.high * (h * 0.18);
 ctx.fillStyle = "#ffffff";
 ctx.fillRect(x, midY - hHi, 1.5, hHi * 2);
 }

 // Center Cue Marker / Playhead indicator
 ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
 ctx.lineWidth = 1.5;
 ctx.beginPath();
 ctx.moveTo(centerX, 0);
 ctx.lineTo(centerX, h);
 ctx.stroke();
 }

 function drawStyledOverviewWaveform(deck, canvas, theme) {
 resizeCanvasIfNeeded(canvas);
 const ctx = canvas.getContext("2d");
 const w = canvas.width;
 const h = canvas.height;
 ctx.clearRect(0, 0, w, h);

 if (!deck.duration || deck.rgbPeaks.length === 0) return;

 const numBins = deck.rgbPeaks.length;
 const midY = h / 2;

 // 3-Band Overview Rendering
 for (let x = 0; x < w; x += 2) {
 const ratio = x / w;
 const binIdx = Math.min(numBins - 1, Math.floor(ratio * numBins));
 const peak = deck.rgbPeaks[binIdx];
 if (!peak) continue;

 const hLow = peak.low * (h * 0.45);
 ctx.fillStyle = "#0284c7";
 ctx.fillRect(x, midY - hLow, 1.5, hLow * 2);

 const hMid = peak.mid * (h * 0.30);
 ctx.fillStyle = "#d97706";
 ctx.fillRect(x, midY - hMid, 1.5, hMid * 2);

 const hHi = peak.high * (h * 0.16);
 ctx.fillStyle = "#f8fafc";
 ctx.fillRect(x, midY - hHi, 1.5, hHi * 2);
 }

 // Downbeat markers across full song (16-bar markers)
 const rawBpm = deck.getCurrentBpm() || deck.baseBpm || 120.0;
 const bpm = Math.max(20.0, Math.min(300.0, Number.isFinite(rawBpm) ? rawBpm : 120.0));
 const barSec = (60.0 / bpm) * 4.0;
 const firstBeat = Number.isFinite(deck.firstBeatSec) ? deck.firstBeatSec : 0;
 const totalBars = Math.max(0, Math.min(600, Math.floor((deck.duration - firstBeat) / barSec)));
 ctx.fillStyle = "rgba(239, 68, 68, 0.65)";
 for (let b = 0; b < totalBars; b += 16) {
 const bx = ((firstBeat + b * barSec) / deck.duration) * w;
 ctx.fillRect(bx - 0.5, 0, 1, h);
 }

 // Playhead White Bar
 const px = (deck.playheadSec / deck.duration) * w;
 ctx.fillStyle = "#ffffff";
 ctx.fillRect(px - 1, 0, 2, h);
 }

 // ==================== SCREEN + AUDIO VIDEO RECORDER & PREVIEW ====================
 function presentRecordingComplete(res) {
 if (!res || !res.url) return;
 if (lastRecordedResult && lastRecordedResult.url && lastRecordedResult.url !== res.url) {
 try {
 URL.revokeObjectURL(lastRecordedResult.url);
 } catch (_) {}
 }
 lastRecordedResult = res;

 const isIos =
 /iPhone|iPad|iPod/i.test(navigator.userAgent || "") ||
 (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

 // Trigger immediate download automatically on desktop browsers
 if (!isIos) {
 try {
 const a = document.createElement("a");
 a.href = res.url;
 a.download = res.filename;
 document.body.appendChild(a);
 a.click();
 a.remove();
 } catch (_) {}
 }

 // Show interactive Preview & Save Modal (works great on both PC and iPhone/iPad!)
 const modal = document.getElementById("recResultModal");
 const titleEl = document.getElementById("recResultTitle");
 const previewContainer = document.getElementById("recPreviewContainer");
 const metaEl = document.getElementById("recResultMeta");
 const dlLink = document.getElementById("btnRecDownloadLink");
 const shareBtn = document.getElementById("btnRecShareSave");

 if (!modal || !previewContainer) return;

 if (titleEl) {
 titleEl.textContent = res.isVideo
 ? "画面＋音声の録画が完了しました"
 : "DJミックス音声の録音が完了しました";
 }

 previewContainer.innerHTML = "";
 if (res.isVideo) {
 const vid = document.createElement("video");
 vid.src = res.url;
 vid.controls = true;
 vid.playsInline = true;
 vid.preload = "metadata";
 previewContainer.appendChild(vid);
 } else {
 const aud = document.createElement("audio");
 aud.src = res.url;
 aud.controls = true;
 previewContainer.appendChild(aud);
 }

 const sizeMb = ((res.blob?.size || 0) / (1024 * 1024)).toFixed(2);
 if (metaEl) {
 metaEl.textContent = `${res.filename} （${sizeMb} MB / ${res.ext.toUpperCase()}）`;
 }

 if (dlLink) {
 dlLink.href = res.url;
 dlLink.download = res.filename;
 }

 if (shareBtn) {
 let canShareFile = false;
 try {
 if (navigator.canShare && typeof File !== "undefined") {
 const testFile = new File([res.blob], res.filename, {
 type: res.mimeType || (res.isVideo ? "video/mp4" : "audio/mp4")
 });
 canShareFile = navigator.canShare({ files: [testFile] });
 }
 } catch (_) {}
 shareBtn.classList.toggle("hidden", !canShareFile);
 }

 modal.classList.remove("hidden");
 }

 function fillRoundRectPath(ctx, x, y, w, h, r) {
 const rad = Math.max(0, Math.min(r, w * 0.5, h * 0.5));
 ctx.beginPath();
 ctx.moveTo(x + rad, y);
 ctx.arcTo(x + w, y, x + w, y + h, rad);
 ctx.arcTo(x + w, y + h, x, y + h, rad);
 ctx.arcTo(x, y + h, x, y, rad);
 ctx.arcTo(x, y, x + w, y, rad);
 ctx.closePath();
 }

 function truncateCanvasText(ctx, str, maxW) {
 const s = String(str || "");
 if (ctx.measureText(s).width <= maxW) return s;
 let out = s;
 while (out.length > 1 && ctx.measureText(out + "…").width > maxW) {
 out = out.slice(0, -1);
 }
 return out + "…";
 }

 function readKnobNorm(id, fallbackNorm = 0.5) {
 const el = document.getElementById(id);
 if (!el) return fallbackNorm;
 const min = parseFloat(el.dataset.min);
 const max = parseFloat(el.dataset.max);
 const val = parseFloat(el.dataset.val);
 if (!Number.isFinite(min) || !Number.isFinite(max) || max === min || !Number.isFinite(val)) {
 return fallbackNorm;
 }
 return Math.max(0, Math.min(1, (val - min) / (max - min)));
 }

 // Renders live 1280x720 HD DDJ-FLX4 Controller Screen (Dual Waveforms + Jog Wheels + Mixer + Pads + Auto DJ Bar)
 function drawLiveControllerRecordingFrame() {
 if (!recScreenCanvas) return;
 lastRecFrameMs = performance.now();

 const ctx = recScreenCanvas.getContext("2d");
 const W = recScreenCanvas.width;
 const H = recScreenCanvas.height;

 // 1. Studio Dark Metallic Background
 const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
 bgGrad.addColorStop(0, "#090b10");
 bgGrad.addColorStop(1, "#0e121b");
 ctx.fillStyle = bgGrad;
 ctx.fillRect(0, 0, W, H);

 // 2. Top Header Bar (y: 0..42)
 ctx.fillStyle = "#10141e";
 ctx.fillRect(0, 0, W, 42);
 ctx.strokeStyle = "#1f2636";
 ctx.lineWidth = 1;
 ctx.beginPath();
 ctx.moveTo(0, 42);
 ctx.lineTo(W, 42);
 ctx.stroke();

 fillRoundRectPath(ctx, 16, 10, 42, 22, 4);
 ctx.fillStyle = "#f97316";
 ctx.fill();
 ctx.fillStyle = "#ffffff";
 ctx.font = "900 11px 'Segoe UI', sans-serif";
 ctx.textAlign = "center";
 ctx.fillText("WEB", 37, 25);

 ctx.textAlign = "left";
 ctx.fillStyle = "#f9fafb";
 ctx.font = "900 16px 'Segoe UI', sans-serif";
 ctx.fillText("Pioneer DJ DDJ-FLX4", 68, 27);

 // Mode Pill
 const modeLabel = autoDj.enabled ? " AUTO DJ PRO LIVE" : " MANUAL DJ MODE";
 fillRoundRectPath(ctx, 260, 9, 172, 24, 12);
 ctx.fillStyle = autoDj.enabled ? "rgba(236, 72, 153, 0.24)" : "rgba(59, 130, 246, 0.20)";
 ctx.fill();
 ctx.strokeStyle = autoDj.enabled ? "#ec4899" : "#3b82f6";
 ctx.stroke();
 ctx.fillStyle = "#ffffff";
 ctx.font = "800 11px 'Segoe UI', sans-serif";
 ctx.textAlign = "center";
 ctx.fillText(modeLabel, 346, 25);

 // REC Badge on Right
 const recElapsedSec = Math.max(0, Math.floor((Date.now() - (recStartTime || Date.now())) / 1000));
 const recBadgeText = `REC ${formatShortTime(recElapsedSec)}`;
 fillRoundRectPath(ctx, W - 152, 8, 136, 26, 13);
 ctx.fillStyle = "rgba(239, 68, 68, 0.25)";
 ctx.fill();
 ctx.strokeStyle = "#ef4444";
 ctx.stroke();

 const blinkOn = Math.floor(Date.now() / 500) % 2 === 0;
 ctx.beginPath();
 ctx.arc(W - 132, 21, 5, 0, Math.PI * 2);
 ctx.fillStyle = blinkOn ? "#ef4444" : "#991b1b";
 ctx.fill();

 ctx.fillStyle = "#ffffff";
 ctx.font = "800 12px Consolas, monospace";
 ctx.textAlign = "left";
 ctx.fillText(recBadgeText, W - 119, 25);

 // 3. Auto DJ Live Bar / Status Strip (y: 44..78)
 const liveBarGrad = ctx.createLinearGradient(0, 44, W, 44);
 liveBarGrad.addColorStop(0, "rgba(249, 115, 22, 0.16)");
 liveBarGrad.addColorStop(0.5, "rgba(139, 92, 246, 0.18)");
 liveBarGrad.addColorStop(1, "rgba(59, 130, 246, 0.16)");
 ctx.fillStyle = liveBarGrad;
 ctx.fillRect(0, 43, W, 34);

 if (autoDj.enabled) {
 const badgeTxt = document.getElementById("autoDjLiveBadge")?.textContent || "AUTO DJ PRO";
 const phaseTxt = document.getElementById("autoDjStatusText")?.textContent || "";
 const barCntTxt = document.getElementById("autoDjBarCounter")?.textContent || "BAR 1";
 const progWidthStr = document.getElementById("autoDjProgressBar")?.style?.width || "0%";
 const progRatio = Math.max(0, Math.min(1, (parseFloat(progWidthStr) || 0) / 100));

 fillRoundRectPath(ctx, 16, 49, 220, 22, 11);
 ctx.fillStyle = "#db2777";
 ctx.fill();
 ctx.fillStyle = "#ffffff";
 ctx.font = "800 10.5px 'Segoe UI', sans-serif";
 ctx.textAlign = "center";
 ctx.fillText(truncateCanvasText(ctx, badgeTxt, 206), 126, 64);

 ctx.textAlign = "left";
 ctx.fillStyle = "#fde047";
 ctx.font = "700 12px 'Segoe UI', sans-serif";
 ctx.fillText(truncateCanvasText(ctx, phaseTxt, 720), 248, 64);

 // Progress bar + Bar Counter
 fillRoundRectPath(ctx, W - 290, 55, 165, 10, 5);
 ctx.fillStyle = "#181b24";
 ctx.fill();
 if (progRatio > 0.01) {
 fillRoundRectPath(ctx, W - 290, 55, 165 * progRatio, 10, 5);
 const pg = ctx.createLinearGradient(W - 290, 0, W - 125, 0);
 pg.addColorStop(0, "#f97316");
 pg.addColorStop(0.5, "#ec4899");
 pg.addColorStop(1, "#3b82f6");
 ctx.fillStyle = pg;
 ctx.fill();
 }

 fillRoundRectPath(ctx, W - 114, 49, 98, 22, 5);
 ctx.fillStyle = "#14171f";
 ctx.fill();
 ctx.strokeStyle = "#2e3444";
 ctx.stroke();
 ctx.fillStyle = "#ffffff";
 ctx.font = "800 11px Consolas, monospace";
 ctx.textAlign = "center";
 ctx.fillText(barCntTxt, W - 65, 64);
 } else {
 ctx.textAlign = "left";
 ctx.fillStyle = "#d1d5db";
 ctx.font = "700 12px 'Segoe UI', sans-serif";
 const d1Title = engine.deck1.track?.title || "未選択";
 const d2Title = engine.deck2.track?.title || "未選択";
 ctx.fillText(
 truncateCanvasText(ctx, ` LIVE MIX | DECK 1: ${d1Title} ／ DECK 2: ${d2Title}`, W - 36),
 18,
 64
 );
 }

 // 4. Dual Waveform Section (y: 84..218)
 const drawWaveformCard = (deckId, deck, x, y, w, h, accent, accentSoft, zoomId, ovId) => {
 fillRoundRectPath(ctx, x, y, w, h, 8);
 ctx.fillStyle = "#07090d";
 ctx.fill();
 ctx.strokeStyle = deck.isPlaying ? accent : "#1e2430";
 ctx.lineWidth = deck.isPlaying ? 1.5 : 1;
 ctx.stroke();

 // Header text
 ctx.textAlign = "left";
 ctx.fillStyle = accent;
 ctx.font = "900 12px 'Segoe UI', sans-serif";
 ctx.fillText(`DECK ${deckId}`, x + 12, y + 20);

 const stateTxt = deck.isPlaying ? (deck.loopActive ? "LOOPING" : "PLAYING") : deck.buffer ? "CUE READY" : "EMPTY";
 fillRoundRectPath(ctx, x + 70, y + 7, 68, 17, 4);
 ctx.fillStyle = deck.isPlaying ? accent : "#1b202c";
 ctx.fill();
 ctx.fillStyle = "#ffffff";
 ctx.font = "800 9.5px 'Segoe UI', sans-serif";
 ctx.textAlign = "center";
 ctx.fillText(stateTxt, x + 104, y + 19);

 const titleStr = deck.track?.title || `Deck ${deckId} — 曲未選択`;
 ctx.textAlign = "left";
 ctx.fillStyle = "#f3f4f6";
 ctx.font = "700 12px 'Segoe UI', sans-serif";
 ctx.fillText(truncateCanvasText(ctx, titleStr, w - 295), x + 148, y + 20);

 const curBpm = deck.getCurrentBpm() || 0;
 const pitchPct = deck.baseBpm > 0 ? ((curBpm - deck.baseBpm) / deck.baseBpm) * 100 : 0;
 const sign = pitchPct >= 0 ? "+" : "";
 const timeTxt = `${formatTime(deck.playheadSec)} / ${formatTime(deck.duration || 0)} ${curBpm.toFixed(1)} BPM (${sign}${pitchPct.toFixed(1)}%)`;
 ctx.textAlign = "right";
 ctx.fillStyle = accentSoft;
 ctx.font = "700 11px Consolas, monospace";
 ctx.fillText(timeTxt, x + w - 12, y + 20);

 // Zoom Waveform Box
 const zwX = x + 10;
 const zwY = y + 28;
 const zwW = w - 20;
 const zwH = 68;
 ctx.fillStyle = "#040609";
 ctx.fillRect(zwX, zwY, zwW, zwH);

 const zoomDom = document.getElementById(zoomId);
 if (zoomDom && zoomDom.width > 0 && zoomDom.height > 0) {
 ctx.drawImage(zoomDom, zwX, zwY, zwW, zwH);
 }
 // Center white playhead bar
 ctx.fillStyle = "#ffffff";
 ctx.fillRect(zwX + zwW * 0.5 - 1, zwY, 2, zwH);
 ctx.strokeStyle = "#181e29";
 ctx.lineWidth = 1;
 ctx.strokeRect(zwX, zwY, zwW, zwH);

 // Overview Waveform Box
 const ovX = x + 10;
 const ovY = y + 102;
 const ovW = w - 20;
 const ovH = 22;
 ctx.fillStyle = "#05070b";
 ctx.fillRect(ovX, ovY, ovW, ovH);
 const ovDom = document.getElementById(ovId);
 if (ovDom && ovDom.width > 0 && ovDom.height > 0) {
 ctx.drawImage(ovDom, ovX, ovY, ovW, ovH);
 } else if (deck.duration > 0) {
 const px = ovX + (deck.playheadSec / deck.duration) * ovW;
 ctx.fillStyle = "#ffffff";
 ctx.fillRect(px - 1, ovY, 2, ovH);
 }
 ctx.strokeStyle = "#181e29";
 ctx.strokeRect(ovX, ovY, ovW, ovH);
 };

 drawWaveformCard(1, engine.deck1, 16, 84, 616, 134, "#f97316", "#fdba74", "zoomWave1", "overviewWave1");
 drawWaveformCard(2, engine.deck2, 648, 84, 616, 134, "#38bdf8", "#93c5fd", "zoomWave2", "overviewWave2");

 // 5. 3-Column DDJ-FLX4 Hardware Unit (y: 226..706)
 fillRoundRectPath(ctx, 16, 226, W - 32, 480, 12);
 ctx.fillStyle = "#12151e";
 ctx.fill();
 ctx.strokeStyle = "#252b3b";
 ctx.lineWidth = 1.5;
 ctx.stroke();

 const drawHardwareDeck = (deckId, deck, x, y, w, h, accent, padClass) => {
 fillRoundRectPath(ctx, x, y, w, h, 10);
 ctx.fillStyle = "#0d1017";
 ctx.fill();
 ctx.strokeStyle = "#1f2533";
 ctx.lineWidth = 1;
 ctx.stroke();

 // Top Deck Strip
 ctx.textAlign = "left";
 ctx.fillStyle = accent;
 ctx.font = "900 13px 'Segoe UI', sans-serif";
 ctx.fillText(`DECK ${deckId}`, x + 14, y + 24);

 // Key Lock & Loop pills
 fillRoundRectPath(ctx, x + 84, y + 9, 88, 20, 10);
 ctx.fillStyle = deck.keyLock ? "rgba(34, 197, 94, 0.22)" : "#171b24";
 ctx.fill();
 ctx.strokeStyle = deck.keyLock ? "#22c55e" : "#2b3242";
 ctx.stroke();
 ctx.fillStyle = deck.keyLock ? "#86efac" : "#9ca3af";
 ctx.font = "800 9.5px 'Segoe UI', sans-serif";
 ctx.textAlign = "center";
 ctx.fillText("MASTER TEMPO", x + 128, y + 22);

 fillRoundRectPath(ctx, x + 180, y + 9, 68, 20, 10);
 ctx.fillStyle = deck.loopActive ? "rgba(249, 115, 22, 0.28)" : "#171b24";
 ctx.fill();
 ctx.strokeStyle = deck.loopActive ? "#f97316" : "#2b3242";
 ctx.stroke();
 ctx.fillStyle = deck.loopActive ? "#fed7aa" : "#9ca3af";
 ctx.fillText(deck.loopActive ? "4B LOOP" : "LOOP OFF", x + 214, y + 22);

 const curBpm = deck.getCurrentBpm() || 0;
 ctx.textAlign = "right";
 ctx.fillStyle = "#ffffff";
 ctx.font = "900 14px Consolas, monospace";
 ctx.fillText(`${curBpm.toFixed(2)} BPM`, x + w - 14, y + 24);

 // Spinning Jog Wheel
 const jogCx = x + 188;
 const jogCy = y + 178;
 const jogR = 114;

 // Outer illuminated ring
 ctx.beginPath();
 ctx.arc(jogCx, jogCy, jogR + 5, 0, Math.PI * 2);
 ctx.strokeStyle = deck.isPlaying ? accent : "#252b3a";
 ctx.lineWidth = deck.isPlaying ? 3.5 : 2;
 ctx.stroke();

 // Brushed platter body
 const platGrad = ctx.createRadialGradient(jogCx, jogCy, 18, jogCx, jogCy, jogR);
 platGrad.addColorStop(0, "#1c212e");
 platGrad.addColorStop(0.75, "#11151f");
 platGrad.addColorStop(1, "#232a3b");
 ctx.beginPath();
 ctx.arc(jogCx, jogCy, jogR, 0, Math.PI * 2);
 ctx.fillStyle = platGrad;
 ctx.fill();

 // Concentric vinyl grooves
 ctx.strokeStyle = "rgba(255,255,255,0.05)";
 ctx.lineWidth = 1;
 for (let gr = 54; gr <= 102; gr += 12) {
 ctx.beginPath();
 ctx.arc(jogCx, jogCy, gr, 0, Math.PI * 2);
 ctx.stroke();
 }

 // Rotating position marker dot & spoke
 const rad = ((deck.platterAngle || 0) - 90) * (Math.PI / 180);
 const dotX = jogCx + Math.cos(rad) * (jogR - 18);
 const dotY = jogCy + Math.sin(rad) * (jogR - 18);
 ctx.beginPath();
 ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
 ctx.fillStyle = accent;
 ctx.fill();

 // Center On-Jog LCD
 ctx.beginPath();
 ctx.arc(jogCx, jogCy, 44, 0, Math.PI * 2);
 ctx.fillStyle = "#07090e";
 ctx.fill();
 ctx.strokeStyle = accent;
 ctx.lineWidth = 1.5;
 ctx.stroke();

 const mode = deck.jogLcdMode || "bpm";
 let topLabel = `DECK ${deckId}`;
 let mainText = deck.buffer ? curBpm.toFixed(1) : "EMPTY";
 let subText = formatShortTime(Math.floor(deck.playheadSec || 0));

 if (deck.buffer) {
 if (mode === "remain") {
 topLabel = "REMAIN";
 const remSec = Math.max(0, Math.floor((deck.duration || 0) - deck.playheadSec));
 mainText = `-${formatShortTime(remSec)}`;
 subText = `${curBpm.toFixed(1)} BPM`;
 } else if (mode === "bar") {
 topLabel = "PHRASE / BAR";
 const bb = typeof deck.getBarAndBeat === "function" ? deck.getBarAndBeat() : { displayStr: "1.1" };
 mainText = `BAR ${bb.displayStr}`;
 subText = `${curBpm.toFixed(1)} BPM`;
 } else if (mode === "loop") {
 topLabel = "LOOP BEATS";
 mainText = deck.loopActive ? `${deck.loopLengthBeats}B ON` : `${deck.loopLengthBeats}B OFF`;
 subText = `${curBpm.toFixed(1)} BPM`;
 } else {
 topLabel = "BPM";
 mainText = curBpm.toFixed(1);
 subText = formatShortTime(Math.floor(deck.playheadSec || 0));
 }
 }

 ctx.textAlign = "center";
 ctx.fillStyle = "#9ca3af";
 ctx.font = "800 8.5px 'Segoe UI', sans-serif";
 ctx.fillText(topLabel, jogCx, jogCy - 14);
 ctx.fillStyle = "#ffffff";
 ctx.font = "900 13px Consolas, monospace";
 ctx.fillText(mainText, jogCx, jogCy + 4);
 ctx.fillStyle = accent;
 ctx.font = "700 10px Consolas, monospace";
 ctx.fillText(subText, jogCx, jogCy + 20);

 // Vertical Tempo Slider (right side of Jog)
 const tsX = x + w - 58;
 const tsY = y + 72;
 const tsH = 206;
 fillRoundRectPath(ctx, tsX, tsY, 36, tsH, 6);
 ctx.fillStyle = "#141822";
 ctx.fill();
 ctx.strokeStyle = "#262d3d";
 ctx.lineWidth = 1;
 ctx.stroke();

 ctx.strokeStyle = "#374151";
 ctx.beginPath();
 ctx.moveTo(tsX + 18, tsY + 16);
 ctx.lineTo(tsX + 18, tsY + tsH - 16);
 ctx.stroke();

 // Center 0% tick
 ctx.strokeStyle = accent;
 ctx.beginPath();
 ctx.moveTo(tsX + 6, tsY + tsH * 0.5);
 ctx.lineTo(tsX + 30, tsY + tsH * 0.5);
 ctx.stroke();

 const tempoEl = document.getElementById(`tempoSlider${deckId}`);
 const tempoVal = tempoEl ? parseFloat(tempoEl.value) || 0 : 0; // -1 .. +1
 const knobY = tsY + 18 + ((tempoVal + 1) * 0.5) * (tsH - 36);
 fillRoundRectPath(ctx, tsX + 5, knobY - 7, 26, 14, 3);
 ctx.fillStyle = "#e5e7eb";
 ctx.fill();

 ctx.fillStyle = "#9ca3af";
 ctx.font = "800 8.5px 'Segoe UI', sans-serif";
 ctx.textAlign = "center";
 ctx.fillText("TEMPO", tsX + 18, tsY - 6);

 // Bottom Transport Buttons (CUE + PLAY/PAUSE)
 const transY = y + 344;
 // CUE circle
 ctx.beginPath();
 ctx.arc(x + 48, transY, 25, 0, Math.PI * 2);
 ctx.fillStyle = deck.isCuePreviewing ? "rgba(245, 158, 11, 0.45)" : "#171b24";
 ctx.fill();
 ctx.strokeStyle = "#f59e0b";
 ctx.lineWidth = 2;
 ctx.stroke();
 ctx.fillStyle = "#fbbf24";
 ctx.font = "900 11px 'Segoe UI', sans-serif";
 ctx.fillText("CUE", x + 48, transY + 4);

 // PLAY/PAUSE circle
 ctx.beginPath();
 ctx.arc(x + 48, transY + 64, 27, 0, Math.PI * 2);
 ctx.fillStyle = deck.isPlaying ? "rgba(34, 197, 94, 0.35)" : "#171b24";
 ctx.fill();
 ctx.strokeStyle = deck.isPlaying ? "#22c55e" : "#4b5563";
 ctx.lineWidth = 2.5;
 ctx.stroke();
 ctx.fillStyle = deck.isPlaying ? "#4ade80" : "#e5e7eb";
 ctx.font = "900 13px 'Segoe UI', sans-serif";
 ctx.fillText(deck.isPlaying ? "" : "▶", x + 48, transY + 69);

 // 8 Performance Pads (2 rows x 4 cols)
 const padsDom = document.querySelectorAll(`#padsGrid${deckId} .hw-pad`);
 const padStartX = x + 94;
 const padStartY = y + 318;
 const padW = 82;
 const padH = 54;
 const padGap = 8;

 for (let i = 0; i < 8; i++) {
 const col = i % 4;
 const row = Math.floor(i / 4);
 const px = padStartX + col * (padW + padGap);
 const py = padStartY + row * (padH + padGap);
 const domPad = padsDom[i];
 const isActive = domPad && (domPad.classList.contains("pad-active") || domPad.classList.contains("cue-loaded"));
 const titleTxt = domPad?.querySelector(".pad-title")?.textContent || String(i + 1);
 const subTxt = domPad?.querySelector(".pad-sub")?.textContent || "";

 fillRoundRectPath(ctx, px, py, padW, padH, 6);
 ctx.fillStyle = isActive ? (deckId === 1 ? "rgba(249, 115, 22, 0.42)" : "rgba(56, 189, 248, 0.42)") : "#161a24";
 ctx.fill();
 ctx.strokeStyle = isActive ? accent : "#2c3446";
 ctx.lineWidth = isActive ? 2 : 1;
 ctx.stroke();

 ctx.textAlign = "center";
 ctx.fillStyle = "#ffffff";
 ctx.font = "800 11px 'Segoe UI', sans-serif";
 ctx.fillText(truncateCanvasText(ctx, titleTxt, padW - 8), px + padW * 0.5, py + 23);
 if (subTxt) {
 ctx.fillStyle = accent;
 ctx.font = "700 9.5px Consolas, monospace";
 ctx.fillText(truncateCanvasText(ctx, subTxt, padW - 8), px + padW * 0.5, py + 40);
 }
 }
 };

 drawHardwareDeck(1, engine.deck1, 28, 238, 462, 456, "#f97316", "d1");
 drawHardwareDeck(2, engine.deck2, 790, 238, 462, 456, "#38bdf8", "d2");

 // 6. Center 2-Channel Mixer (x: 500..780, y: 238..694)
 const mxX = 500;
 const mxY = 238;
 const mxW = 280;
 const mxH = 456;

 fillRoundRectPath(ctx, mxX, mxY, mxW, mxH, 10);
 ctx.fillStyle = "#0b0e15";
 ctx.fill();
 ctx.strokeStyle = "#222938";
 ctx.lineWidth = 1;
 ctx.stroke();

 const drawRotaryKnob = (cx, cy, r, norm, ptrColor, label) => {
 ctx.beginPath();
 ctx.arc(cx, cy, r, 0, Math.PI * 2);
 ctx.fillStyle = "#181d29";
 ctx.fill();
 ctx.strokeStyle = "#333c52";
 ctx.lineWidth = 1.5;
 ctx.stroke();

 // Value arc (-135deg .. +135deg)
 const startAng = (-225 * Math.PI) / 180;
 const curAng = ((-225 + norm * 270) * Math.PI) / 180;
 ctx.beginPath();
 ctx.arc(cx, cy, r + 2.5, startAng, curAng, false);
 ctx.strokeStyle = ptrColor;
 ctx.lineWidth = 2;
 ctx.stroke();

 // Pointer needle
 const px = cx + Math.cos(curAng) * (r - 3);
 const py = cy + Math.sin(curAng) * (r - 3);
 ctx.beginPath();
 ctx.moveTo(cx, cy);
 ctx.lineTo(px, py);
 ctx.strokeStyle = "#ffffff";
 ctx.lineWidth = 2;
 ctx.stroke();

 ctx.textAlign = "center";
 ctx.fillStyle = "#9ca3af";
 ctx.font = "800 8.5px 'Segoe UI', sans-serif";
 ctx.fillText(label, cx, cy + r + 12);
 };

 ctx.textAlign = "center";
 ctx.fillStyle = "#f97316";
 ctx.font = "900 11px 'Segoe UI', sans-serif";
 ctx.fillText("CH 1", mxX + 62, mxY + 22);
 ctx.fillStyle = "#38bdf8";
 ctx.fillText("CH 2", mxX + mxW - 62, mxY + 22);

 const knobSpecs = [
 { lbl: "TRIM", k1: "knobTrim1", k2: "knobTrim2", def: 0.66 },
 { lbl: "HI", k1: "knobHi1", k2: "knobHi2", def: 0.81 },
 { lbl: "MID", k1: "knobMid1", k2: "knobMid2", def: 0.81 },
 { lbl: "LOW", k1: "knobLow1", k2: "knobLow2", def: 0.81 },
 { lbl: "COLOR FX", k1: "knobCfx1", k2: "knobCfx2", def: 0.5 }
 ];

 knobSpecs.forEach((ks, idx) => {
 const ky = mxY + 48 + idx * 50;
 drawRotaryKnob(mxX + 62, ky, 14, readKnobNorm(ks.k1, ks.def), "#f97316", ks.lbl);
 drawRotaryKnob(mxX + mxW - 62, ky, 14, readKnobNorm(ks.k2, ks.def), "#38bdf8", ks.lbl);
 });

 // Center Dual 8-Segment VU Meter
 const vuThresholds = [0.05, 0.14, 0.24, 0.36, 0.48, 0.62, 0.76, 0.90];
 const vu1 = engine.deck1.getVuLevel();
 const vu2 = engine.deck2.getVuLevel();
 const vuTopY = mxY + 42;
 for (let s = 0; s < 8; s++) {
 const segIdx = 7 - s;
 const sy = vuTopY + s * 26;
 const segColor = segIdx >= 7 ? "#ef4444" : segIdx >= 5 ? "#f59e0b" : "#22c55e";

 ctx.fillStyle = vu1 >= vuThresholds[segIdx] ? segColor : "#181d27";
 fillRoundRectPath(ctx, mxX + mxW * 0.5 - 14, sy, 10, 18, 2);
 ctx.fill();

 ctx.fillStyle = vu2 >= vuThresholds[segIdx] ? segColor : "#181d27";
 fillRoundRectPath(ctx, mxX + mxW * 0.5 + 4, sy, 10, 18, 2);
 ctx.fill();
 }

 // Channel Faders (CH1 & CH2)
 const drawChFader = (fx, fy, fh, val, color, lbl) => {
 fillRoundRectPath(ctx, fx - 14, fy, 28, fh, 5);
 ctx.fillStyle = "#141822";
 ctx.fill();
 ctx.strokeStyle = "#262d3d";
 ctx.lineWidth = 1;
 ctx.stroke();

 ctx.strokeStyle = "#374151";
 ctx.beginPath();
 ctx.moveTo(fx, fy + 10);
 ctx.lineTo(fx, fy + fh - 10);
 ctx.stroke();

 const capY = fy + 10 + (1 - Math.max(0, Math.min(1, val))) * (fh - 20);
 fillRoundRectPath(ctx, fx - 11, capY - 6, 22, 12, 3);
 ctx.fillStyle = color;
 ctx.fill();

 ctx.textAlign = "center";
 ctx.fillStyle = "#9ca3af";
 ctx.font = "800 9px 'Segoe UI', sans-serif";
 ctx.fillText(lbl, fx, fy + fh + 13);
 };

 const fader1Val = parseFloat(document.getElementById("chFader1")?.value ?? "0.94");
 const fader2Val = parseFloat(document.getElementById("chFader2")?.value ?? "0.94");
 drawChFader(mxX + 78, mxY + 298, 92, fader1Val, "#f97316", "CH 1");
 drawChFader(mxX + mxW - 78, mxY + 298, 92, fader2Val, "#38bdf8", "CH 2");

 // Crossfader at Bottom of Mixer
 const xfX = mxX + 34;
 const xfY = mxY + 416;
 const xfW = mxW - 68;
 fillRoundRectPath(ctx, xfX, xfY, xfW, 24, 6);
 ctx.fillStyle = "#141822";
 ctx.fill();
 ctx.strokeStyle = "#262d3d";
 ctx.stroke();

 ctx.strokeStyle = "#374151";
 ctx.beginPath();
 ctx.moveTo(xfX + 14, xfY + 12);
 ctx.lineTo(xfX + xfW - 14, xfY + 12);
 ctx.stroke();

 const xfVal = parseFloat(document.getElementById("crossfader")?.value ?? "0"); // -1 .. +1
 const xfCapX = xfX + 14 + ((xfVal + 1) * 0.5) * (xfW - 28);
 fillRoundRectPath(ctx, xfCapX - 9, xfY + 3, 18, 18, 3);
 ctx.fillStyle = "#f9fafb";
 ctx.fill();

 ctx.textAlign = "center";
 ctx.fillStyle = "#6b7280";
 ctx.font = "800 8.5px 'Segoe UI', sans-serif";
 ctx.fillText("CROSSFADER", mxX + mxW * 0.5, xfY - 4);
 }
})();
