/**
 * frigate-timeline-card
 *
 * Minimal Home Assistant Lovelace card: live camera view plus a horizontal
 * Frigate-style event timeline below it. The strip is layered the way
 * Frigate's own timeline reads: translucent bands mark where activity
 * happened — red where a person was, amber otherwise — and a white
 * histogram over them shows how much motion, drawn from the per-segment
 * motion scores. A live-updating "now" pill tracks the present. Click/drag
 * the timeline to play the nearest ~1min of recorded footage inline; a
 * "Live" button returns to the live stream.
 *
 * Live view uses `<ha-camera-stream>` bound to `camera_entity` — same
 * element, same setup, as the companion camera-gallery-card fork's
 * already-proven-working live view. Event/review data is scoped by
 * `frigate_camera` (Frigate's own camera name, not the HA entity), fetched
 * WebSocket-first through Home Assistant (`frigate/events/get`), same
 * priority order as that fork, with REST to `frigate_url` as a secondary
 * enhancement where REST happens to be reachable.
 *
 * Why everything goes through Home Assistant rather than straight to
 * Frigate's LAN address: this card originally tried exactly that (raw
 * `ws://<lan-ip>:1984/...` for live, REST-first for events) and it broke
 * outright the moment the dashboard itself is served over https (Tailscale,
 * Nabu Casa, any TLS reverse proxy — common, not an edge case), or simply
 * viewed from a phone that can reach Home Assistant but not Frigate's own
 * hostname. Browsers block the https case as mixed content with no visible
 * error, and CORS blocks every cross-origin REST call besides, since
 * Frigate sends no `Access-Control-Allow-Origin` and has no setting to.
 *
 * So nothing here talks to `frigate_url` from the browser by choice:
 *   - live: `<ha-camera-stream>`, or the Frigate integration's own MSE
 *     proxy (`/api/frigate/<instance>/mse/api/ws`) for `live_source:
 *     frigate`
 *   - events / reviews / recordings: `frigate/events/get`,
 *     `frigate/reviews/get`, `frigate/recordings/get` over HA's websocket
 *   - recorded clips: the integration's `/api/frigate/<instance>/recording/…`
 *     proxy, on an `auth/sign_path` signature
 * All of it is same-origin with the dashboard, so it works identically over
 * LAN http, Tailscale and Nabu Casa. Direct REST/go2rtc access to
 * `frigate_url` survives only as a fallback for setups without the Frigate
 * HA integration, where it carries every caveat above.
 *
 * All `<video>` elements run with `controls=false`; play/pause, mute, and
 * fullscreen live in a control bar below the stage, not as overlays.
 * Recorded-clip playback hands the browser a plain `video.src` — HLS
 * (`.m3u8`) on Safari via its native decoder, an MP4 range clip everywhere
 * else — the same technique the companion camera-gallery-card fork uses.
 * A resource load like that is never CORS-gated, unlike hls.js's own
 * XHR-based manifest/segment fetching, which most self-hosted Frigate
 * instances silently fail (no `Access-Control-Allow-Origin`, and Frigate
 * has no built-in setting for it). hls.js — still bundled directly into
 * this file, not loaded from a CDN — is kept only as a last-resort fallback
 * if the native `<video>` element itself errors out. One accepted
 * trade-off: native HLS playback on Safari/iOS/macOS shows its own
 * AirPlay/fullscreen chrome unconditionally, which an hls.js-fed
 * MediaSource element wouldn't — a working native player beats a silently
 * black one.
 *
 * No gallery, no thumbnails, no PTZ/talkback/zoom — deliberately narrow
 * scope so the card stays light.
 *
 * Config:
 *   type: custom:frigate-timeline-card
 *   camera_entity: camera.camera_spate      # required unless live_source: frigate — HA camera entity, for the ha-camera-stream live view
 *   frigate_url: http://192.168.1.11:5000   # required — Frigate's own address; only used as a fallback path when the Frigate HA integration isn't available (and as the default go2rtc host)
 *   frigate_camera: spate                   # required — Frigate's own camera name, for scoping events/review data
 *   frigate_instance_id: frigate            # optional — Frigate HA integration config-entry id, for the events WS call (default "frigate")
 *   height: 44                              # optional — timeline strip height in px
 *   show_motion: true                       # optional — draw the white motion histogram behind the activity bands (default true)
 *   pause_offscreen: true                   # optional — stop the live stream while the card is scrolled out of view or the app is in the background (default true)
 *   default_zoom_hours: 10                  # optional — initial timeline zoom window, in hours (default 10)
 *   auto_hide_seconds: 0                    # optional — auto-collapse the timeline after N seconds of no interaction (default 0 = disabled)
 *   live_source: ha                         # optional — "ha" (default, via ha-camera-stream) or "frigate" (go2rtc MSE through HA's Frigate proxy, bypassing HA's WebRTC bridge)
 *   go2rtc_url: http://192.168.1.11:1984    # optional — only used when live_source: frigate; forces a direct connection to a go2rtc that isn't the one Frigate bundles (skips HA's proxy, so mixed-content/reachability caveats come back)
 *   frigate_stream: auto                    # optional — only used when live_source: frigate; "auto" (default — sub stream unless the card is rendered wide enough to show more), "main" or "sub"
 */

const PLAYHEAD_TICK_MS = 60 * 1000;
/** How often the live watchdog samples playback progress. */
const WATCHDOG_MS = 5000;
/** Data still arriving but the playhead frozen this long — reconnect. */
const STALL_RECONNECT_MS = 10000;
/** Playhead this far behind the live edge is unrecoverable — reconnect. */
const MAX_LIVE_LAG_SEC = 60;
/** Minimum spacing between live-edge catch-up passes. */
const CATCH_UP_INTERVAL_MS = 1000;
/** Tallest a motion bar gets, as a percentage of the track's height. Kept
 * well short of full so the activity bands behind it stay readable. */
const MOTION_MAX_HEIGHT_PCT = 62;
/** How much footage one clip request covers, forward from the tap. */
const CLIP_WINDOW_SEC = 60;
/**
 * What we tell go2rtc we can play. It answers with one mime string pairing
 * a video codec with an audio one, and that pairing is not always something
 * the engine will actually accept — so the audio codecs are offered, and
 * dropped only if the engine rejects the answer (see the mse handler).
 *
 * `flac` is how go2rtc carries a camera's G.711 audio into fMP4, and these
 * cameras send PCMA. Offering it used to be unconditional, which left two
 * of three cameras black on WebKit: their video is H.265, go2rtc paired it
 * with flac, and Safari rejects `hvc1…,flac` outright. Dropping flac fixed
 * the black picture and silently removed the only route to audio those
 * cameras had. Chromium, for what it's worth, accepts every combination —
 * which is exactly why this can't be decided by a hard-coded list.
 */
const MSE_CODECS_WITH_AUDIO =
  "avc1.640029,avc1.64002A,avc1.640033,hvc1.1.6.L153.B0,mp4a.40.2,mp4a.40.5,opus,flac";
const MSE_CODECS_VIDEO_ONLY = "avc1.640029,avc1.64002A,avc1.640033,hvc1.1.6.L153.B0";
/** Rendered width, in device pixels, at which `frigate_stream: auto`
 * switches from the sub stream to the main one — the sub stream's own
 * width, below which main resolves detail the element cannot show. */
const AUTO_MAIN_MIN_DEVICE_PX = 1280;
/** How long a card stays streaming after it leaves the screen, so a scroll
 * straight past doesn't tear the stream down and rebuild it. */
const OFFSCREEN_GRACE_MS = 2500;
/** Room kept to the right of "now" so its pill sits inside the strip
 * rather than hanging off the end. In pixels, converted to time per zoom
 * level: a fixed number of minutes is a different amount of screen at
 * every zoom, which is what left the pill overflowing at a day's width. */
const NOW_RIGHT_MARGIN_PX = 48;
/** Frigate labels a person "person" and, once the second pass confirms it,
 * "person-verified". Both count, and the check is a substring rather than
 * an equality so a future qualifier doesn't silently stop matching. */
function hasPerson(labels) {
  return (labels || []).some((l) => String(l || "").toLowerCase().includes("person"));
}

// Minimal inline icon set (Material Design icon paths) — no emoji anywhere
// in the control bar, per design requirement. `currentColor` fill means
// each button's own text color (and CSS var overrides) apply automatically.
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
const ICON_VOLUME_UP =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
const ICON_VOLUME_OFF =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.8L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
const ICON_FULLSCREEN =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
const ICON_CHEVRON_UP =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z"/></svg>';
const ICON_CHEVRON_DOWN =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 16l6-6-1.41-1.41L12 13.17 7.41 8.59 6 10z"/></svg>';

// Romanian + English UI strings, auto-selected from HA's own configured
// locale (`hass.locale.language`, falling back to `hass.language`) — no
// config option, since the ask was automatic selection, not a manual
// override. Anything not in this dict (or arriving before `hass` is known)
// falls back to English.
const I18N = {
  ro: {
    prevDay: "Ziua anterioară",
    nextDay: "Ziua următoare",
    today: "Astăzi",
    toggleTimeline: "Ascunde/afișează timeline",
    playPause: "Redare/Pauză",
    muteUnmute: "Mut/Sunet",
    fullscreen: "Ecran complet",
    backToLive: "Revino la live",
    live: "Live",
    clipLoadError: "Nu s-a putut încărca clipul de la Frigate — verifică CORS (Access-Control-Allow-Origin) pe server.",
    liveFrigateError: "Live direct prin Frigate a eșuat (verifică go2rtc_url, sau CORS/mixed-content dacă dashboard-ul e pe https).",
    edHost: "Server Frigate (ex: 192.168.1.11)",
    edPort: "Port",
    edFrigateCamera: "Cameră în Frigate (ex: spate)",
    edFrigateCameraSelect: "Cameră în Frigate",
    edHeight: "Înălțime timeline (px)",
    edZoom: "Zoom implicit (ore)",
    edAutohide: "Auto-hide timeline (secunde de inactivitate, 0 = dezactivat)",
    edStream: "Stream",
  },
  en: {
    prevDay: "Previous day",
    nextDay: "Next day",
    today: "Today",
    toggleTimeline: "Hide/show timeline",
    playPause: "Play/Pause",
    muteUnmute: "Mute/Unmute",
    fullscreen: "Fullscreen",
    backToLive: "Back to live",
    live: "Live",
    clipLoadError: "Couldn't load the clip from Frigate — check CORS (Access-Control-Allow-Origin) on the server.",
    liveFrigateError: "Direct Frigate live failed (check go2rtc_url, or CORS/mixed-content if the dashboard is on https).",
    edHost: "Frigate server (e.g. 192.168.1.11)",
    edPort: "Port",
    edFrigateCamera: "Camera in Frigate (e.g. spate)",
    edFrigateCameraSelect: "Camera in Frigate",
    edHeight: "Timeline strip height (px)",
    edZoom: "Default zoom (hours)",
    edAutohide: "Auto-hide timeline (seconds of inactivity, 0 = disabled)",
    edStream: "Stream",
  },
};

function pickLang(hass) {
  const lang = String(hass?.locale?.language || hass?.language || "en").toLowerCase();
  return lang.startsWith("ro") ? "ro" : "en";
}

function translate(hass, key) {
  return I18N[pickLang(hass)]?.[key] ?? I18N.en[key] ?? key;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dayWindow(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return {
    start: new Date(y, m - 1, d).getTime(),
    end: new Date(y, m - 1, d + 1).getTime(),
  };
}

function shiftDayKey(dayKey, delta) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

class FrigateTimelineCard extends HTMLElement {
  constructor() {
    super();
    // Bound once so connectedCallback/disconnectedCallback can add and
    // remove the exact same references. They dispatch into whatever the
    // scrub wiring installed, which keeps that logic where it reads best
    // while still leaving one pair of listeners to detach.
    this._onVisibilityChange = () => this._updateLiveActivity();
    this._onWindowPointerMove = (e) => this._windowDragMove?.(e);
    this._onWindowPointerUp = () => this._windowDragStop?.();
  }

  _t(key) {
    return translate(this._hass, key);
  }

  /** Re-applies every translated label/title once `hass` (and its locale)
   * is actually known — `_build()` runs synchronously from `setConfig()`,
   * before `hass` ever arrives, so button titles/text created there start
   * out English-default and need a refresh the first time the real
   * language becomes available. */
  _applyI18n() {
    if (this._prevDayBtnEl) this._prevDayBtnEl.title = this._t("prevDay");
    if (this._nextDayBtnEl) this._nextDayBtnEl.title = this._t("nextDay");
    if (this._timelineToggleBtn) this._timelineToggleBtn.title = this._t("toggleTimeline");
    if (this._playBtnEl) this._playBtnEl.title = this._t("playPause");
    if (this._muteBtnEl) this._muteBtnEl.title = this._t("muteUnmute");
    if (this._fsBtnEl) this._fsBtnEl.title = this._t("fullscreen");
    if (this._liveBtnEl) {
      this._liveBtnEl.title = this._t("backToLive");
      const dot = this._liveBtnEl.querySelector(".ftc-live-dot");
      this._liveBtnEl.innerHTML = "";
      if (dot) this._liveBtnEl.appendChild(dot);
      else {
        const d = document.createElement("span");
        d.className = "ftc-live-dot";
        this._liveBtnEl.appendChild(d);
      }
      this._liveBtnEl.appendChild(document.createTextNode(this._t("live")));
    }
  }

  setConfig(config) {
    if (!config.frigate_url) {
      throw new Error("frigate-timeline-card: 'frigate_url' is required");
    }
    if (!config.frigate_camera) {
      throw new Error("frigate-timeline-card: 'frigate_camera' is required");
    }
    // camera_entity is only needed to drive <ha-camera-stream> — when
    // live_source is "frigate", live view connects straight to go2rtc
    // instead and never touches an HA camera entity at all.
    if (config.live_source !== "frigate" && !config.camera_entity) {
      throw new Error("frigate-timeline-card: 'camera_entity' is required (for live view via ha-camera-stream)");
    }
    this._config = { height: 44, frigate_instance_id: "frigate", default_zoom_hours: 10, auto_hide_seconds: 0, live_source: "ha", frigate_stream: "auto", show_motion: true, pause_offscreen: true, ...config };
    this._dayKey = todayKey();
    this._segments = [];
    this._events = [];
    this._recordings = [];
    this._fetchKey = null;
    this._recordingsKey = null;
    this._resetZoom();
    this._updateDayNavState();
    if (!this._built) this._build();
  }

  _defaultZoomHours() {
    const h = Number(this._config?.default_zoom_hours);
    return Number.isFinite(h) && h > 0 ? Math.min(24, h) : 10;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    // Language (from hass.locale) is also only known once hass arrives —
    // refresh the labels/titles built English-default during _build().
    if (first) this._applyI18n();
    // ha-camera-stream needs `hass`/`stateObj` for the live view, and the
    // events fallback needs `hass.connection` — both gated on its first
    // arrival, since `_build()` runs before `hass` exists at all.
    if (first && !this._playingClip) this._showLive();
    if (this._streamEl?.tagName === "HA-CAMERA-STREAM") {
      // Same "fires several times a second" hass churn as the comment below
      // describes — reassigning `.hass`/`.stateObj` on ha-camera-stream that
      // often was causing periodic stutter on live, even when nothing about
      // the camera itself had changed (most of those updates are unrelated
      // entities elsewhere on the dashboard). HA gives unchanged entities
      // the same `hass.states[id]` object reference across updates, so
      // comparing it is a reliable "did this camera's state actually
      // change" check — only touch the stream element when it did.
      const camStateObj = hass.states?.[this._config.camera_entity];
      if (camStateObj !== this._lastCamStateObj) {
        this._lastCamStateObj = camStateObj;
        this._streamEl.hass = hass;
        this._streamEl.stateObj = camStateObj;
      }
    }
    if (first) this._ensureData();
    // Deliberately nothing else here. Lovelace calls this setter on every
    // state-changed event across the whole dashboard, several times a
    // second, and this used to rebuild the strip's DOM on a 3-second
    // throttle off the back of it. That work was never needed: the strip's
    // data only changes when the day does, the clock is the pill's own
    // per-second job, and the window's slow drift is what the 60-second
    // tick is for. It cost three DOM rebuilds every three seconds, forever,
    // to redraw an identical picture — and rebuilding mid-gesture is what
    // caused the original tap-does-nothing bug on iOS.
  }

  static getConfigElement() {
    return document.createElement("frigate-timeline-card-editor");
  }

  static getStubConfig() {
    // `live_source` is set explicitly rather than left to the default: the
    // editor no longer offers the choice, and the Home Assistant camera
    // path it would otherwise fall into needs a `camera_entity` the editor
    // no longer asks for either. Both remain settable in YAML.
    return { frigate_url: "", frigate_camera: "", live_source: "frigate", height: 44 };
  }

  getCardSize() {
    return 6;
  }

  connectedCallback() {
    this._tickInterval = setInterval(() => this._renderTimeline(), PLAYHEAD_TICK_MS);
    // Cheap per-second tick — only moves/re-labels the now-pill, no bar
    // rebuild — so the clock reads live seconds like the reference UI.
    this._clockInterval = setInterval(() => this._updateNowPill(), 1000);
    document.addEventListener("visibilitychange", this._onVisibilityChange);
    // Scrolled out of sight is as good a reason to stop decoding as the
    // app being in the background. On a phone only one of these cards fits
    // on screen at a time, so without this a three-camera view decodes
    // three streams to show one — which on this setup is two 4K HEVC feeds
    // running for nothing.
    //
    // The margin starts the stream slightly before the card is actually
    // reached, so scrolling to it doesn't land on a frozen frame.
    if (this._config?.pause_offscreen !== false && "IntersectionObserver" in window) {
      this._viewObserver = new IntersectionObserver(
        (entries) => {
          const onScreen = entries.some((entry) => entry.isIntersecting);
          if (onScreen === this._onScreen) return;
          this._onScreen = onScreen;
          this._updateLiveActivity();
          if (onScreen && this._renderPending) this._renderTimeline();
        },
        { rootMargin: "250px 0px" }
      );
      this._viewObserver.observe(this);
    }
    // The auto stream choice depends on rendered size, and rendered size
    // isn't known at the first connect — the card may not be laid out yet,
    // and it changes again on fullscreen or a window resize. Re-check when
    // it moves, and only reconnect when the answer actually differs.
    if (this._config?.frigate_stream === "auto" && "ResizeObserver" in window) {
      this._sizeObserver = new ResizeObserver(() => {
        clearTimeout(this._sizeTimer);
        this._sizeTimer = setTimeout(() => {
          if (this._config?.live_source !== "frigate") return;
          if (this._playingClip || this._liveSuspended || !this._activeStreamSuffix) return;
          if (this._resolveStreamSuffix() === this._activeStreamSuffix) return;
          this._showLive();
        }, 600);
      });
      this._sizeObserver.observe(this);
    }
    // Drag tracking has to live on `window`, not the track: a pointer that
    // leaves the element mid-drag still has to be followed. Bound here
    // rather than in _build() so it can be unbound on disconnect — _build()
    // runs once per card, but a card can be detached and re-attached
    // (moving between views, a dashboard re-render) any number of times,
    // and each pass used to leave another permanent set behind on window.
    window.addEventListener("pointermove", this._onWindowPointerMove);
    window.addEventListener("pointerup", this._onWindowPointerUp);
    window.addEventListener("pointercancel", this._onWindowPointerUp);
    if (this._built && this._liveSuspended) this._updateLiveActivity();
    if (this._renderPending) this._renderTimeline();
  }

  disconnectedCallback() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    if (this._clockInterval) {
      clearInterval(this._clockInterval);
      this._clockInterval = null;
    }
    document.removeEventListener("visibilitychange", this._onVisibilityChange);
    this._viewObserver?.disconnect();
    this._viewObserver = null;
    this._sizeObserver?.disconnect();
    this._sizeObserver = null;
    clearTimeout(this._sizeTimer);
    if (this._suspendTimer) {
      clearTimeout(this._suspendTimer);
      this._suspendTimer = null;
    }
    window.removeEventListener("pointermove", this._onWindowPointerMove);
    window.removeEventListener("pointerup", this._onWindowPointerUp);
    window.removeEventListener("pointercancel", this._onWindowPointerUp);
    // Bumped before the teardown so the in-flight attempt's onclose reads
    // it as superseded rather than as a drop worth reconnecting.
    this._liveToken = (this._liveToken || 0) + 1;
    this._teardownWebRtc();
    this._teardownHls();
  }

  /**
   * Live streams stop while the dashboard is out of sight and start again
   * on return. On a phone that is three simultaneous decodes — 4K among
   * them — running on for as long as the screen is locked or another app
   * is in front, which is the single largest thing this card costs.
   *
   * It is also a correctness fix, not only a battery one. A backgrounded
   * page stops advancing playback but the socket keeps delivering, so the
   * buffer grows without bound and the playhead falls arbitrarily far
   * behind — the same wedged state the watchdog exists to catch, reached
   * by simply locking the phone. Nothing to catch up to if the stream was
   * never left running.
   */
  /**
   * Single decision point for whether this card should be streaming at all:
   * the page has to be in front, and the card has to be on screen.
   *
   * Stopping is delayed a couple of seconds, starting is not. Scrolling
   * past a card shouldn't tear its stream down and rebuild it in the time
   * it takes a thumb to swipe by, but arriving at one should show a picture
   * as soon as possible.
   */
  _updateLiveActivity() {
    const shouldStream = !document.hidden && this._onScreen !== false;
    if (shouldStream && this._renderPending) this._renderTimeline();
    if (this._suspendTimer) {
      clearTimeout(this._suspendTimer);
      this._suspendTimer = null;
    }
    if (shouldStream) {
      this._resumeLive();
      return;
    }
    this._suspendTimer = setTimeout(() => {
      this._suspendTimer = null;
      this._suspendLive();
    }, OFFSCREEN_GRACE_MS);
  }

  _suspendLive() {
    if (this._liveSuspended || this._playingClip || !this._built) return;
    this._liveSuspended = true;
    this._liveToken = (this._liveToken || 0) + 1;
    this._teardownWebRtc();
    this._teardownHls();
    // The go2rtc path leaves its <video> in place, so the last decoded
    // frame stays on screen instead of a black card. <ha-camera-stream>
    // has no equivalent — it keeps streaming until it is removed.
    if (this._config?.live_source !== "frigate") {
      this._stageEl.innerHTML = "";
      this._streamEl = null;
    }
  }

  _resumeLive() {
    if (!this._liveSuspended) return;
    this._liveSuspended = false;
    if (this._playingClip) return; // a clip is on screen; live isn't wanted
    this._showLive();
  }

  _teardownHls() {
    if (this._hls) {
      try {
        this._hls.destroy();
      } catch (_) {
        /* already gone */
      }
      this._hls = null;
    }
  }

  /** Overlays a short message on the stage — used when clip playback fails
   * outright (e.g. Frigate unreachable, or blocked by CORS with no viable
   * fallback) so it reads as "broken" instead of silently staying black. */
  _showStageError(msg) {
    this._clearStageError();
    const el = document.createElement("div");
    el.className = "ftc-stage-error";
    el.textContent = msg;
    this._stageEl.appendChild(el);
  }

  _clearStageError() {
    this._stageEl?.querySelector(".ftc-stage-error")?.remove();
  }

  _cameraObjectId() {
    return this._config.frigate_camera;
  }

  _build() {
    this._built = true;
    this.innerHTML = `
      <ha-card>
        <div class="ftc-stage"></div>
        <div class="ftc-toolbar">
          <div class="ftc-daynav">
            <button class="ftc-navbtn" data-dir="-1" title="Previous day">‹</button>
            <span class="ftc-daylabel"></span>
            <button class="ftc-navbtn" data-dir="1" title="Next day">›</button>
          </div>
          <div class="ftc-controlbar"></div>
        </div>
        <div class="ftc-timeline">
          <div class="ftc-trackwrap">
            <div class="ftc-now-pill"></div>
            <div class="ftc-now-line"></div>
            <div class="ftc-track"></div>
          </div>
          <div class="ftc-ticks"></div>
        </div>
      </ha-card>
      <style>
        frigate-timeline-card ha-card { overflow: hidden; padding: 0; }
        frigate-timeline-card .ftc-stage {
          position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000;
        }
        frigate-timeline-card .ftc-stage ha-camera-stream,
        frigate-timeline-card .ftc-stage video {
          width: 100%; height: 100%; display: block; object-fit: contain; background: #000;
        }
        frigate-timeline-card .ftc-toolbar {
          display: flex; align-items: center; justify-content: space-between; gap: 8px;
          padding: 6px 8px; background: transparent;
        }
        frigate-timeline-card .ftc-controlbar { display: flex; align-items: center; gap: 2px; }
        frigate-timeline-card .ftc-ctlbtn {
          display: flex; align-items: center; justify-content: center;
          background: transparent; border: none; color: var(--primary-text-color, #fff);
          line-height: 1; cursor: pointer; padding: 6px 8px; border-radius: 6px;
        }
        frigate-timeline-card .ftc-ctlbtn:hover { background: rgba(127, 127, 127, 0.2); }
        frigate-timeline-card .ftc-live-btn {
          display: flex; align-items: center; gap: 5px;
          font-size: 11px; font-weight: 700; letter-spacing: 0.03em; opacity: 0.4;
          text-transform: uppercase; padding: 6px 10px;
        }
        frigate-timeline-card .ftc-live-btn.active,
        frigate-timeline-card .ftc-live-btn.on-live { opacity: 1; }
        frigate-timeline-card .ftc-live-dot {
          width: 8px; height: 8px; border-radius: 50%; background: #ef4444; flex: none;
        }
        frigate-timeline-card .ftc-live-btn.on-live .ftc-live-dot {
          animation: ftc-live-breathe 1.8s ease-in-out infinite;
        }
        @keyframes ftc-live-breathe {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.8); }
        }
        frigate-timeline-card .ftc-ctlbtn.ftc-hidden { display: none; }
        frigate-timeline-card .ftc-daynav {
          display: flex; align-items: center; gap: 6px;
          font-size: 13px; color: var(--primary-text-color, #fff);
        }
        frigate-timeline-card .ftc-daylabel { padding: 0 4px; min-width: 60px; text-align: center; }
        frigate-timeline-card .ftc-navbtn {
          background: none; border: none; color: inherit; font-size: 16px; line-height: 1;
          cursor: pointer; padding: 3px 9px; border-radius: 6px;
        }
        frigate-timeline-card .ftc-navbtn:hover { background: rgba(127, 127, 127, 0.15); }
        frigate-timeline-card .ftc-navbtn:disabled {
          opacity: 0.3; cursor: default; pointer-events: none;
        }
        /* Even left and right, so the strip sits square in the card. The
           room the now-pill needs is made in the *window* instead — see
           NOW_RIGHT_MARGIN_PX — which keeps it clear of the edge at every
           zoom level, where the old lopsided padding only worked at some. */
        frigate-timeline-card .ftc-timeline { padding: 22px 10px 8px 10px; }
        frigate-timeline-card .ftc-trackwrap { position: relative; }
        frigate-timeline-card .ftc-track {
          position: relative; border-radius: 6px; overflow: hidden; cursor: pointer;
          background: #141414; touch-action: none;
        }
        frigate-timeline-card .ftc-band {
          position: absolute; top: 0; bottom: 0; pointer-events: none;
        }
        frigate-timeline-card .ftc-band.plain {
          background: var(--frigate-timeline-detect, rgba(242, 182, 50, 0.34));
        }
        frigate-timeline-card .ftc-band.person {
          background: var(--frigate-timeline-alert, rgba(239, 68, 68, 0.55));
        }
        frigate-timeline-card .ftc-bands { position: absolute; inset: 0; }
        frigate-timeline-card .ftc-motion {
          position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;
        }
        frigate-timeline-card .ftc-now-pill {
          position: absolute; top: -22px; transform: translateX(-50%);
          background: #c0392b; color: #fff; font-size: 11px; font-weight: 700;
          padding: 3px 9px; border-radius: 12px; white-space: nowrap;
          box-shadow: 0 2px 5px rgba(0, 0, 0, 0.4); pointer-events: none; z-index: 4;
        }
        frigate-timeline-card .ftc-now-pill.clip { background: #2f8fc0; }
        frigate-timeline-card .ftc-now-line {
          position: absolute; top: -8px; bottom: 0; width: 20px;
          transform: translateX(-50%); pointer-events: auto; z-index: 3;
          cursor: ew-resize; touch-action: none;
        }
        frigate-timeline-card .ftc-now-line::after {
          content: ""; position: absolute; top: 0; bottom: 0; left: 50%;
          border-left: 1px dashed rgba(255, 255, 255, 0.5); transform: translateX(-50%);
        }
        frigate-timeline-card .ftc-now-line.clip::after { border-left-color: rgba(79, 195, 247, 0.7); }
        frigate-timeline-card .ftc-now-line.scrubbing::after { border-left-color: #4fc3f7; border-left-width: 2px; }
        frigate-timeline-card .ftc-scrub {
          position: absolute; top: 0; bottom: 0; width: 2px; background: #4fc3f7;
          box-shadow: 0 0 6px rgba(79, 195, 247, 0.9); pointer-events: none;
        }
        frigate-timeline-card .ftc-ticks {
          position: relative; height: 16px; font-size: 10px;
          color: var(--secondary-text-color, #999); margin-top: 2px;
        }
        frigate-timeline-card .ftc-tick { position: absolute; transform: translateX(-50%); white-space: nowrap; }
        frigate-timeline-card .ftc-stage-error {
          position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
          text-align: center; padding: 16px; color: #f2b632; font-size: 13px; line-height: 1.4;
          background: rgba(0, 0, 0, 0.55); pointer-events: none; z-index: 5;
        }
      </style>
    `;
    this._stageEl = this.querySelector(".ftc-stage");
    this._timelineEl = this.querySelector(".ftc-timeline");
    this._trackEl = this.querySelector(".ftc-track");
    this._ticksEl = this.querySelector(".ftc-ticks");
    this._dayLabelEl = this.querySelector(".ftc-daylabel");
    this._nowPillEl = this.querySelector(".ftc-now-pill");
    this._nowLineEl = this.querySelector(".ftc-now-line");
    this._trackEl.style.height = `${this._config.height}px`;
    this._buildControlBar();
    this._wireTrackInteraction();
    this._wireNowLineScrub();
    this._wireAutoHide();
    this._prevDayBtnEl = this.querySelector('.ftc-navbtn[data-dir="-1"]');
    this._nextDayBtnEl = this.querySelector('.ftc-navbtn[data-dir="1"]');
    // `[data-dir]` is load-bearing, not decoration. The timeline's
    // collapse chevron is styled as a `.ftc-navbtn` too and is appended to
    // this same row by _buildControlBar(), which runs just above — so a
    // bare `.ftc-navbtn` selector picked it up and gave it the day-shift
    // handler on top of its own. `Number(undefined)` is NaN, which walks
    // straight through shiftDayKey into `new Date(y, m - 1, NaN)` and comes
    // back out as the string "NaN-NaN-NaN". Every tap on the chevron then
    // refetched with `after=NaN&before=NaN`, which Home Assistant rejects
    // and Frigate never sees, leaving the timeline blank until the day
    // changed.
    this.querySelectorAll(".ftc-navbtn[data-dir]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._dayKey = shiftDayKey(this._dayKey, Number(btn.dataset.dir));
        this._resetZoom();
        this._ensureData();
        this._updateDayNavState();
      });
    });
    this._updateDayNavState();
    this._applyI18n();
    this._showLive();
  }

  /** Disables "next day" once the viewed day reaches today — there's never
   * any future data, so stepping past today would just show an empty day. */
  _updateDayNavState() {
    if (this._nextDayBtnEl) this._nextDayBtnEl.disabled = this._dayKey >= todayKey();
  }

  // ─── Zoom / pan ──────────────────────────────────────────────────────

  /** `NOW_RIGHT_MARGIN_PX` worth of time at the current zoom. */
  _nowMarginMs(spanMs) {
    const width = Math.round(this._trackEl?.clientWidth) || 300;
    return (spanMs / width) * NOW_RIGHT_MARGIN_PX;
  }

  _currentWindow() {
    const day = dayWindow(this._dayKey);
    if (!day) return { start: 0, end: 1 };
    // Today stops just past now rather than running on to midnight — that
    // stretch is always empty. The margin is only what the pill needs to
    // sit clear of the edge. Zoom/pan/reset all funnel through here, so it
    // holds everywhere, not just on load.
    // The margin is measured against the span actually on screen. Fully
    // zoomed out early in the day that is a few hours, not twenty-four —
    // sizing it off the nominal day would reserve hours of empty strip.
    const referenceSpan =
      this._windowHours && this._windowHours < 24
        ? this._windowHours * 3600000
        : Math.max(3600000, Math.min(day.end, Date.now()) - day.start);
    const dayEnd =
      this._dayKey === todayKey() ? Math.min(day.end, Date.now() + this._nowMarginMs(referenceSpan)) : day.end;
    if (!this._windowHours || this._windowHours >= 24) return { start: day.start, end: dayEnd };
    const half = (this._windowHours * 3600000) / 2;
    const center = this._centerMs ?? day.start + (dayEnd - day.start) / 2;
    let start = center - half;
    let end = center + half;
    if (start < day.start) {
      end += day.start - start;
      start = day.start;
    }
    if (end > dayEnd) {
      start -= end - dayEnd;
      end = dayEnd;
    }
    start = Math.max(start, day.start);
    end = Math.min(end, dayEnd);
    return { start, end };
  }

  _applyZoom(hours, centerMs) {
    const day = dayWindow(this._dayKey);
    const MIN_HOURS = 0.25; // 15 minutes — enough precision to place a click within a few seconds
    this._windowHours = Math.min(24, Math.max(MIN_HOURS, hours));
    this._centerMs = Math.min(day.end, Math.max(day.start, centerMs));
    this._updateZoomLabel();
    this._renderTimeline();
  }

  /** Resets to the configured default zoom window (10h unless overridden).
   * "Now" (or the tail end of the day, when browsing a past day) sits just
   * in from the window's right edge rather than centred, so the strip reads
   * mostly as "what just happened". Called on load, on a day change, and on
   * an explicit Live press. */
  _resetZoom() {
    this._windowHours = this._defaultZoomHours();
    this._recenterToNow();
  }

  /** Repositions `_centerMs` so "now" (or the tail end of the day, on a
   * past day) sits 10 minutes in from the window's right edge, at
   * whatever `_windowHours` is currently set to — recentering without
   * touching zoom. Used by `_resetZoom()` (which also resets the zoom
   * level) and by `_showLive()` on an explicit Live press (jumping
   * back to live shouldn't discard a zoom level the user picked). */
  _recenterToNow() {
    const day = dayWindow(this._dayKey);
    const spanMs = (this._windowHours || this._defaultZoomHours()) * 3600000;
    const halfMs = spanMs / 2;
    const anchorMs = Math.min(Date.now(), day.end);
    this._centerMs = anchorMs + this._nowMarginMs(spanMs) - halfMs;
    this._updateZoomLabel();
    this._renderTimeline();
  }

  _updateZoomLabel() {
    if (!this._zoomLabelEl) return;
    const h = this._windowHours || 24;
    this._zoomLabelEl.textContent = h >= 24 ? "24h" : h >= 1 ? `${h % 1 === 0 ? h : h.toFixed(1)}h` : `${Math.round(h * 60)}m`;
  }

  /** Snaps a raw timestamp to the closest event's start time, if any events
   * are loaded — used by the now-line scrub gesture so dragging lands on
   * something that actually happened instead of an arbitrary empty moment.
   * Falls back to the raw timestamp when there are no events at all. */
  /** Press-and-hold the dashed "now" guideline to scrub — a dedicated grab
   * handle, distinct from tapping elsewhere on the track (single seek) or
   * dragging the track itself (pans the view once zoomed in). Lives on a
   * separate DOM node from `_trackEl` (a sibling in `.ftc-trackwrap`, not a
   * child), so its listeners never conflict with `_wireTrackInteraction`'s.
   *
   * Continuously previews the dragged position (pill + line follow the
   * pointer every frame), but throttles the actual `_playAt()` reload —
   * every pixel would tear down and recreate the whole video/hls
   * attachment, which is far too expensive to do per pointermove. */
  _wireNowLineScrub() {
    if (!this._nowLineEl) return;
    const SCRUB_THROTTLE_MS = 350;
    let dragging = false;
    let throttleTimer = null;
    let lastTs = null;

    const fracFromClientX = (x) => {
      const rect = this._trackEl.getBoundingClientRect();
      if (!rect.width || x == null) return null;
      return Math.min(1, Math.max(0, (x - rect.left) / rect.width));
    };
    const fracFromEvent = (e) => fracFromClientX(e.clientX ?? e.touches?.[0]?.clientX);

    // Dragging the selector to either end scrolls the window that way, so
    // a zoomed-in strip can be scrubbed past its own edges instead of
    // stopping at them. Framerate-driven rather than pointer-driven: once
    // the finger is parked in the edge zone it stops producing move events,
    // and the scroll has to keep going on its own.
    let autoPan = null;
    let lastClientX = null;
    const EDGE_ZONE_PX = 40;
    // Deliberately a pixel rate, not a time rate: the strip should scroll
    // at the same visible speed whether it's showing an hour or a day.
    // ~180px/s — a third of a typical strip per second, fast enough to get
    // somewhere and slow enough to stop where you meant to.
    const MAX_PAN_PX_PER_FRAME = 3;
    const stopAutoPan = () => {
      if (autoPan == null) return;
      cancelAnimationFrame(autoPan);
      autoPan = null;
    };
    const stepAutoPan = () => {
      autoPan = null;
      if (!dragging) return;
      const rect = this._trackEl.getBoundingClientRect();
      // Panning a full-day view means nothing — there is nothing either
      // side of it to scroll to.
      if (rect.width && lastClientX != null && (this._windowHours || 24) < 24) {
        let push = 0;
        if (lastClientX < rect.left + EDGE_ZONE_PX) push = (lastClientX - (rect.left + EDGE_ZONE_PX)) / EDGE_ZONE_PX;
        else if (lastClientX > rect.right - EDGE_ZONE_PX) push = (lastClientX - (rect.right - EDGE_ZONE_PX)) / EDGE_ZONE_PX;
        if (push) {
          // Past the edge entirely counts as a full push, not more — a
          // finger dragged off the card shouldn't fling the day past.
          push = Math.max(-1, Math.min(1, push));
          const win = this._currentWindow();
          const day = dayWindow(this._dayKey);
          const msPerPx = (win.end - win.start) / rect.width;
          const center = this._centerMs ?? win.start + (win.end - win.start) / 2;
          this._centerMs = Math.min(day.end, Math.max(day.start, center + push * MAX_PAN_PX_PER_FRAME * msPerPx));
          this._renderTimeline();
          // The window moved under a stationary finger, so the same point
          // on screen is a different moment now.
          const frac = fracFromClientX(lastClientX);
          if (frac != null) scheduleSeek(previewAt(frac));
        }
      }
      autoPan = requestAnimationFrame(stepAutoPan);
    };

    const previewAt = (frac) => {
      const win = this._currentWindow();
      // The preview follows the pointer freely; only the load that lands
      // at the end of the drag is pulled onto real footage, the same way a
      // tap is. Constraining the preview itself would make the line stick
      // and jump under the finger.
      const ts = win.start + frac * (win.end - win.start);
      const pct = frac * 100;
      this._nowLineEl.style.display = "";
      this._nowPillEl.style.display = "";
      this._nowLineEl.style.left = `${pct}%`;
      this._nowPillEl.style.left = `${pct}%`;
      this._nowPillEl.textContent = this._formatClock(new Date(ts));
      return ts;
    };

    const scheduleSeek = (ts) => {
      lastTs = ts;
      if (throttleTimer) return;
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        if (lastTs != null) this._playAt(this._nearestPlayableMs(lastTs));
      }, SCRUB_THROTTLE_MS);
    };

    this._nowLineEl.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      dragging = true;
      this._scrubbing = true;
      this._nowLineEl.classList.add("scrubbing");
      lastClientX = e.clientX ?? null;
      const frac = fracFromEvent(e);
      if (frac != null) scheduleSeek(previewAt(frac));
      stopAutoPan();
      autoPan = requestAnimationFrame(stepAutoPan);
    });
    this._windowDragMove = (e) => {
      if (!dragging) return;
      lastClientX = e.clientX ?? e.touches?.[0]?.clientX ?? lastClientX;
      const frac = fracFromEvent(e);
      if (frac == null) return;
      scheduleSeek(previewAt(frac));
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      stopAutoPan();
      lastClientX = null;
      this._scrubbing = false;
      this._nowLineEl.classList.remove("scrubbing");
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      if (lastTs != null) this._playAt(this._nearestPlayableMs(lastTs));
    };
    this._windowDragStop = stop;
  }

  _wireTrackInteraction() {
    // Deliberately NOT using setPointerCapture: `_renderTimeline()` replaces
    // this element's children (`innerHTML`) on every `hass` update, which in
    // WebKit/Safari cancels an in-progress pointer capture mid-gesture — the
    // exact reason taps silently did nothing on iOS/iPadOS. `click` is a
    // higher-level synthesized event that always fires for a genuine tap
    // regardless of capture state, so it's the reliable seek trigger.
    //
    // Single-finger/mouse drag serves double duty: a plain tap (no
    // meaningful movement) seeks via the `click` handler below; a drag past
    // a small threshold pans the visible window instead — but only once
    // zoomed in (panning a full 24h view doesn't mean anything). A pan sets
    // a flag so the trailing `click` doesn't also fire a seek.
    let dragging = false;
    let panned = false;
    let startX = 0;
    let startCenterMs = 0;
    const fracFromEvent = (e) => {
      const rect = this._trackEl.getBoundingClientRect();
      if (!rect.width) return null;
      const x = e.clientX ?? e.touches?.[0]?.clientX;
      if (x == null) return null;
      return Math.min(1, Math.max(0, (x - rect.left) / rect.width));
    };
    const showScrub = (frac) => {
      let el = this._trackEl.querySelector(".ftc-scrub");
      if (!el) {
        el = document.createElement("div");
        el.className = "ftc-scrub";
        this._trackEl.appendChild(el);
      }
      el.style.left = `${frac * 100}%`;
    };
    const clearScrub = () => {
      this._trackEl.querySelector(".ftc-scrub")?.remove();
    };

    this._trackEl.addEventListener("pointerdown", (e) => {
      if (this._pinchActive) return;
      dragging = true;
      panned = false;
      startX = e.clientX;
      const win = this._currentWindow();
      startCenterMs = this._centerMs ?? win.start + (win.end - win.start) / 2;
      const frac = fracFromEvent(e);
      if (frac != null) showScrub(frac);
    });
    this._trackEl.addEventListener("pointermove", (e) => {
      if (!dragging || this._pinchActive) return;
      const dx = e.clientX - startX;
      if (!panned && Math.abs(dx) > 6 && (this._windowHours || 24) < 24) {
        panned = true;
        clearScrub();
      }
      if (panned) {
        const rect = this._trackEl.getBoundingClientRect();
        if (!rect.width) return;
        const win = this._currentWindow();
        const msPerPx = (win.end - win.start) / rect.width;
        this._centerMs = startCenterMs - dx * msPerPx;
        this._renderTimeline();
        return;
      }
      const frac = fracFromEvent(e);
      if (frac != null) showScrub(frac);
    });
    const stopDrag = () => {
      dragging = false;
      clearScrub();
      if (panned) this._suppressNextClick = true;
    };
    this._trackEl.addEventListener("pointerup", stopDrag);
    this._trackEl.addEventListener("pointercancel", stopDrag);
    this._trackEl.addEventListener("click", (e) => {
      if (this._suppressNextClick) {
        this._suppressNextClick = false;
        return;
      }
      const frac = fracFromEvent(e);
      if (frac != null) this._seekTo(frac);
    });

    // Desktop zoom: mouse wheel, centered on the cursor position.
    this._trackEl.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = this._trackEl.getBoundingClientRect();
        if (!rect.width) return;
        const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const win = this._currentWindow();
        const atMs = win.start + frac * (win.end - win.start);
        const factor = e.deltaY < 0 ? 1 / 1.4 : 1.4; // scroll up = zoom in
        this._applyZoom((this._windowHours || 24) * factor, atMs);
      },
      { passive: false }
    );

    // Mobile zoom: two-finger pinch, centered on the pinch midpoint.
    const touchDist = (touches) =>
      Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    let pinchStartDist = null;
    let pinchStartHours = null;
    let pinchCenterMs = null;
    this._trackEl.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) {
          e.preventDefault();
          this._pinchActive = true;
          dragging = false;
          clearScrub();
          pinchStartDist = touchDist(e.touches);
          pinchStartHours = this._windowHours || 24;
          const rect = this._trackEl.getBoundingClientRect();
          const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
          const frac = Math.min(1, Math.max(0, (midX - rect.left) / rect.width));
          const win = this._currentWindow();
          pinchCenterMs = win.start + frac * (win.end - win.start);
        }
      },
      { passive: false }
    );
    this._trackEl.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length === 2 && pinchStartDist) {
          e.preventDefault();
          const dist = touchDist(e.touches);
          const ratio = pinchStartDist / Math.max(dist, 1);
          this._applyZoom(pinchStartHours * ratio, pinchCenterMs);
        }
      },
      { passive: false }
    );
    this._trackEl.addEventListener("touchend", (e) => {
      if (e.touches.length < 2) {
        pinchStartDist = null;
        this._pinchActive = false;
      }
    });
  }

  _teardownWebRtc() {
    if (this._rtcWebSocket) {
      try {
        this._rtcWebSocket.close();
      } catch (_) {
        /* already closed */
      }
      this._rtcWebSocket = null;
    }
  }

  /**
   * Wires the current `<video>` (live or clip) to the shared control bar
   * created once in `_build()`, and to tap-to-toggle on the video itself.
   * Never `video.controls = true` — that's the browser's native chrome
   * (AVKit-styled on Safari/iOS), exactly what this card avoids. All
   * controls live in `.ftc-controlbar` below the stage, not as overlays on
   * top of the picture.
   */
  _bindVideoControls(video) {
    this._videoEl = video;
    if (this._playBtnEl) this._playBtnEl.classList.remove("ftc-hidden"); // clip mode — play/pause is meaningful here
    video.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    const syncPlay = () => {
      if (this._playBtnEl) this._playBtnEl.innerHTML = video.paused ? ICON_PLAY : ICON_PAUSE;
    };
    const syncMute = () => {
      if (this._muteBtnEl) this._muteBtnEl.innerHTML = video.muted ? ICON_VOLUME_OFF : ICON_VOLUME_UP;
    };
    video.addEventListener("play", syncPlay);
    video.addEventListener("pause", syncPlay);
    video.addEventListener("volumechange", syncMute);
    syncPlay();
    syncMute();
    if (this._liveBtnEl) {
      this._liveBtnEl.classList.toggle("active", this._pillMode !== "live");
      this._liveBtnEl.classList.toggle("on-live", false);
    }
  }

  /** Recursively finds a `<video>` element inside `node`, descending into
   * open shadow roots as needed — `ha-camera-stream` renders its actual
   * `<video>` two custom-element layers deep (`ha-camera-stream` →
   * `ha-hls-player`/`ha-web-rtc-player` → `<video>`), each in its own
   * shadow root, so a plain `querySelector('video')` can't reach it (that
   * doesn't cross shadow boundaries). Needed for iOS Safari fullscreen,
   * which only works via a real `<video>` element's own
   * `webkitEnterFullscreen()` — the generic Fullscreen API is unreliable
   * there for arbitrary elements. */
  _findVideoDeep(node, depth = 4) {
    if (!node || depth < 0) return null;
    if (node instanceof HTMLVideoElement) return node;
    const root = node.shadowRoot || node;
    if (!root.querySelectorAll) return null;
    for (const el of root.querySelectorAll("*")) {
      if (el instanceof HTMLVideoElement) return el;
      if (el.shadowRoot) {
        const found = this._findVideoDeep(el, depth - 1);
        if (found) return found;
      }
    }
    return null;
  }

  /** Builds the shared control bar once — play/pause, mute, fullscreen,
   * and "back to live" — wired generically against `this._videoEl`, so the
   * same buttons keep working across live ↔ clip swaps without rebuilding. */
  _buildControlBar() {
    const bar = this.querySelector(".ftc-controlbar");
    const playBtn = document.createElement("button");
    playBtn.className = "ftc-ctlbtn";
    playBtn.innerHTML = ICON_PLAY;
    playBtn.title = this._t("playPause");
    playBtn.addEventListener("click", () => {
      if (!this._videoEl) return;
      if (this._videoEl.paused) this._videoEl.play().catch(() => {});
      else this._videoEl.pause();
    });

    const muteBtn = document.createElement("button");
    muteBtn.className = "ftc-ctlbtn";
    muteBtn.innerHTML = ICON_VOLUME_OFF;
    muteBtn.title = this._t("muteUnmute");
    muteBtn.addEventListener("click", () => {
      // Clip mode: this._videoEl is a plain <video>. Live mode: it's null
      // (ha-camera-stream isn't a <video>) — toggle the stream element's
      // own public `.muted` property instead.
      const target = this._videoEl || this._streamEl;
      if (!target) return;
      target.muted = !target.muted;
      muteBtn.innerHTML = target.muted ? ICON_VOLUME_OFF : ICON_VOLUME_UP;
    });

    const fsBtn = document.createElement("button");
    fsBtn.className = "ftc-ctlbtn";
    fsBtn.innerHTML = ICON_FULLSCREEN;
    fsBtn.title = this._t("fullscreen");
    fsBtn.addEventListener("click", () => {
      const doc = document;
      const isFs = doc.fullscreenElement || doc.webkitFullscreenElement;
      if (isFs) {
        (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
        return;
      }
      // The actual <video> — clip mode has it directly on `this._videoEl`;
      // live mode needs the recursive shadow-DOM search since
      // `ha-camera-stream` never exposes one to us directly.
      const videoEl = this._videoEl || this._findVideoDeep(this._streamEl);
      const iosFallback = () => {
        if (videoEl?.webkitEnterFullscreen) {
          videoEl.webkitEnterFullscreen(); // iPhone/iPad Safari — video-only API, but the only one that reliably works there
        } else {
          console.warn("[frigate-timeline-card] Fullscreen API unavailable for this element");
        }
      };
      // Prefer the standard Fullscreen API on the actual <video> (or the
      // stage container in live mode, if no video was found) — works on
      // desktop and Android. iOS Safari's support for it on arbitrary
      // elements is unreliable (the promise can resolve without actually
      // entering fullscreen), so double-check `document.fullscreenElement`
      // actually got set afterward, and fall back to the iOS-specific API
      // on rejection or silent no-op either way.
      const target = videoEl || this._stageEl;
      if (target?.requestFullscreen) {
        target
          .requestFullscreen()
          .then(() => {
            if (!document.fullscreenElement) iosFallback();
          })
          .catch((err) => {
            console.warn("[frigate-timeline-card] requestFullscreen failed", err);
            iosFallback();
          });
      } else if (target?.webkitRequestFullscreen) {
        target.webkitRequestFullscreen();
      } else {
        iosFallback();
      }
    });

    const liveBtn = document.createElement("button");
    liveBtn.className = "ftc-ctlbtn ftc-live-btn";
    liveBtn.innerHTML = `<span class="ftc-live-dot"></span>${this._t("live")}`;
    liveBtn.title = this._t("backToLive");
    liveBtn.addEventListener("click", () => this._showLive({ resetView: true }));

    bar.append(playBtn, muteBtn, fsBtn, liveBtn);
    this._playBtnEl = playBtn;
    this._muteBtnEl = muteBtn;
    this._fsBtnEl = fsBtn;
    this._liveBtnEl = liveBtn;

    // Timeline show/hide lives next to the day selector, not with the
    // playback controls — it toggles the day-nav row's own sibling
    // section, so it reads more naturally grouped with day navigation.
    const daynav = this.querySelector(".ftc-daynav");
    const timelineToggleBtn = document.createElement("button");
    timelineToggleBtn.className = "ftc-navbtn";
    timelineToggleBtn.innerHTML = ICON_CHEVRON_UP;
    timelineToggleBtn.title = this._t("toggleTimeline");
    timelineToggleBtn.addEventListener("click", () => this._setTimelineHidden(!this._timelineHidden, true));
    daynav?.appendChild(timelineToggleBtn);
    this._timelineToggleBtn = timelineToggleBtn;
  }

  /** Shared by the manual chevron button and the auto-hide timer, so both
   * keep the icon and `.ftc-timeline` display in sync with each other.
   * `userInitiated` distinguishes an explicit tap (which should cancel any
   * pending auto-hide, so it doesn't immediately re-hide what the user just
   * asked to see) from the timer's own call. */
  _setTimelineHidden(hidden, userInitiated) {
    if (!this._timelineEl) return;
    this._timelineHidden = hidden;
    this._timelineEl.style.display = hidden ? "none" : "";
    if (this._timelineToggleBtn) this._timelineToggleBtn.innerHTML = hidden ? ICON_CHEVRON_DOWN : ICON_CHEVRON_UP;
    if (userInitiated) this._scheduleAutoHide();
    // Both debts from not working while collapsed come due here: the motion
    // layer was never fetched, and any render that fell due was skipped.
    if (!hidden) {
      this._ensureRecordings();
      if (this._renderPending) this._renderTimeline();
    }
  }

  /** Restarts the auto-hide countdown (config `auto_hide_seconds`, 0 =
   * disabled) — called on every pointer interaction with the card via
   * `_wireAutoHide()`, and after any manual show/hide, so the timer always
   * measures time since the *last* interaction, not since page load. */
  _scheduleAutoHide() {
    if (this._autoHideTimer) {
      clearTimeout(this._autoHideTimer);
      this._autoHideTimer = null;
    }
    const seconds = Number(this._config?.auto_hide_seconds) || 0;
    if (seconds <= 0 || this._timelineHidden) return;
    this._autoHideTimer = setTimeout(() => this._setTimelineHidden(true, false), seconds * 1000);
  }

  /** Any interaction anywhere on the card resets the auto-hide countdown,
   * and reveals the timeline again if it had already auto-hidden —
   * matches standard video-player "controls fade after inactivity, any
   * input brings them back" behavior. */
  _wireAutoHide() {
    const wake = () => {
      if (this._timelineHidden) this._setTimelineHidden(false, false);
      this._scheduleAutoHide();
    };
    this.addEventListener("pointerdown", wake);
    this.addEventListener("pointermove", wake);
    this._scheduleAutoHide();
  }

  /** go2rtc's own base URL — defaults to the Frigate host on go2rtc's
   * standard port 1984 (what Frigate bundles it on), overridable via
   * `go2rtc_url` for setups where it differs. Only used when
   * `live_source: "frigate"`. */
  _go2rtcUrl() {
    if (this._config.go2rtc_url) return String(this._config.go2rtc_url).replace(/\/+$/, "");
    try {
      const u = new URL(this._config.frigate_url);
      return `${u.protocol}//${u.hostname}:1984`;
    } catch (_) {
      return "";
    }
  }

  /** go2rtc stream name for the selected Frigate camera — Frigate registers
   * both a full-res `<camera>_main` and a lighter `<camera>_sub` stream in
   * go2rtc; `frigate_stream` picks which. */
  /**
   * `main` and `sub` are taken literally. `auto` — the default — picks by
   * how big the card actually is on screen.
   *
   * Measured on this setup's own dashboard, the three cameras decode
   * 3200x1800, 3840x2160 and 3840x2160 at 20-25fps: 511 megapixels a
   * second between them, sustained, which is about sixty frames of 4K
   * every second. Every one of those pixels was being thrown away — the
   * cards render a few hundred pixels wide. The sub streams are 720p and
   * cost roughly a tenth of that, with nothing visibly lost at the size
   * they are displayed.
   *
   * The threshold is the sub stream's own width: below it, `sub` is
   * already at or above what the element can show, so `main` buys
   * literally nothing. Above it — a large desktop card, or fullscreen —
   * `main` starts to earn its keep.
   */
  _resolveStreamSuffix() {
    const configured = this._config.frigate_stream || "auto";
    if (configured !== "auto") return configured;
    const cssWidth = this._streamEl?.clientWidth || this._stageEl?.clientWidth || this.clientWidth || 0;
    const devicePixels = cssWidth * Math.min(window.devicePixelRatio || 1, 3);
    return devicePixels >= AUTO_MAIN_MIN_DEVICE_PX ? "main" : "sub";
  }

  _go2rtcStreamName() {
    const suffix = this._resolveStreamSuffix();
    this._activeStreamSuffix = suffix;
    return `${this._config.frigate_camera}_${suffix}`;
  }

  /** Base path of the Frigate HA integration's own reverse proxy. Every
   * route under it is same-origin with the dashboard and travels over the
   * connection the user already has to Home Assistant — no dependency on
   * the browser being able to resolve or reach Frigate's LAN address, and
   * no mixed content when the dashboard is served over https. */
  _frigateProxyPath() {
    return `/api/frigate/${encodeURIComponent(this._config.frigate_instance_id || "frigate")}`;
  }

  /**
   * Signs a Home Assistant path so something that can't set an
   * `Authorization` header — a `<video src>`, a `WebSocket` — can still use
   * it. This is Home Assistant's own mechanism (`auth/sign_path` appends an
   * `authSig` JWT covering the path *and* its query), the same one its
   * frontend uses to hand media URLs to plain elements.
   *
   * `expires` is deliberately caller-chosen: a WebSocket only needs the
   * signature to survive the upgrade handshake, while a `<video>` may keep
   * pulling ranges off the same URL for the length of the clip.
   */
  async _signHaPath(path, expires) {
    const conn = this._hass?.connection;
    if (!conn) return null;
    try {
      const res = await conn.sendMessagePromise({ type: "auth/sign_path", path, expires });
      return res?.path || null;
    } catch (err) {
      console.warn("[frigate-timeline-card] auth/sign_path failed", err);
      return null;
    }
  }

  /**
   * WebSocket URL for the go2rtc MSE stream.
   *
   * Prefers Home Assistant's Frigate proxy (`.../mse/api/ws`, which Frigate
   * forwards to go2rtc's `/api/ws`). Talking to go2rtc's own address
   * directly is what made live fail everywhere except a browser sitting on
   * the same LAN: over Tailscale or any https front end, `ws://server:1984`
   * is either unresolvable or blocked as mixed content, which is exactly
   * the "live via Frigate failed" seen on mobile. Through the proxy the
   * connection is same-origin, so it is ws:// or wss:// to match the page
   * automatically and needs nothing reachable beyond Home Assistant itself.
   *
   * An explicitly configured `go2rtc_url` still wins — that setting only
   * exists to point at a go2rtc that isn't the one Frigate bundles, which
   * the Frigate proxy by definition can't reach.
   */
  async _liveWsUrl() {
    const streamName = this._go2rtcStreamName();
    // `_proxyLiveUnavailable` covers the one case the proxy can't serve:
    // `auth/sign_path` happily signs any path, existing or not, so a setup
    // without the Frigate HA integration would otherwise get a perfectly
    // signed URL to a route that 404s and never fall back. One connection
    // that dies before delivering a single byte flips this, and the retry
    // that follows goes straight to go2rtc the way it always did.
    if (!this._config.go2rtc_url && !this._proxyLiveUnavailable) {
      const signed = await this._signHaPath(
        `${this._frigateProxyPath()}/mse/api/ws?src=${encodeURIComponent(streamName)}`,
        60
      );
      if (signed) return { url: `${location.origin.replace(/^http/, "ws")}${signed}`, viaProxy: true };
    }
    const base = this._go2rtcUrl();
    return {
      url: base ? `${base.replace(/^http/, "ws")}/api/ws?src=${encodeURIComponent(streamName)}` : "",
      viaProxy: false,
    };
  }

  /**
   * Live view has two selectable sources (`live_source` config):
   *   - `"ha"` (default): `<ha-camera-stream>`, exactly the way the
   *     companion camera-gallery-card fork's proven-working live view does
   *     it. Goes through Home Assistant's own same-origin, already-secure
   *     connection — works over https (Tailscale, Nabu Casa, any TLS
   *     reverse proxy) without any mixed-content issue.
   *   - `"frigate"`: connects straight to Frigate's own bundled go2rtc
   *     instance over MSE (WebSocket-delivered fMP4, not WebRTC — see
   *     `_showLiveViaGo2rtc()` for why), bypassing HA's `camera/webrtc/*`
   *     bridge entirely — opt-in, since it reintroduces the exact
   *     mixed-content failure mode `"ha"` was built to avoid (a raw
   *     `ws://<lan-ip>:1984` connection is blocked outright when the
   *     dashboard itself loads over https). Worth it for setups that are
   *     plain http/LAN-only, where it avoids HA's WebRTC bridge as an
   *     extra hop/point of failure.
   */
  async _showLive({ resetView = false } = {}) {
    // _build() calls _showLive() once at the end, unconditionally — before
    // `hass` has ever been set (setConfig()/_build() run synchronously,
    // hass arrives from the platform afterward). The ha-camera-stream path
    // already tolerated that fine (it bails on `!this._hass` internally),
    // but _showLiveViaGo2rtc() doesn't need hass at all and would happily
    // start a real WS connection on this premature call — which then gets
    // torn down moments later when hass actually arrives and _showLive()
    // runs again for real, killing the connection mid-handshake every
    // single time. Bailing here uniformly means only the real, later call
    // (via the `hass` setter's `first` check, or a Live click) ever does
    // any work, regardless of live_source.
    if (!this._hass) return;
    this._playingClip = null;
    this._pillMode = "live";
    // Pressing Live puts the strip back to its starting state: today, at
    // the configured zoom, centred on now. Only when actually pressed —
    // _showLive() is also how the card starts up and how it comes back
    // from the background, and resetting someone's zoom every time they
    // switch apps would be its own bug.
    if (resetView) {
      this._dayKey = todayKey();
      this._resetZoom();
      this._updateDayNavState();
      this._ensureData();
      this._ensureRecordings();
    }
    const token = (this._liveToken = (this._liveToken || 0) + 1);
    this._teardownWebRtc();
    this._teardownHls();
    this._stageEl.innerHTML = "";
    this._streamEl = null;

    if (this._config.live_source === "frigate") {
      await this._showLiveViaGo2rtc(token);
    } else {
      await this._showLiveViaHaCameraStream(token);
    }
  }

  async _showLiveViaHaCameraStream(token) {
    if (!this._hass || !this._config.camera_entity) return;
    await customElements.whenDefined("ha-camera-stream");
    if (token !== this._liveToken) return;

    const player = document.createElement("ha-camera-stream");
    this._lastCamStateObj = this._hass.states?.[this._config.camera_entity];
    player.stateObj = this._lastCamStateObj;
    player.hass = this._hass;
    player.muted = true; // starts muted so autoplay is allowed; the mute button toggles it
    player.controls = false;
    player.style.cssText = "display:block;width:100%;height:100%;";
    this._stageEl.appendChild(player);
    this._streamEl = player;
    // ha-camera-stream is a wrapper (renders ha-hls-player/ha-web-rtc-player
    // internally, not a plain <video>) — it doesn't expose the play/pause
    // API our control bar binds to, and pausing a live feed isn't a
    // meaningful action anyway, so the play button is simply inert here;
    // mute toggles its public `.muted` property directly.
    this._videoEl = null;
    if (this._muteBtnEl) this._muteBtnEl.innerHTML = player.muted ? ICON_VOLUME_OFF : ICON_VOLUME_UP;
    if (this._playBtnEl) this._playBtnEl.classList.add("ftc-hidden"); // inert on live — nothing meaningful to pause
    if (this._liveBtnEl) {
      this._liveBtnEl.classList.toggle("active", false);
      this._liveBtnEl.classList.toggle("on-live", true);
    }
  }

  /**
   * Direct go2rtc live via MSE (Media Source Extensions) over WebSocket —
   * not WebRTC. This card originally used raw WebRTC here (matching the
   * pre-ha-camera-stream implementation this option restores from git
   * history), but real-world testing turned up heavy packet loss over a
   * Tailscale path (confirmed via go2rtc's own `/api/streams` probe:
   * thousands of dropped packets on the WebRTC consumer) producing a
   * corrupted/black picture — while go2rtc's own embedded player, using
   * MSE on the exact same network path, played back flawlessly. WebRTC's
   * real-time UDP/RTP delivery is simply less tolerant of a tunneled path
   * like Tailscale than MSE's WebSocket-delivered fMP4 segments (ordered,
   * TCP-backed, no per-packet loss to speak of) — same trade-off video
   * conferencing (WebRTC) vs. video streaming (progressive/segmented) has
   * always had. MSE still fully satisfies the point of `live_source:
   * frigate` — bypassing Home Assistant's own WebRTC bridge entirely,
   * connecting straight to go2rtc — just via a different, more robust
   * transport once it got there.
   *
   * Protocol (go2rtc's own, confirmed against its docs and reference JS
   * client `www/video-rtc.js`): WS handshake at `/api/ws?src=<stream>`,
   * client sends `{type:"mse", value:"<comma-separated codec list>"}`,
   * server replies `{type:"mse", value:"<mime string incl. codecs>"}` —
   * that becomes the `MediaSource.addSourceBuffer()` argument — and every
   * subsequent binary WS message is one fMP4 segment to append.
   */
  async _showLiveViaGo2rtc(token) {
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = false;
    this._stageEl.appendChild(video);
    this._streamEl = video;
    this._bindVideoControls(video);
    // Play/pause stays hidden on live regardless of source — consistent
    // with the ha-camera-stream path, even though a real <video> here
    // technically could pause the live feed.
    if (this._playBtnEl) this._playBtnEl.classList.add("ftc-hidden");
    if (this._liveBtnEl) {
      this._liveBtnEl.classList.toggle("active", false);
      this._liveBtnEl.classList.toggle("on-live", true);
    }

    // iPhone has no `MediaSource` at all — Safari exposes only
    // `ManagedMediaSource` there (iOS 17.1+), a deliberately
    // API-compatible replacement Apple gates streaming behind. That single
    // missing global is why `live_source: frigate` could never work on a
    // phone: this check failed before a socket was ever opened, and the
    // card went straight to its "live failed" message. iPad and desktop
    // Safari keep plain MediaSource, so both names have to be tried.
    const MediaSourceClass = window.ManagedMediaSource || window.MediaSource;
    if (!MediaSourceClass) {
      this._showStageError(this._t("liveFrigateError"));
      return;
    }
    // Retries with backoff on an unexpected close — needed because the very
    // first connection attempt reliably gets torn down early on a subview
    // with several of these cards mounting at once (each one's first
    // _showLive() call races against Lovelace re-rendering the view once
    // more as it settles in). Without a retry, that one lost race means
    // permanently black — no code path ever tried again until a manual
    // click on Live. Confirmed exactly this pattern: 3 cards on the same
    // subview, all 3 logging "WebSocket is closed before the connection is
    // established" at once on load, only one recovering by luck.
    const MAX_ATTEMPTS = 5;
    const connect = async (attempt) => {
      if (token !== this._liveToken) return;
      // Re-signed per attempt on purpose — the signature is short-lived, and
      // a retry minutes into a backoff would otherwise reconnect with an
      // expired one.
      const { url: wsUrl, viaProxy } = await this._liveWsUrl();
      if (token !== this._liveToken) return;
      if (!wsUrl) {
        this._showStageError(this._t("liveFrigateError"));
        return;
      }
      if (location.protocol === "https:" && wsUrl.startsWith("ws://")) {
        console.warn(
          "[frigate-timeline-card] mixed content: page is https but go2rtc_url is http:// — this connection will be blocked"
        );
        this._showStageError(this._t("liveFrigateError"));
        return;
      }
      try {
        const ms = new MediaSourceClass();
        if (window.ManagedMediaSource && ms instanceof window.ManagedMediaSource) {
          // Apple attaches a ManagedMediaSource only when the element can't
          // hand playback off to AirPlay — either an AirPlay source
          // alternative exists or remote playback is explicitly disabled.
          // Live view has neither to offer, so it opts out. Attachment is
          // via srcObject rather than an object URL, which is the only form
          // Safari accepts for it.
          video.disableRemotePlayback = true;
          video.srcObject = ms;
        } else {
          video.src = URL.createObjectURL(ms);
        }
        let sourceBuffer = null;
        let gotData = false;
        const queue = [];
        // Set the moment this attempt stops being the live one. Every
        // reconnect assigns a fresh `video.src`, which detaches the previous
        // MediaSource and removes its SourceBuffer — and a removed
        // SourceBuffer throws InvalidStateError from *every* member,
        // `.updating` and `.buffered` included, not just appendBuffer(). Its
        // `updateend` listeners are still attached and still fire, so
        // without this flag the previous attempt's handlers keep running
        // against a dead object and throw on the way in. The `token` guard
        // alone can't cover it: token only changes on _showLive()/_playAt(),
        // never between retries of the same live view.
        let cancelled = false;
        // Set only for failures no reconnect can fix (an unsupported codec
        // is the same on the next attempt). Everything else retries.
        let fatal = false;

        const pump = () => {
          if (cancelled || token !== this._liveToken) return;
          try {
            if (!sourceBuffer || sourceBuffer.updating || !queue.length) return;
            sourceBuffer.appendBuffer(queue.shift());
          } catch (err) {
            console.warn("[frigate-timeline-card] appendBuffer failed", err);
          }
        };

        // Live-edge catch-up — ported from go2rtc's own reference client
        // (www/video-rtc.js). Without this, the video just plays whatever
        // was first buffered at 1x forever; any early buffering or stall
        // leaves it however far behind "now" that was, with nothing ever
        // pulling it back — observed as a growing, eventually 10+ second
        // gap between the pill's clock (Date.now()) and what's on screen.
        // Keeps only the last ~5s of buffer, jumps forward if playback
        // fell further behind than that, and nudges playbackRate up
        // slightly whenever there's a small gap to close.
        //
        // Two hard-won constraints shape what this is allowed to do.
        //
        // It must never seek. The first version trimmed the buffer down to
        // its last 5 seconds and then jumped `currentTime` onto that new
        // start — which lands mid-GOP, and a decoder handed a non-keyframe
        // start gives up. Reproduced directly against this setup's 4K HEVC
        // camera: with the seek, playback dies after ~100 frames with
        // `PIPELINE_ERROR_DECODE … VTDecompressionOutputCallback -12909`
        // and the element goes black for good; with the seek removed and
        // everything else identical, the same stream runs clean. Closing a
        // gap is `playbackRate`'s job, gently — go2rtc's own reference
        // client (www/video-rtc.js) likewise never seeks a live stream.
        //
        // It must never trim ahead of the playhead, only behind it, for the
        // same reason: whatever remains has to still start at a point the
        // decoder can enter.
        //
        // The trim also gets its own try block. On WebKit `remove()` throws
        // a bare `TypeError: Type error` here, because a live go2rtc fMP4
        // declares `mvhd duration = 0` (confirmed by parsing the actual
        // init segment off the wire) and MediaSource.duration is left unset,
        // which remove() rejects outright. It used to share one try with
        // the rate adjustment below, so that throw skipped the only lines
        // that did any catching up at all. Handing the MediaSource the
        // Infinity duration a live stream should report anyway is what lets
        // the trim itself succeed.
        let lastCatchUpAt = 0;
        const catchUpToLiveEdge = () => {
          if (cancelled || token !== this._liveToken || !sourceBuffer) return;
          // `updateend` fires on every appended fragment — measured at
          // roughly twenty times a second per camera, and this runs once
          // per card. None of what it does needs that resolution: a trim
          // and a playback-rate nudge are worth doing about once a second.
          const now = Date.now();
          if (now - lastCatchUpAt < CATCH_UP_INTERVAL_MS) return;
          lastCatchUpAt = now;
          let buffered;
          let end;
          try {
            if (sourceBuffer.updating) return;
            buffered = sourceBuffer.buffered;
            if (!buffered?.length) return;
            end = buffered.end(buffered.length - 1);
          } catch (_) {
            return; // detached SourceBuffer — this attempt is over
          }
          try {
            if (Number.isNaN(ms.duration) && ms.readyState === "open") ms.duration = Infinity;
            const start0 = buffered.start(0);
            // The other half of looking like a live stream: a seekable
            // range that tracks the live edge rather than growing from
            // zero. Without it the platform player treats everything
            // buffered since the connection opened as a timeline to scrub,
            // which is what turns its readout into a counter. Restored
            // here — the catch-up rewrite in v1.17.0 dropped it.
            if (ms.readyState === "open") ms.setLiveSeekableRange(start0, end);
            // Only what has already been played, and never the last 10s.
            const cutoff = Math.min(video.currentTime - 2, end - 10);
            if (cutoff > start0 + 1) sourceBuffer.remove(start0, cutoff);
          } catch (_) {
            // Best-effort housekeeping — go2rtc's own client swallows this
            // identically. Never let it block the rate adjustment below.
          }
          try {
            // Ramps to at most 1.5x, so a second of lag takes a few seconds
            // to absorb instead of being yanked out in one frame. Anything
            // sharper is visible on screen and buys nothing on a live view.
            const gap = end - video.currentTime;
            const rate = gap > 1 ? Math.min(1 + (gap - 1) * 0.25, 1.5) : 1;
            // Writing playbackRate is not free — it re-times the audio and
            // can nudge the decoder — so leave it alone when it already
            // holds the value we want.
            if (Math.abs(video.playbackRate - rate) > 0.01) video.playbackRate = rate;
          } catch (err) {
            console.warn("[frigate-timeline-card] live-edge catch-up failed", err);
          }
        };

        const ws = new WebSocket(wsUrl);
        ws.binaryType = "arraybuffer";
        this._rtcWebSocket = ws;
        let openedAt = 0;

        // Detaches this attempt's handlers. Called before anything replaces
        // the element's source, so the SourceBuffer we are about to lose
        // stops receiving events we would then have to defend against.
        const teardownAttempt = () => {
          if (cancelled) return;
          cancelled = true;
          queue.length = 0;
          if (watchdog) {
            clearInterval(watchdog);
            watchdog = null;
          }
          video.removeEventListener("error", onMediaError);
          try {
            sourceBuffer?.removeEventListener("updateend", pump);
            sourceBuffer?.removeEventListener("updateend", catchUpToLiveEdge);
          } catch (_) {
            /* already detached */
          }
        };

        // A decode error kills the element for good — `readyState` drops
        // back to HAVE_METADATA and no further append changes anything, so
        // the card just sits black with the WebSocket still happily
        // streaming into a dead MediaSource. Nothing used to notice: the
        // only recovery path was ws.onclose, and the socket never closed.
        // Routing it through a non-1000 close reuses that one retry path,
        // which rebuilds the MediaSource from a fresh init segment.
        //
        // Only decode and network failures qualify. MEDIA_ERR_ABORTED is
        // what the element reports when its own source is replaced — which
        // is exactly what the reconnect does — so treating that as a reason
        // to reconnect is a loop that never lets any attempt finish.
        const onMediaError = () => {
          const code = video.error?.code;
          if (code !== 3 /* MEDIA_ERR_DECODE */ && code !== 2 /* MEDIA_ERR_NETWORK */) return;
          if (cancelled || token !== this._liveToken) return;
          console.warn("[frigate-timeline-card] live <video> error — reconnecting", video.error);
          teardownAttempt();
          try {
            ws.close(4001);
          } catch (_) {
            /* already closing — onclose still runs */
          }
        };
        video.addEventListener("error", onMediaError);

        // Watchdog for the failure mode neither of the handlers above can
        // see: playback wedges while nothing reports a thing. Captured on a
        // 4K HEVC camera — `readyState` stayed at HAVE_ENOUGH_DATA, the
        // socket delivered 3500 segments without a pause, no `error`, no
        // `close`, no `stalled`, and `currentTime` sat frozen at 3.9s for
        // the entire run. The card just goes black, and only a manual tap
        // on Live brings it back, because a fresh _showLive() is the one
        // path that rebuilds everything.
        //
        // The trim made it worse rather than saving it: it cuts relative to
        // `currentTime`, so a frozen clock freezes the trim too, and the
        // buffer then grows without bound — 138 seconds of 4K still climbing
        // by the end of that capture.
        //
        // Detection deliberately doesn't try to know *why* the decoder
        // stopped. Data still arriving while the playhead doesn't move is
        // enough, whatever the cause, and the fix is the same thing the user
        // would do by hand: reconnect, via the same non-1000 close the other
        // recovery paths use.
        let lastEnd = -1;
        let lastCurrentTime = -1;
        let stalledMs = 0;
        let watchdog = setInterval(() => {
          if (cancelled || token !== this._liveToken || document.hidden) return;
          let end;
          try {
            const b = sourceBuffer?.buffered;
            if (!b?.length) return;
            end = b.end(b.length - 1);
          } catch (_) {
            return; // detached — teardownAttempt will clear this interval
          }
          const currentTime = video.currentTime;
          const feeding = end > lastEnd + 0.5;
          const advancing = currentTime > lastCurrentTime + 0.05;
          lastEnd = end;
          lastCurrentTime = currentTime;
          stalledMs = feeding && !advancing ? stalledMs + WATCHDOG_MS : 0;
          // The lag test is the same failure caught from the other side: a
          // playhead this far behind the live edge is never coming back on
          // playbackRate alone, and trimming forward to it is what killed
          // the decoder in the first place.
          if (stalledMs < STALL_RECONNECT_MS && end - currentTime < MAX_LIVE_LAG_SEC) return;
          console.warn("[frigate-timeline-card] live stream wedged — reconnecting", {
            stalledMs,
            lagSec: Number((end - currentTime).toFixed(1)),
          });
          teardownAttempt();
          try {
            ws.close(4002);
          } catch (_) {
            /* already closing — onclose still runs */
          }
        }, WATCHDOG_MS);

        ws.onopen = () => {
          if (token !== this._liveToken) return;
          openedAt = Date.now();
          // go2rtc's documented example list includes "flac" — dropped
          // here. Confirmed root cause of two cameras staying black with
          // no visible error (see _showLiveViaGo2rtc's own history/commit
          // log): this camera's source is H.265, and go2rtc paired our
          // claimed "flac" support with it, returning
          // `video/mp4; codecs="hvc1.1.6.L153.B0,flac"` — a combination
          // MediaSource.isTypeSupported() confirms this engine rejects
          // outright (verified directly in the browser console), so
          // addSourceBuffer() threw for every camera whose audio track
          // isn't already AAC/Opus. AAC (mp4a.40.*) and Opus alone are
          // reliably supported and cover effectively all real cameras.
          ws.send(
            JSON.stringify({
              type: "mse",
              value: this._muteToPlay ? MSE_CODECS_VIDEO_ONLY : MSE_CODECS_WITH_AUDIO,
            })
          );
        };
        ws.onmessage = (evt) => {
          if (token !== this._liveToken) return;
          if (typeof evt.data === "string") {
            let msg;
            try {
              msg = JSON.parse(evt.data);
            } catch (_) {
              return; // malformed control message — nothing to act on
            }
            if (msg.type === "mse" && !sourceBuffer) {
              // Deliberately its own try/catch, separate from the
              // JSON.parse one above — this used to share that catch
              // block, silently swallowing addSourceBuffer() failures
              // under a "malformed control message" comment that had
              // nothing to do with them. That's exactly why two of three
              // identically-configured cameras stayed black with zero
              // console output: go2rtc offered a mime/codec string this
              // browser rejected for that camera's stream, and the
              // resulting exception vanished instead of surfacing.
              // Ask the engine about the pairing go2rtc actually chose,
              // rather than pre-guessing which codecs are safe. A rejected
              // mime that carries audio is worth one more try without it —
              // silent beats black. A rejected video-only mime is the end
              // of the road and says so.
              if (!MediaSourceClass.isTypeSupported(msg.value)) {
                if (!this._muteToPlay && /(flac|opus|mp4a)/.test(msg.value)) {
                  this._muteToPlay = true;
                  console.warn(
                    `[frigate-timeline-card] engine rejects "${msg.value}" — reconnecting without audio`
                  );
                  ws.close();
                  return;
                }
                console.warn(`[frigate-timeline-card] engine rejects "${msg.value}"`);
                fatal = true;
                this._showStageError(this._t("liveFrigateError"));
                ws.close(1000);
                return;
              }
              const create = () => {
                if (token !== this._liveToken) return;
                try {
                  sourceBuffer = ms.addSourceBuffer(msg.value);
                  sourceBuffer.mode = "segments";
                  // Declare the stream endless before a single frame is
                  // appended. A MediaSource whose duration is a number is a
                  // recording as far as the platform player is concerned,
                  // and Apple's fullscreen controls will show an elapsed
                  // time climbing from zero for it; an infinite duration is
                  // what makes them show LIVE instead. Doing it here rather
                  // than on the first updateend means the element is never
                  // briefly a finite-length video, which is the state the
                  // native controls latch onto when they are opened early.
                  if (ms.readyState === "open") ms.duration = Infinity;
                  sourceBuffer.addEventListener("updateend", pump);
                  sourceBuffer.addEventListener("updateend", catchUpToLiveEdge);
                } catch (err) {
                  console.warn(`[frigate-timeline-card] addSourceBuffer failed for mime "${msg.value}"`, err);
                  this._showStageError(this._t("liveFrigateError"));
                  // Nothing downstream can ever consume the queue without a
                  // SourceBuffer — closing stops binary segments from
                  // piling up in `queue` forever for no reason. Marked
                  // fatal so onclose doesn't treat it as a blip worth
                  // retrying: the codec won't be any more supported next
                  // time round.
                  fatal = true;
                  ws.close(1000);
                }
              };
              if (ms.readyState === "open") create();
              else ms.addEventListener("sourceopen", create, { once: true });
            } else if (msg.type === "error") {
              console.warn("[frigate-timeline-card] go2rtc MSE error", msg.value);
              this._showStageError(this._t("liveFrigateError"));
            }
            return;
          }
          // Binary fMP4 segment.
          gotData = true;
          if (!sourceBuffer || sourceBuffer.updating || queue.length) {
            queue.push(evt.data);
          } else {
            try {
              sourceBuffer.appendBuffer(evt.data);
            } catch (err) {
              console.warn("[frigate-timeline-card] appendBuffer failed", err);
            }
          }
        };
        ws.onerror = () => {
          if (token === this._liveToken) console.warn("[frigate-timeline-card] go2rtc MSE WS error");
        };
        ws.onclose = (e) => {
          teardownAttempt();
          // Intent deliberately does NOT come from the close code. Home
          // Assistant's proxy rewrites whatever the client asks for to
          // 1000 — verified directly: close(4001), close(4002) and
          // close(3999) all arrive here as `code: 1000, wasClean: true`.
          // This used to read `if (e.code === 1000) return`, which meant
          // every recovery path that signalled by closing with its own code
          // was silently answered with "deliberate close, do nothing" —
          // the decode-error reconnect never once reconnected.
          //
          // A deliberate teardown is recognised by the token instead:
          // _showLive() and _playAt() both bump `_liveToken` before closing
          // the socket, as does disconnectedCallback. Anything else — an
          // unexpected drop, or one of our own recovery paths — retries.
          if (fatal || token !== this._liveToken || !this.isConnected) return;
          console.warn(`[frigate-timeline-card] go2rtc MSE WS closed (code ${e.code}) — retrying`, {
            attempt,
            gotData,
          });
          // Repeatedly never got a byte through Home Assistant's proxy —
          // most likely it isn't there at all (no Frigate integration), so
          // spend the remaining attempts going direct instead. Not on the
          // first failure: attempt 0 dying before it delivers anything is
          // the ordinary mount race described above, not a missing proxy.
          if (viaProxy && !gotData && attempt >= 2) this._proxyLiveUnavailable = true;
          // A connection that ran fine for a while and then broke is a new
          // incident, not the continuation of a failing series — it starts
          // its own attempt count. Without this, a dashboard left open all
          // day burns its five attempts on five unrelated blips hours apart
          // and then stays black until someone reloads.
          const healthy = gotData && openedAt && Date.now() - openedAt > 30000;
          const next = healthy ? 0 : attempt + 1;
          if (healthy || attempt < MAX_ATTEMPTS) {
            // A connection that had already started delivering data and
            // then dropped waits a bit longer (real network hiccup) than
            // one that never got going at all (the early-teardown race —
            // retry fast, the next attempt usually just works).
            const delayMs = gotData ? Math.min(1000 * 2 ** attempt, 8000) : 300 * (attempt + 1);
            setTimeout(() => connect(next), delayMs);
          } else {
            this._showStageError(this._t("liveFrigateError"));
          }
        };
      } catch (err) {
        console.warn("[frigate-timeline-card] go2rtc live view failed", err);
        if (token === this._liveToken) this._showStageError(this._t("liveFrigateError"));
      }
    };
    connect(0);
  }

  /** Lazily loads hls.js for browsers without native HLS (Safari/iOS/macOS
   * play .m3u8 natively via `<video src>`, no library needed there). */
  // hls.js is bundled directly into the built card file (see build.sh) —
  // `window.Hls` is already defined by the time this module runs, since the
  // vendored bundle executes first in the same file. An external CDN load
  // was tried first and silently broke playback: many HA setups can't or
  // won't reach outbound script loads, so the <video> never got a source
  // and just sat black while the now-pill (set once from the click
  // position) looked live but was actually frozen. A single self-contained
  // file sidesteps that, and also means HACS's plugin-category install
  // (which only manages the one declared `filename`) can't leave a sibling
  // dependency file un-fetched on a fresh install elsewhere.
  _loadHlsJs() {
    return window.Hls ? Promise.resolve() : Promise.reject(new Error("hls.js not bundled"));
  }

  /**
   * Plays a short window of *recorded* footage centered on `tsMs`.
   *
   * Primary path is a plain `video.src` resource load — exactly what the
   * companion camera-gallery-card fork does for its own clip playback
   * (`<video src=${url} controls autoplay …>`, no hls.js involved at all).
   * That's not a stylistic choice: a `video.src` load is a *resource* fetch,
   * the same category as `<img src>`, and browsers never subject those to
   * CORS. hls.js, by contrast, fetches the manifest/segments itself via XHR
   * to feed MediaSource — a JS-initiated cross-origin request, which IS
   * CORS-gated. Most self-hosted Frigate instances don't send
   * `Access-Control-Allow-Origin` (Frigate has no built-in setting for it;
   * needs a fronting reverse proxy), so hls.js fails outright and silently —
   * the exact same URL loads fine when opened directly in a tab, which is
   * what made this look like a server bug rather than a browser/CORS one.
   *
   * Two native routes depending on what the browser can natively decode:
   *   - Safari (native HLS support): the VOD `.m3u8` URL directly. Safari's
   *     own HLS engine handles the manifest + segments as a resource load,
   *     not JS fetches — no CORS involved. (Trade-off: this reintroduces
   *     Safari's own AirPlay/fullscreen chrome that hls.js-fed MSE playback
   *     otherwise avoids — accepted, since a working native player beats a
   *     silently black one.)
   *   - Everywhere else (Chrome, Firefox, …): Frigate's ranged
   *     `/api/<camera>/start/<start>/end/<end>/clip.mp4` endpoint — a plain
   *     progressive MP4 of the same bounded ~1min window the VOD endpoint
   *     would have covered, natively playable with zero JS-side decoding
   *     library needed anywhere.
   *
   * hls.js (still vendored) is kept purely as a last-resort fallback if the
   * native `<video>` element itself errors out — e.g. an old Frigate build
   * without the `clip.mp4` ranged endpoint. In a properly CORS-configured
   * setup this fallback would actually succeed and give smoother
   * segmented/adaptive playback than the flat MP4, so it's worth trying
   * before giving up.
   */
  _playAt(tsMs, { continuous = false } = {}) {
    const camId = this._cameraObjectId();
    const base = this._config.frigate_url.replace(/\/+$/, "");
    const nowSec = Math.floor(Date.now() / 1000);
    // Playback begins at the tap, with no run-up. A tap used to rewind 20
    // seconds so you'd catch the lead-up to an event, but the selector
    // rewound with it: tap a bar, watch the pill jump backwards off the
    // thing you just aimed at and creep back over the next 20 seconds.
    // "Play from the selector" has to mean the selector.
    const wasMuted = this._streamEl?.muted;
    let startSec = Math.floor(tsMs / 1000);
    // Clamp the end a few seconds behind "now" — Frigate needs a moment to
    // finalize very recent segments, and asking for a range that partly
    // doesn't exist yet is exactly what made playback choppy/stuck when
    // tapping near the live edge of the timeline.
    let endSec = Math.min(startSec + CLIP_WINDOW_SEC, nowSec - 5);
    if (endSec <= startSec) endSec = startSec + 15;
    const hlsUrl = `${base}/vod/${camId}/start/${startSec}/end/${endSec}/index.m3u8`;
    const mp4Url = `${base}/${camId}/start/${startSec}/end/${endSec}/clip.mp4`;

    const clip = { url: hlsUrl, tsMs, endSec };
    // Updated once the proxied manifest is known, so the error fallback
    // retries against that rather than Frigate's own cross-origin URL.
    let hlsSourceUrl = hlsUrl;
    this._playingClip = clip;
    this._pillMode = "clip";
    // `video.currentTime === 0` is exactly `startSec`, with no correction
    // needed: nginx-vod-module clips the response to the requested second
    // wherever it falls inside a recording segment — verified by asking for
    // 10s windows at 0, 5 and 8 seconds into a segment and getting 9.93,
    // 9.95 and 9.97 seconds back. The card used to assume the opposite and
    // rewrite this to the containing segment's own start_time, which sits
    // 3 to 9 seconds earlier; that correction was the whole reason the pill
    // disagreed with the camera's burned-in clock.
    this._clipStartSec = startSec;
    this._clipCurrentMs = tsMs;
    this._liveToken = (this._liveToken || 0) + 1; // invalidate any in-flight _showLive()
    this._teardownWebRtc();
    this._teardownHls();
    this._stageEl.innerHTML = "";
    this._streamEl = null;

    const video = document.createElement("video");
    video.autoplay = true;
    // Starts muted, same as live — except when carrying on from the
    // previous chunk, where re-muting mid-watch would be its own bug.
    video.muted = continuous && wasMuted !== undefined ? wasMuted : true;
    video.playsInline = true;
    video.controls = false; // controls live in the shared bar below — never native
    video.addEventListener("timeupdate", () => {
      this._clipCurrentMs = (this._clipStartSec + video.currentTime) * 1000;
      this._updateNowPill();
    });
    video.addEventListener("ended", () => {
      if (this._playingClip !== clip) return;
      // A clip that ended without ever really playing means the range came
      // back empty; continuing from it would spin through the day at speed.
      if (!(video.currentTime > 1)) return;
      this._playNextChunk();
    });

    const canPlayNativeHls = !!video.canPlayType("application/vnd.apple.mpegurl");

    const tryHlsJs = () => {
      const attach = () => {
        if (!window.Hls?.isSupported()) {
          this._showStageError(this._t("clipLoadError"));
          return;
        }
        const hls = new window.Hls({ maxBufferLength: 30, backBufferLength: 30 });
        hls.loadSource(hlsSourceUrl);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.ERROR, (_evt, data) => {
          if (!data?.fatal) return;
          console.warn("[frigate-timeline-card] hls.js fatal error", data);
          this._teardownHls();
          this._showStageError(this._t("clipLoadError"));
        });
        this._hls = hls;
      };
      if (window.Hls) attach();
      else this._loadHlsJs().then(attach).catch((err) => console.warn("[frigate-timeline-card] hls.js failed to load", err));
    };

    video.addEventListener(
      "error",
      () => {
        console.warn("[frigate-timeline-card] native <video> playback failed, falling back to hls.js", video.error);
        tryHlsJs();
      },
      { once: true }
    );

    this._stageEl.appendChild(video);
    this._bindVideoControls(video);

    // The source is resolved asynchronously so it can go through Home
    // Assistant's Frigate proxy — same-origin, and reachable from wherever
    // Home Assistant itself is, unlike Frigate's own LAN address (which a
    // phone on Tailscale or any https front end cannot load). Stepping out
    // of the click handler is safe here: this element autoplays *muted*,
    // which never requires a user gesture. Unmuting does, and that is its
    // own later button press.
    //
    // See _resolveClipSource for why this prefers HLS through the proxy.
    // Safari plays the manifest natively; everywhere else hls.js takes it,
    // which is safe here in a way it never was against Frigate directly —
    // the proxied URL is same-origin, so its XHRs aren't CORS-gated.
    this._resolveClipSource(camId, startSec, endSec, {
      url: canPlayNativeHls ? hlsUrl : mp4Url,
      hls: canPlayNativeHls,
    }).then((source) => {
      if (this._playingClip !== clip) return;
      if (source.hls) hlsSourceUrl = source.url;
      if (source.hls && !canPlayNativeHls) tryHlsJs();
      else video.src = source.url;
    });

  }

  /**
   * Where to load a clip from, best option first.
   *
   * HLS through Home Assistant's VOD proxy is the primary path, and the
   * reason is Safari: Frigate generates `clip.mp4` on the fly and answers a
   * `Range` request with a plain 200 and no `Accept-Ranges` (verified
   * against both Frigate directly and the proxy), and Safari refuses a
   * progressive MP4 it cannot range-request — `MEDIA_ERR_SRC_NOT_SUPPORTED`,
   * with nothing in the network log to explain it. Routing every browser to
   * the signed MP4 is what broke clip playback there.
   *
   * The reason it was routed that way is a mistake worth naming: a signed
   * Home Assistant path authorizes exactly one URL, and an .m3u8's segments
   * are separate URLs the player derives itself, so they looked like they
   * would arrive unsigned. They don't. The Frigate integration rewrites the
   * manifest as it proxies it, appending the same `authSig` to every
   * segment and to the init map — confirmed by reading a proxied manifest
   * and fetching a segment straight out of it. Signing the manifest is
   * enough.
   *
   * Which also means clips stream segment by segment now instead of
   * arriving as one unranged blob — 85 MB in a single response for one
   * minute of this setup's main stream.
   */
  async _resolveClipSource(camId, startSec, endSec, fallback) {
    const proxy = this._frigateProxyPath();
    const camera = encodeURIComponent(camId);
    const m3u8 = await this._signHaPath(`${proxy}/vod/${camera}/start/${startSec}/end/${endSec}/index.m3u8`, 3600);
    if (m3u8) return { url: m3u8, hls: true };
    // No manifest to be had — the MP4 proxy still works anywhere that
    // tolerates a source it can't range-request.
    const mp4 = await this._signHaPath(`${proxy}/recording/${camera}/start/${startSec}/end/${endSec}`, 3600);
    if (mp4) return { url: mp4, hls: false };
    return fallback;
  }

  /**
   * Playback starts where the selector is. That is the whole rule, and it
   * used not to be: taps snapped to the nearest *event*, which made every
   * stretch of plain motion unreachable — the timeline draws it, you tap
   * it, and playback jumps to some unrelated detection instead. Measured
   * against a day of this setup's data, that snap moved a tap by 6.6
   * minutes on average and by as much as three hours.
   *
   * The one thing this still adjusts is a tap into a gap. Frigate keeps
   * footage only where something happened — around half a day here — so
   * there are stretches with genuinely nothing to play, and asking for a
   * clip there is what produced "couldn't load the clip". Those land on
   * the nearest recorded edge instead. Anywhere the strip shows activity,
   * the selector is taken literally.
   */
  _nearestPlayableMs(ts) {
    const segments = this._recordings;
    if (!segments?.length) return ts;
    let best = null;
    let bestDistance = Infinity;
    for (const seg of segments) {
      if (ts >= seg.start && ts <= seg.end) return ts;
      const distance = ts < seg.start ? seg.start - ts : ts - seg.end;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = seg.start;
      }
    }
    return best ?? ts;
  }

  /** Start of the next stretch of footage at or after `ts`, or null when
   * nothing further was recorded. */
  _nextRecordedMs(ts) {
    let best = null;
    for (const seg of this._recordings || []) {
      if (seg.end <= ts) continue;
      const candidate = Math.max(seg.start, ts);
      if (best == null || candidate < best) best = candidate;
    }
    return best;
  }

  /**
   * Keeps playback running past the end of a clip instead of stopping dead
   * on the last frame. Each chunk is a bounded ~1min range, so watching
   * anything longer meant tapping the timeline again and again.
   *
   * Jumps the gaps rather than requesting through them: Frigate only keeps
   * footage where something happened, so the minute after a clip is often
   * empty, and asking for it would end playback on an error instead of
   * carrying on at the next thing worth seeing.
   */
  _playNextChunk() {
    const clip = this._playingClip;
    if (!clip) return;
    const fromMs = clip.endSec * 1000;
    // Stop at the live edge — the last few seconds aren't finalised yet,
    // and the Live button is the right way back to the present anyway.
    if (fromMs >= Date.now() - 10000) return;
    const resume = this._recordings?.length ? this._nextRecordedMs(fromMs) : fromMs;
    if (resume == null) return;
    this._playAt(resume, { continuous: true });
  }

  _seekTo(frac) {
    const win = this._currentWindow();
    const raw = win.start + frac * (win.end - win.start);
    this._playAt(this._nearestPlayableMs(raw));
  }

  async _ensureData() {
    const base = this._config.frigate_url.replace(/\/+$/, "");
    const win = dayWindow(this._dayKey);
    // Nothing downstream can do anything useful with a broken day, and a
    // NaN window otherwise reaches the network as `after=NaN&before=NaN`.
    if (!Number.isFinite(win.start) || !Number.isFinite(win.end)) {
      console.warn("[frigate-timeline-card] refusing to fetch for an invalid day", this._dayKey);
      return;
    }
    const key = `${base}|${this._dayKey}|${this._config.frigate_camera || ""}`;
    if (this._fetchKey === key) return;
    this._fetchKey = key;

    const camId = this._cameraObjectId();
    const afterSec = Math.floor(win.start / 1000);
    const beforeSec = Math.ceil(win.end / 1000);

    // Review data — the activity blocks the timeline draws its bands
    // from, and the first thing asked for. `frigate/reviews/get` goes
    // through Home Assistant's own connection, so it is reachable however
    // the dashboard itself is being served; Frigate's REST endpoint is the
    // fallback, since Frigate sends no `Access-Control-Allow-Origin` and a
    // browser cannot read it cross-origin.
    //
    // This used to be REST-only, on the belief that /api/review had no WS
    // equivalent. It does — the Frigate integration has shipped
    // `frigate/reviews/get` for a long time — and the REST call it replaces
    // could never have worked from a browser in the first place: Frigate
    // sends no `Access-Control-Allow-Origin` on /api/review, so every load
    // of this card spent a request getting CORS-blocked (a red console
    // error per card, per day-window) and then silently fell back to
    // deriving the bands from the raw event list.
    let reviews = null;
    if (this._hass?.connection) {
      try {
        let wsReviews = await this._hass.connection.sendMessagePromise({
          type: "frigate/reviews/get",
          instance_id: this._config.frigate_instance_id,
          ...(camId ? { cameras: [camId] } : {}),
          after: afterSec,
          before: beforeSec,
          limit: 500,
        });
        if (typeof wsReviews === "string") wsReviews = JSON.parse(wsReviews);
        if (Array.isArray(wsReviews)) reviews = wsReviews;
      } catch (err) {
        console.warn("[frigate-timeline-card] WS frigate/reviews/get failed", err);
      }
    }
    if (!Array.isArray(reviews)) {
      try {
        const res = await fetch(`${base}/api/review?after=${afterSec}&before=${beforeSec}`);
        if (res.ok) reviews = await res.json();
      } catch (err) {
        console.warn("[frigate-timeline-card] REST /api/review unavailable — falling back to events", err);
      }
    }

    // Events are only ever a fallback: the bands come from review data, and
    // this list is used solely to approximate them when that is missing.
    // It used to be fetched first and unconditionally — around 54 KiB per
    // camera per day here, a Frigate query and a websocket round trip,
    // thrown away untouched on every normal load. It also asked for every
    // camera at once and filtered afterwards, so three cameras shared one
    // limit of 500 and a busy day could silently drop the one being looked
    // at. Scoped, and only asked for when there is nothing better.
    let events = null;
    if (!Array.isArray(reviews)) {
      if (this._hass?.connection) {
        try {
          let wsResult = await this._hass.connection.sendMessagePromise({
            type: "frigate/events/get",
            instance_id: this._config.frigate_instance_id,
            ...(camId ? { cameras: [camId] } : {}),
            after: afterSec,
            before: beforeSec,
            limit: 500,
          });
          if (typeof wsResult === "string") wsResult = JSON.parse(wsResult);
          if (Array.isArray(wsResult)) events = wsResult;
        } catch (err) {
          console.warn("[frigate-timeline-card] WS frigate/events/get failed", err);
        }
      }
      if (!Array.isArray(events)) {
        try {
          const res = await fetch(`${base}/api/events?after=${afterSec}&before=${beforeSec}&limit=500`);
          if (res.ok) events = await res.json();
        } catch (err) {
          console.warn("[frigate-timeline-card] REST /api/events unavailable — no fallback band data", err);
        }
      }
    }

    if (this._fetchKey !== key) return; // a newer fetch superseded this one

    this._events = (Array.isArray(events) ? events : []).filter((ev) => ev.camera === camId);

    if (Array.isArray(reviews)) {
      this._segments = reviews
        .filter((r) => r.camera === camId && Number.isFinite(Number(r.start_time)))
        .map((r) => ({
          start: Number(r.start_time) * 1000,
          end: Number.isFinite(Number(r.end_time)) ? Number(r.end_time) * 1000 : Date.now(),
          // Red means a person was there, which is not the same thing as
          // Frigate's own `alert` severity and is the more useful of the
          // two to be able to spot. Measured against a day of this setup's
          // data: 97 review segments contained a person but only 68 were
          // alerts, so a severity-driven red would have missed 29 of them
          // outright — while 34 alerts were cats, which would have been
          // red for no reason. Severity still decides nothing else here;
          // everything without a person reads as ordinary activity.
          person: hasPerson(r.data?.objects),
        }));
    } else {
      // No review data at all — fall back to the raw event list. It has no
      // notion of a review segment, but it still knows what was seen and
      // when, which is enough to draw something honest.
      this._segments = this._events.map((ev) => {
        const startMs = Number(ev.start_time) * 1000;
        const endSec = Number(ev.end_time);
        const endMs = Number.isFinite(endSec) ? endSec * 1000 : startMs + 10000;
        return { start: startMs, end: endMs, person: hasPerson([ev.label, ev.sub_label]) };
      });
    }
    this._renderTimeline();
    this._ensureRecordings();
  }

  /**
   * Motion comes from the recording segments, not from review data:
   * Frigate stopped emitting a `significant_motion` severity, so a review
   * segment is only ever a detection or an alert. Each ~10s recording
   * segment instead carries a `motion` score, which is exactly what
   * Frigate's own timeline draws its motion histogram from.
   *
   * Frigate only writes a segment where something happened, so a day is
   * thousands of them rather than the 8640 a continuous recording would
   * give: measured here, 4100–5400 per camera per day, 660–860 KiB of
   * JSON. Enough to be worth not fetching until the timeline is actually
   * on screen — with `auto_hide_seconds` set, it spends most of its life
   * collapsed — and enough to be worth its own cache key, so expanding the
   * strip doesn't re-fetch the events and reviews alongside it.
   */
  async _ensureRecordings() {
    if (this._timelineHidden) return;
    const win = dayWindow(this._dayKey);
    if (!Number.isFinite(win.start)) return;
    const camId = this._cameraObjectId();
    const key = `${this._dayKey}|${camId}`;
    if (this._recordingsKey === key) return;
    this._recordingsKey = key;

    const afterSec = Math.floor(win.start / 1000);
    const beforeSec = Math.ceil(win.end / 1000);
    let segments = null;
    if (this._hass?.connection) {
      try {
        let ws = await this._hass.connection.sendMessagePromise({
          type: "frigate/recordings/get",
          instance_id: this._config.frigate_instance_id,
          camera: camId,
          after: afterSec,
          before: beforeSec,
        });
        if (typeof ws === "string") ws = JSON.parse(ws);
        if (Array.isArray(ws)) segments = ws;
      } catch (err) {
        console.warn("[frigate-timeline-card] WS frigate/recordings/get failed", err);
      }
    }
    if (!Array.isArray(segments)) {
      try {
        const base = this._config.frigate_url.replace(/\/+$/, "");
        const res = await fetch(`${base}/${camId}/recordings?after=${afterSec}&before=${beforeSec}`);
        if (res.ok) segments = await res.json();
      } catch (err) {
        console.warn("[frigate-timeline-card] recordings unavailable — no motion layer", err);
      }
    }
    if (this._recordingsKey !== key) return; // superseded
    this._recordings = (Array.isArray(segments) ? segments : [])
      .filter((seg) => Number.isFinite(Number(seg.start_time)))
      .map((seg) => ({
        start: Number(seg.start_time) * 1000,
        end: Number.isFinite(Number(seg.end_time)) ? Number(seg.end_time) * 1000 : Number(seg.start_time) * 1000 + 10000,
        score: Number(seg.motion) || 0,
      }));
    this._renderTimeline();
  }

  /** Formats a Date as "20:56:54" — 24h, used for the now-pill. */
  _formatClock(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  _updateNowPill() {
    if (!this._timelineOnScreen()) return; // nobody is reading a clock they can't see
    if (!this._nowPillEl || this._scrubbing) return; // don't fight the drag preview
    const win = this._currentWindow();
    const isClip = this._pillMode === "clip";
    const now = isClip ? this._clipCurrentMs ?? Date.now() : Date.now();
    const inWindow = now >= win.start && now <= win.end;
    this._nowPillEl.style.display = inWindow ? "" : "none";
    this._nowLineEl.style.display = inWindow ? "" : "none";
    this._nowPillEl.classList.toggle("clip", isClip);
    this._nowLineEl.classList.toggle("clip", isClip);
    if (!inWindow) return;
    const pct = ((now - win.start) / (win.end - win.start)) * 100;
    this._nowPillEl.style.left = `${pct}%`;
    this._nowLineEl.style.left = `${pct}%`;
    this._nowPillEl.textContent = this._formatClock(new Date(now));
  }

  /** Picks a "nice" tick spacing so a zoomed-in window still gets several
   * readable ticks instead of the fixed 2h step falling to 0-1 of them. */
  _tickStepMs(spanMs) {
    const targetTicks = 6;
    const raw = spanMs / targetTicks;
    const steps = [
      60000, 300000, 600000, 900000, 1800000, 3600000, 2 * 3600000, 3 * 3600000, 6 * 3600000, 12 * 3600000,
    ];
    return steps.find((s) => s >= raw) || steps[steps.length - 1];
  }

  /** Whether the strip is actually on screen: the page in front, the card
   * in the viewport, and the strip not collapsed. Rendering into any of
   * those states is work nobody can see — and with `auto_hide_seconds` set
   * the strip is collapsed most of the time. */
  _timelineOnScreen() {
    return !document.hidden && this._onScreen !== false && !this._timelineHidden;
  }

  /** Bands are a handful of elements and stay as DOM; motion is hundreds of
   * columns and goes on a canvas. Both live in their own layer so a render
   * can replace one without disturbing the other — or the scrub indicator,
   * which used to be wiped by every innerHTML rebuild. */
  _ensureTrackLayers() {
    if (!this._bandsEl) {
      this._bandsEl = document.createElement("div");
      this._bandsEl.className = "ftc-bands";
      this._trackEl.appendChild(this._bandsEl);
    }
    if (!this._motionCanvas) {
      this._motionCanvas = document.createElement("canvas");
      this._motionCanvas.className = "ftc-motion";
      this._trackEl.appendChild(this._motionCanvas);
    }
  }

  /**
   * The motion histogram, drawn rather than built.
   *
   * It was hundreds of absolutely-positioned divs — one per column of the
   * strip — rebuilt from scratch on every render. Measured against a
   * phone-width strip, that is 1.45ms and 300-odd nodes per render per
   * card; the same picture on a canvas is 0.28ms and one node. The
   * difference stops mattering when the strip is idle and starts mattering
   * a great deal while scrubbing, where a render happens every frame.
   */
  _drawMotion(win, span) {
    const canvas = this._motionCanvas;
    const cssWidth = this._trackEl.clientWidth;
    const cssHeight = this._trackEl.clientHeight;
    if (!canvas || !cssWidth || !cssHeight) return;
    // Capped at 2: a 3x phone display gains nothing visible here and pays
    // for every extra pixel.
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(cssWidth * ratio);
    const height = Math.round(cssHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    if (this._config.show_motion === false || !this._recordings?.length) return;

    // One column per pixel of strip, carrying the loudest score that falls
    // in it. A day is thousands of segments against a few hundred pixels;
    // drawn individually they would be sub-pixel slivers fighting over the
    // same column for a picture no different from this one.
    const buckets = Math.max(60, Math.min(600, Math.round(cssWidth)));
    const peaks = new Float64Array(buckets);
    let max = 0;
    for (const m of this._recordings) {
      if (!m.score) continue;
      if (m.end <= win.start || m.start >= win.end) continue;
      const from = Math.max(0, Math.floor(((m.start - win.start) / span) * buckets));
      const to = Math.min(buckets - 1, Math.floor(((m.end - win.start) / span) * buckets));
      for (let i = from; i <= to; i++) {
        if (m.score > peaks[i]) peaks[i] = m.score;
      }
      if (m.score > max) max = m.score;
    }
    if (!max) return;

    ctx.fillStyle =
      getComputedStyle(this._trackEl).getPropertyValue("--frigate-timeline-motion").trim() ||
      "rgba(255, 255, 255, 0.62)";
    const columnWidth = width / buckets;
    const barWidth = Math.max(ratio, columnWidth - ratio * 0.4);
    const radius = Math.min(ratio, barWidth / 2);
    const rounded = typeof ctx.roundRect === "function";
    // Scaled against the loudest score *in view*, so zooming into a quiet
    // stretch opens its detail up instead of flattening it against some
    // unrelated peak elsewhere in the day. Square-rooted because the scores
    // are wildly uneven — 1 to over a thousand on these cameras — and a
    // linear scale leaves everything ordinary invisible.
    if (rounded) ctx.beginPath();
    for (let i = 0; i < buckets; i++) {
      if (!peaks[i]) continue;
      const barHeight = Math.max(
        ratio * 2,
        (Math.sqrt(peaks[i] / max) * MOTION_MAX_HEIGHT_PCT * height) / 100
      );
      const x = i * columnWidth;
      const y = (height - barHeight) / 2;
      if (rounded) ctx.roundRect(x, y, barWidth, barHeight, radius);
      else ctx.fillRect(x, y, barWidth, barHeight);
    }
    if (rounded) ctx.fill();
  }

  _renderTimeline() {
    if (!this._trackEl) return;
    if (!this._timelineOnScreen()) {
      // Remember that it needs one, so it isn't stale when it comes back.
      this._renderPending = true;
      return;
    }
    this._renderPending = false;
    const win = this._currentWindow();
    const span = win.end - win.start;
    if (!(span > 0)) return;

    // Laid out the way Frigate's own timeline reads: review segments are
    // translucent full-height bands marking *where* something happened,
    // and motion is a histogram of *how much*, drawn over them. Painted
    // back to front — ordinary activity, then person bands over it, then
    // the motion histogram on top, since burying the histogram under a
    // band would hide the only layer carrying detail.
    let bandsHtml = "";
    for (const pass of ["plain", "person"]) {
      for (const seg of this._segments) {
        if ((pass === "person") !== !!seg.person) continue;
        const st = Math.max(seg.start, win.start);
        const en = Math.min(seg.end, win.end);
        if (en <= st) continue;
        const left = ((st - win.start) / span) * 100;
        const width = Math.max(((en - st) / span) * 100, 0.15);
        bandsHtml += `<div class="ftc-band ${pass}" style="left:${left}%;width:max(2px, ${width}%);"></div>`;
      }
    }
    this._ensureTrackLayers();
    this._bandsEl.innerHTML = bandsHtml;
    this._drawMotion(win, span);
    this._updateNowPill();

    let ticksHtml = "";
    const stepMs = this._tickStepMs(span);
    const first = new Date(Math.ceil(win.start / stepMs) * stepMs);
    for (let t = first.getTime(); t < win.end; t += stepMs) {
      const pct = ((t - win.start) / span) * 100;
      const d = new Date(t);
      let h = d.getHours();
      const ampm = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12;
      const label = stepMs < 3600000 ? `${h}:${pad2(d.getMinutes())}` : `${h}:${pad2(d.getMinutes())} ${ampm}`;
      ticksHtml += `<span class="ftc-tick" style="left:${pct}%">${label}</span>`;
    }
    this._ticksEl.innerHTML = ticksHtml;

    if (this._dayLabelEl) {
      const isToday = this._dayKey === todayKey();
      this._dayLabelEl.textContent = isToday
        ? this._t("today")
        : new Date(win.start).toLocaleDateString(this._hass?.locale?.language || undefined, {
            day: "numeric",
            month: "short",
          });
    }
  }
}

class FrigateTimelineCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = {
      height: 44,
      frigate_instance_id: "frigate",
      default_zoom_hours: 10,
      auto_hide_seconds: 0,
      live_source: "ha",
      frigate_stream: "auto",
      ...config,
    };
    if (!this._built) this._build();
    this._sync();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    // Language (from hass.locale) is only known once hass arrives — the
    // form was built English-default in _build() (which runs before hass
    // exists), so refresh every label the first time it's available.
    if (first) this._applyI18n();
    // The WS camera-discovery fallback needs hass.connection, which also
    // wasn't available yet if _build()'s initial fetch ran before hass
    // arrived — retry now that it's known, in case that first attempt
    // fell through to a no-op.
    if (first && !this._frigateCameraNames?.length) this._fetchFrigateCameraList();
  }

  _t(key) {
    return translate(this._hass, key);
  }

  /** Re-applies every `[data-i18n]` label's text once `hass`'s locale is
   * known — see the `set hass()` comment for why this can't just be baked
   * into the static template. */
  _applyI18n() {
    this.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = this._t(el.dataset.i18n);
    });
  }

  /**
   * Plain native `<input>`/`<select>` for every field except the camera
   * entity picker — deliberately NOT `ha-textfield`/`ha-select`/
   * `mwc-list-item`. Those are HA/Material Web Components that only render
   * anything once their custom-element class is registered and upgraded;
   * until then a raw `<ha-textfield>` tag has no shadow DOM at all, so it's
   * completely invisible — no box, no label, nothing — not just unstyled.
   * That's exactly what happened here: `ha-entity-picker` happened to be
   * registered by the time this editor opened, but the others weren't,
   * so every field except the camera picker silently failed to render at
   * all, even though it was correctly present in the DOM the whole time.
   * Native form elements have no such dependency — guaranteed to render
   * regardless of what HA's frontend has gotten around to loading yet.
   */
  _build() {
    this._built = true;
    this.innerHTML = `
      <div class="ftc-ed-form">
        <div class="ftc-ed-row">
          <label class="ftc-ed-field" style="flex:2">
            <span data-i18n="edHost">Server Frigate (ex: 192.168.1.11)</span>
            <input id="ftc-ed-host" type="text" />
          </label>
          <label class="ftc-ed-field" style="flex:1">
            <span data-i18n="edPort">Port</span>
            <input id="ftc-ed-port" type="number" />
          </label>
        </div>
        <div id="ftc-ed-camera-row">
          <label class="ftc-ed-field">
            <span data-i18n="edFrigateCamera">Cameră în Frigate (ex: spate)</span>
            <input id="ftc-ed-camera" type="text" />
          </label>
        </div>
        <div class="ftc-ed-row">
          <label class="ftc-ed-field" style="flex:1">
            <span data-i18n="edHeight">Înălțime timeline (px)</span>
            <input id="ftc-ed-height" type="number" />
          </label>
          <label class="ftc-ed-field" style="flex:1">
            <span data-i18n="edZoom">Zoom implicit (ore)</span>
            <input id="ftc-ed-zoom" type="number" step="0.25" min="0.25" max="24" />
          </label>
        </div>
        <label class="ftc-ed-field">
          <span data-i18n="edAutohide">Auto-hide timeline (secunde de inactivitate, 0 = dezactivat)</span>
          <input id="ftc-ed-autohide" type="number" min="0" step="1" />
        </label>
        <label class="ftc-ed-field">
          <span data-i18n="edStream">Stream</span>
          <select id="ftc-ed-frigate-stream">
            <option value="auto">auto</option>
            <option value="main">main</option>
            <option value="sub">sub</option>
          </select>
        </label>
      </div>
      <style>
        frigate-timeline-card-editor .ftc-ed-form { display: flex; flex-direction: column; gap: 16px; padding: 8px 2px 16px; }
        frigate-timeline-card-editor .ftc-ed-row { display: flex; gap: 8px; }
        frigate-timeline-card-editor .ftc-ed-field {
          display: flex; flex-direction: column; gap: 4px; flex: 1;
          font-size: 12px; color: var(--secondary-text-color, #999);
        }
        frigate-timeline-card-editor .ftc-ed-field input,
        frigate-timeline-card-editor .ftc-ed-field select {
          font: inherit; font-size: 15px; color: var(--primary-text-color, #fff);
          background: var(--card-background-color, transparent);
          border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.4));
          border-radius: 6px; padding: 8px 10px; width: 100%; box-sizing: border-box;
        }
        frigate-timeline-card-editor .ftc-ed-field input:focus,
        frigate-timeline-card-editor .ftc-ed-field select:focus {
          outline: none; border-color: var(--primary-color, #03a9f4);
        }
      </style>
    `;
    const onHostPortChange = () => {
      const host = this.querySelector("#ftc-ed-host")?.value?.trim() || "";
      const port = this.querySelector("#ftc-ed-port")?.value?.trim() || "";
      const url = host ? `http://${host}${port ? `:${port}` : ""}` : "";
      this._update("frigate_url", url);
      this._fetchFrigateCameraList();
    };
    this.querySelector("#ftc-ed-host").addEventListener("input", onHostPortChange);
    this.querySelector("#ftc-ed-port").addEventListener("input", onHostPortChange);
    this.querySelector("#ftc-ed-camera").addEventListener("input", (e) => this._update("frigate_camera", e.target.value));
    this.querySelector("#ftc-ed-height").addEventListener("input", (e) => this._update("height", Number(e.target.value) || 44));
    this.querySelector("#ftc-ed-zoom").addEventListener("input", (e) =>
      this._update("default_zoom_hours", Math.min(24, Math.max(0.25, Number(e.target.value) || 10)))
    );
    this.querySelector("#ftc-ed-autohide").addEventListener("input", (e) =>
      this._update("auto_hide_seconds", Math.max(0, Number(e.target.value) || 0))
    );
    this.querySelector("#ftc-ed-frigate-stream").addEventListener("change", (e) => this._update("frigate_stream", e.target.value));

    this._applyI18n();
    this._fetchFrigateCameraList();
  }

  /** host/port are UI-only, split from the stored `frigate_url` for display. */
  _parseFrigateUrl(url) {
    try {
      const u = new URL(url);
      return { host: u.hostname, port: u.port || "" };
    } catch (_) {
      return { host: "", port: "" };
    }
  }

  /** Discovers Frigate's camera names and swaps the free-text
   * "frigate_camera" field for a dropdown, keeping the text field if
   * nothing can be discovered.
   *
   * Home Assistant's websocket goes first. Asking Frigate directly for
   * `/api/config` is the more authoritative source — it lists every
   * camera, not only those with recent events — but it is cross-origin,
   * and Frigate sends no `Access-Control-Allow-Origin`, so on most setups
   * it fails and logs a red CORS error every time the editor opens. It is
   * the last direct request left anywhere in the card; trying it second
   * means the usual case never reaches it. */
  async _fetchFrigateCameraList() {
    const url = this._config?.frigate_url;
    if (!url) return;
    const token = (this._camFetchToken = (this._camFetchToken || 0) + 1);
    if (await this._fetchFrigateCameraListViaWs(token)) return;
    const base = String(url).replace(/\/+$/, "");
    try {
      const res = await fetch(`${base}/api/config`);
      if (!res.ok) return;
      const cfg = await res.json();
      if (token !== this._camFetchToken) return;
      const names = Object.keys(cfg?.cameras || {});
      if (!names.length) return;
      this._frigateCameraNames = names;
      this._renderCameraField();
    } catch (_) {
      // Cross-origin or unreachable — the text field stays, which is a
      // perfectly usable fallback.
    }
  }

  /** Fallback camera-name discovery for when direct REST to Frigate is
   * CORS-blocked or unreachable. Reuses the exact same WS path
   * (`frigate/events/get`) already proven working for the main card's
   * event fetching — same-origin through Home Assistant, immune to CORS
   * — asking for a wide, unfiltered window and collecting the distinct
   * `camera` values seen across returned events. Less authoritative than
   * `/api/config` (a camera with zero events in the window won't show
   * up), but it's the best available discovery source when the direct
   * REST call can't be made at all. */
  async _fetchFrigateCameraListViaWs(token) {
    if (!this._hass?.connection) return false;
    try {
      let result = await this._hass.connection.sendMessagePromise({
        type: "frigate/events/get",
        instance_id: this._config.frigate_instance_id || "frigate",
        after: Math.floor(Date.now() / 1000) - 7 * 24 * 3600,
        before: Math.floor(Date.now() / 1000),
        limit: 500,
      });
      if (typeof result === "string") result = JSON.parse(result);
      if (token !== this._camFetchToken) return true; // superseded; don't also run REST
      if (!Array.isArray(result)) return false;
      const names = [...new Set(result.map((ev) => ev.camera).filter(Boolean))].sort();
      if (!names.length) return false;
      this._frigateCameraNames = names;
      this._renderCameraField();
      return true;
    } catch (err) {
      console.warn("[frigate-timeline-card] WS camera discovery failed", err);
      return false;
    }
  }

  _renderCameraField() {
    const row = this.querySelector("#ftc-ed-camera-row");
    if (!row || !this._frigateCameraNames?.length) return;
    row.innerHTML = `
      <label class="ftc-ed-field">
        <span>${this._t("edFrigateCameraSelect")}</span>
        <select id="ftc-ed-camera-select">
          ${this._frigateCameraNames.map((n) => `<option value="${n}">${n}</option>`).join("")}
        </select>
      </label>
    `;
    const sel = row.querySelector("#ftc-ed-camera-select");
    sel.value = this._config.frigate_camera || "";
    sel.addEventListener("change", (e) => this._update("frigate_camera", e.target.value));
  }

  _sync() {
    const set = (id, val) => {
      const el = this.querySelector(id);
      if (el && el.value !== String(val ?? "")) el.value = val ?? "";
    };
    const { host, port } = this._parseFrigateUrl(this._config.frigate_url);
    set("#ftc-ed-host", host);
    set("#ftc-ed-port", port);
    if (!this._frigateCameraNames?.length) set("#ftc-ed-camera", this._config.frigate_camera);
    set("#ftc-ed-height", this._config.height ?? 44);
    set("#ftc-ed-zoom", this._config.default_zoom_hours ?? 10);
    set("#ftc-ed-autohide", this._config.auto_hide_seconds ?? 0);
    set("#ftc-ed-frigate-stream", this._config.frigate_stream || "auto");
  }

  _update(key, value) {
    this._config = { ...this._config, [key]: value };
    this.dispatchEvent(
      new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true })
    );
  }
}

customElements.define("frigate-timeline-card", FrigateTimelineCard);
customElements.define("frigate-timeline-card-editor", FrigateTimelineCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "frigate-timeline-card",
  name: "Frigate Timeline Card",
  description: "Live camera view + a Frigate-style horizontal event timeline below it.",
});
