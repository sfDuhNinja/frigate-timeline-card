/**
 * frigate-timeline-card
 *
 * Minimal Home Assistant Lovelace card: live camera view plus a horizontal
 * Frigate-style event timeline below it (gold = detection, red = alert,
 * live-updating "now" pill), matching Frigate's own colors. Click/drag the
 * timeline to play the nearest ~1min of recorded footage inline; a "Live"
 * button returns to the live stream.
 *
 * Live view uses `<ha-camera-stream>` bound to `camera_entity` — same
 * element, same setup, as the companion camera-gallery-card fork's
 * already-proven-working live view. Event/review data is scoped by
 * `frigate_camera` (Frigate's own camera name, not the HA entity), fetched
 * WebSocket-first through Home Assistant (`frigate/events/get`), same
 * priority order as that fork, with REST to `frigate_url` as a secondary
 * enhancement (exact severity from /api/review has no WS equivalent).
 *
 * Why WS-first and ha-camera-stream, not a raw connection straight to
 * Frigate's LAN address: this card originally tried exactly that (raw
 * `ws://<lan-ip>:1984/...` for live, REST-first for events) and it broke
 * outright the moment the dashboard itself is served over https (Tailscale,
 * Nabu Casa, any TLS reverse proxy — common, not an edge case). Browsers
 * block that as mixed content with no visible error. Routing everything
 * through Home Assistant's own same-origin connection sidesteps it
 * entirely — `<ha-camera-stream>` and `frigate/events/get` both go over
 * HA's existing secure WebSocket, never a raw request to the camera's LAN
 * IP. Direct REST to `frigate_url` (events enhancement, clip HLS playback)
 * still requires the dashboard be reachable to that address unencrypted —
 * fine on plain http/LAN access, silently unavailable over https, which is
 * why the WS path is primary rather than a fallback.
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
 *   frigate_url: http://192.168.1.11:5000   # required — Frigate REST base (events enhancement + clip playback; needs http/LAN reachability from the browser)
 *   frigate_camera: spate                   # required — Frigate's own camera name, for scoping events/review data
 *   frigate_instance_id: frigate            # optional — Frigate HA integration config-entry id, for the events WS call (default "frigate")
 *   height: 44                              # optional — timeline strip height in px
 *   default_zoom_hours: 10                  # optional — initial timeline zoom window, in hours (default 10)
 *   auto_hide_seconds: 0                    # optional — auto-collapse the timeline after N seconds of no interaction (default 0 = disabled)
 *   live_source: ha                         # optional — "ha" (default, via ha-camera-stream) or "frigate" (direct go2rtc WebRTC, bypasses HA's WebRTC bridge — opt-in, reintroduces the mixed-content risk described above)
 *   go2rtc_url: http://192.168.1.11:1984    # optional — only used when live_source: frigate; defaults to the frigate_url host on port 1984
 *   frigate_stream: main                    # optional — only used when live_source: frigate; go2rtc stream suffix, "main" or "sub" (default "main")
 */

const PLAYHEAD_TICK_MS = 60 * 1000;
const ALERT_LABEL_RE = /^(person|car)(-verified)?$|-verified$/;
const ALERT_SCORE_THRESHOLD = 0.7;

function approximateSeverity(ev) {
  const label = String(ev?.label ?? "").toLowerCase();
  const score = Number(ev?.top_score ?? ev?.score ?? 0);
  // Person events always render red/alert, matching Frigate's own timeline
  // — regardless of confidence score or verified status, unlike other
  // labels (car, etc.) which still need a verified/high-confidence hit.
  if (label === "person" || label === "person-verified") return "alert";
  if (ALERT_LABEL_RE.test(label) && (label.endsWith("-verified") || score >= ALERT_SCORE_THRESHOLD)) {
    return "alert";
  }
  return "detection";
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
    recordingLoadError: "Nu s-a putut încărca înregistrarea de la Frigate.",
    liveFrigateError: "Live direct prin Frigate a eșuat (verifică go2rtc_url, sau CORS/mixed-content dacă dashboard-ul e pe https).",
    edCamera: "Cameră (live view, via ha-camera-stream)",
    edHost: "Server Frigate (ex: 192.168.1.11)",
    edPort: "Port",
    edFrigateCamera: "Cameră în Frigate (ex: spate)",
    edFrigateCameraSelect: "Cameră în Frigate",
    edInstance: "Frigate instance id (implicit: frigate)",
    edHeight: "Înălțime timeline (px)",
    edZoom: "Zoom implicit (ore)",
    edAutohide: "Auto-hide timeline (secunde de inactivitate, 0 = dezactivat)",
    edLiveSource: "Sursă live",
    edLiveSourceHa: "Home Assistant (ha-camera-stream, implicit)",
    edLiveSourceFrigate: "Frigate direct (go2rtc, bypass HA WebRTC)",
    edGo2rtcUrl: "go2rtc URL (implicit: host Frigate, port 1984)",
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
    recordingLoadError: "Couldn't load the recording from Frigate.",
    liveFrigateError: "Direct Frigate live failed (check go2rtc_url, or CORS/mixed-content if the dashboard is on https).",
    edCamera: "Camera (live view, via ha-camera-stream)",
    edHost: "Frigate server (e.g. 192.168.1.11)",
    edPort: "Port",
    edFrigateCamera: "Camera in Frigate (e.g. spate)",
    edFrigateCameraSelect: "Camera in Frigate",
    edInstance: "Frigate instance id (default: frigate)",
    edHeight: "Timeline strip height (px)",
    edZoom: "Default zoom (hours)",
    edAutohide: "Auto-hide timeline (seconds of inactivity, 0 = disabled)",
    edLiveSource: "Live source",
    edLiveSourceHa: "Home Assistant (ha-camera-stream, default)",
    edLiveSourceFrigate: "Direct Frigate (go2rtc, bypass HA WebRTC)",
    edGo2rtcUrl: "go2rtc URL (default: Frigate host, port 1984)",
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
    this._config = { height: 44, frigate_instance_id: "frigate", default_zoom_hours: 10, auto_hide_seconds: 0, live_source: "ha", frigate_stream: "main", ...config };
    this._dayKey = todayKey();
    this._segments = [];
    this._events = [];
    this._fetchKey = null;
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
    // Lovelace calls this setter on every state-changed event across the
    // whole dashboard, which can be several times a second. Rebuilding the
    // track's DOM that often is wasted work and — combined with an
    // in-progress gesture — is what caused the original tap-does-nothing
    // bug on iOS. The 60s interval in connectedCallback still guarantees
    // the playhead advances even with no other hass traffic.
    const now = Date.now();
    if (now - (this._lastRenderTs || 0) > 3000) {
      this._lastRenderTs = now;
      this._renderTimeline();
    }
  }

  static getConfigElement() {
    return document.createElement("frigate-timeline-card-editor");
  }

  static getStubConfig(hass) {
    const cameraEntity = Object.keys(hass?.states || {}).find((id) => id.startsWith("camera."));
    return { camera_entity: cameraEntity || "", frigate_url: "", frigate_camera: "", height: 44 };
  }

  getCardSize() {
    return 6;
  }

  connectedCallback() {
    this._tickInterval = setInterval(() => this._renderTimeline(), PLAYHEAD_TICK_MS);
    // Cheap per-second tick — only moves/re-labels the now-pill, no bar
    // rebuild — so the clock reads live seconds like the reference UI.
    this._clockInterval = setInterval(() => this._updateNowPill(), 1000);
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
    this._teardownWebRtc();
    this._teardownHls();
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
        /* Extra right padding — the now-pill can sit right at the track's
           right edge (capped to "now" + 15min on today), and its own
           translateX(-50%) centering means half its width spills past
           that edge; without room there it gets clipped by ha-card's
           overflow:hidden. Left/bottom stay tight since nothing overflows
           there. */
        frigate-timeline-card .ftc-timeline { padding: 22px 40px 8px 10px; }
        frigate-timeline-card .ftc-trackwrap { position: relative; }
        frigate-timeline-card .ftc-track {
          position: relative; border-radius: 6px; overflow: hidden; cursor: pointer;
          background: #141414; touch-action: none;
        }
        frigate-timeline-card .ftc-bar {
          position: absolute; top: 50%; transform: translateY(-50%);
          height: 55%; min-width: 2px; border-radius: 2px; pointer-events: none;
        }
        frigate-timeline-card .ftc-bar.detect {
          background: var(--frigate-timeline-detect, #f2b632);
          box-shadow: 0 0 4px rgba(242, 182, 50, 0.5);
        }
        frigate-timeline-card .ftc-bar.alert {
          height: 85%;
          background: var(--frigate-timeline-alert, #ef4444);
          box-shadow: 0 0 6px rgba(239, 68, 68, 0.6);
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
    this.querySelectorAll(".ftc-navbtn").forEach((btn) => {
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

  _currentWindow() {
    const day = dayWindow(this._dayKey);
    if (!day) return { start: 0, end: 1 };
    // Never show more than 15 minutes of "future" past now on today — that
    // stretch is always empty (no data past now), so letting the window
    // extend toward midnight just wastes screen space. Zoom/pan/reset all
    // funnel through here, so the cap holds everywhere, not just on load.
    const dayEnd = this._dayKey === todayKey() ? Math.min(day.end, Date.now() + 15 * 60 * 1000) : day.end;
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
   * "Now" (or the tail end of the day, when browsing a past day) sits 10
   * minutes in from the window's right edge — not centered — so the window
   * reads mostly as "what just happened", with a small margin rather than
   * "now" pinned exactly at the edge. Called on initial load and whenever
   * the viewed day changes. */
  _resetZoom() {
    this._windowHours = this._defaultZoomHours();
    this._recenterToNow();
  }

  /** Repositions `_centerMs` so "now" (or the tail end of the day, on a
   * past day) sits 10 minutes in from the window's right edge, at
   * whatever `_windowHours` is currently set to — recentering without
   * touching zoom. Used by `_resetZoom()` (which also resets the zoom
   * level) and by `_showLive()` (which deliberately does NOT — jumping
   * back to live shouldn't discard a zoom level the user picked). */
  _recenterToNow() {
    const day = dayWindow(this._dayKey);
    const RIGHT_MARGIN_MS = 10 * 60 * 1000;
    const halfMs = ((this._windowHours || this._defaultZoomHours()) * 3600000) / 2;
    const anchorMs = Math.min(Date.now(), day.end);
    this._centerMs = anchorMs + RIGHT_MARGIN_MS - halfMs;
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
  _nearestEventStartMs(ts) {
    if (!this._events?.length) return ts;
    let best = null;
    let bestDist = Infinity;
    for (const ev of this._events) {
      const start = Number(ev.start_time) * 1000;
      if (!Number.isFinite(start)) continue;
      const dist = Math.abs(start - ts);
      if (dist < bestDist) {
        bestDist = dist;
        best = start;
      }
    }
    return best != null ? best : ts;
  }

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

    const fracFromEvent = (e) => {
      const rect = this._trackEl.getBoundingClientRect();
      if (!rect.width) return null;
      const x = e.clientX ?? e.touches?.[0]?.clientX;
      if (x == null) return null;
      return Math.min(1, Math.max(0, (x - rect.left) / rect.width));
    };

    const previewAt = (frac) => {
      const win = this._currentWindow();
      // Scrubbing goes wherever you drag — free positioning, not snapped to
      // an event. (Tap/click still snaps to the nearest event's start, via
      // _seekTo() — that's a deliberate difference: a tap is a single
      // decisive pick, a drag is exploratory and should go anywhere.)
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
        if (lastTs != null) this._playAt(lastTs);
      }, SCRUB_THROTTLE_MS);
    };

    this._nowLineEl.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      dragging = true;
      this._scrubbing = true;
      this._nowLineEl.classList.add("scrubbing");
      const frac = fracFromEvent(e);
      if (frac != null) scheduleSeek(previewAt(frac));
    });
    window.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const frac = fracFromEvent(e);
      if (frac == null) return;
      scheduleSeek(previewAt(frac));
    });
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      this._scrubbing = false;
      this._nowLineEl.classList.remove("scrubbing");
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      if (lastTs != null) this._playAt(lastTs);
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
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
    if (this._rtcPeerConnection) {
      try {
        this._rtcPeerConnection.close();
      } catch (_) {
        /* already closed */
      }
      this._rtcPeerConnection = null;
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
    liveBtn.addEventListener("click", () => this._showLive());

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
   * go2rtc; `frigate_stream` picks which (default "main"). */
  _go2rtcStreamName() {
    const suffix = this._config.frigate_stream || "main";
    return `${this._config.frigate_camera}_${suffix}`;
  }

  /**
   * Live view has two selectable sources (`live_source` config):
   *   - `"ha"` (default): `<ha-camera-stream>`, exactly the way the
   *     companion camera-gallery-card fork's proven-working live view does
   *     it. Goes through Home Assistant's own same-origin, already-secure
   *     connection — works over https (Tailscale, Nabu Casa, any TLS
   *     reverse proxy) without any mixed-content issue.
   *   - `"frigate"`: connects straight to Frigate's own bundled go2rtc
   *     instance over WebRTC, bypassing HA's `camera/webrtc/*` bridge
   *     entirely — opt-in, since it reintroduces the exact mixed-content
   *     failure mode `"ha"` was built to avoid (a raw `ws://<lan-ip>:1984`
   *     connection is blocked outright when the dashboard itself loads
   *     over https). Worth it for setups that are plain http/LAN-only,
   *     where it avoids HA's WebRTC bridge as an extra hop/point of
   *     failure. See `_showLiveViaGo2rtc()`.
   */
  async _showLive() {
    this._playingClip = null;
    this._pillMode = "live";
    // Returning to live should mean returning to "now" on the timeline too
    // — if the user was browsing a past day, jump the strip back to today
    // rather than leaving it stranded on a day with no live position to
    // show. Recenters on "now" at whatever zoom level was already set —
    // deliberately NOT a full _resetZoom(), which would also discard that
    // zoom level; only day + position should change here. Only runs when
    // actually on a different day, so tapping Live while already on today
    // doesn't disturb the current zoom/pan at all.
    if (this._dayKey !== todayKey()) {
      this._dayKey = todayKey();
      this._recenterToNow();
      this._updateDayNavState();
      this._ensureData();
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

  /** Direct go2rtc WebRTC signaling (WS handshake at `/api/webrtc?src=`),
   * the same protocol the companion camera-gallery-card fork uses. A plain
   * `<video>` this time (not a wrapper element), so play/pause and mute
   * bind normally via `_bindVideoControls`. */
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

    if (typeof RTCPeerConnection === "undefined") return;
    const go2rtcBase = this._go2rtcUrl();
    if (!go2rtcBase) return;
    const streamName = this._go2rtcStreamName();

    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      this._rtcPeerConnection = pc;
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.ontrack = (e) => {
        if (e.streams?.[0]) video.srcObject = e.streams[0];
      };

      const wsUrl = `${go2rtcBase.replace(/^http/, "ws")}/api/webrtc?src=${encodeURIComponent(streamName)}`;
      if (typeof location !== "undefined" && location.protocol === "https:" && wsUrl.startsWith("ws://")) {
        throw new Error(
          "Mixed content blocked: page is HTTPS but go2rtc is http://. Put go2rtc behind a TLS reverse proxy, or set go2rtc_url to an https:// address."
        );
      }

      const ws = new WebSocket(wsUrl);
      this._rtcWebSocket = ws;

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`go2rtc WS timeout after 10s (${wsUrl})`)), 10000);
        ws.onopen = async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: "webrtc/offer", value: pc.localDescription.sdp }));
          } catch (err) {
            reject(err);
          }
        };
        ws.onmessage = async (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            if (msg.type === "webrtc/answer") {
              await pc.setRemoteDescription({ type: "answer", sdp: msg.value });
              clearTimeout(timeout);
              resolve();
            } else if (msg.type === "webrtc/candidate") {
              pc.addIceCandidate({ candidate: msg.value, sdpMid: "0" }).catch(() => {});
            } else if (msg.type === "error") {
              clearTimeout(timeout);
              reject(new Error(`go2rtc reported: ${msg.value}`));
            }
          } catch (err) {
            reject(err);
          }
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("go2rtc WS error"));
        };
        ws.onclose = (e) => {
          if (e.code !== 1000) {
            clearTimeout(timeout);
            reject(new Error(`go2rtc WS closed (code ${e.code})`));
          }
        };
      });
      if (token !== this._liveToken) return;

      pc.onicecandidate = (e) => {
        if (e.candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "webrtc/candidate", value: e.candidate.candidate }));
        }
      };
    } catch (err) {
      console.warn("[frigate-timeline-card] go2rtc live view failed", err);
      if (token === this._liveToken) {
        this._showStageError(
          this._t("liveFrigateError")
        );
      }
    }
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
  _playAt(tsMs) {
    const camId = this._cameraObjectId();
    const base = this._config.frigate_url.replace(/\/+$/, "");
    const nowSec = Math.floor(Date.now() / 1000);
    let startSec = Math.floor(tsMs / 1000) - 20;
    // Clamp the end a few seconds behind "now" — Frigate needs a moment to
    // finalize very recent segments, and asking for a range that partly
    // doesn't exist yet is exactly what made playback choppy/stuck when
    // tapping near the live edge of the timeline.
    let endSec = Math.min(Math.floor(tsMs / 1000) + 40, nowSec - 5);
    if (endSec <= startSec) endSec = startSec + 15;
    const hlsUrl = `${base}/vod/${camId}/start/${startSec}/end/${endSec}/index.m3u8`;
    const mp4Url = `${base}/${camId}/start/${startSec}/end/${endSec}/clip.mp4`;

    this._playingClip = { url: hlsUrl, tsMs };
    this._pillMode = "clip";
    this._clipStartSec = startSec;
    this._clipCurrentMs = tsMs;
    this._liveToken = (this._liveToken || 0) + 1; // invalidate any in-flight _showLive()
    this._teardownWebRtc();
    this._teardownHls();
    this._stageEl.innerHTML = "";
    this._streamEl = null;

    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true; // starts muted, same as live — consistent across play/live/timeline; mute button toggles it
    video.playsInline = true;
    video.controls = false; // controls live in the shared bar below — never native
    video.addEventListener("timeupdate", () => {
      this._clipCurrentMs = (this._clipStartSec + video.currentTime) * 1000;
      this._updateNowPill();
    });

    const canPlayNativeHls = !!video.canPlayType("application/vnd.apple.mpegurl");

    const tryHlsJs = () => {
      const attach = () => {
        if (!window.Hls?.isSupported()) {
          this._showStageError(this._t("clipLoadError"));
          return;
        }
        const hls = new window.Hls({ maxBufferLength: 30, backBufferLength: 30 });
        hls.loadSource(hlsUrl);
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

    video.src = canPlayNativeHls ? hlsUrl : mp4Url;
    this._stageEl.appendChild(video);
    this._bindVideoControls(video);

    // Best-effort correction, fired in parallel — never awaited before
    // starting playback above, since delaying video creation would push it
    // outside the synchronous click handler and risk losing the user-
    // gesture autoplay-with-sound allowance.
    this._correctClipStartSec(camId, base, startSec);
  }

  /**
   * Frigate stores recordings in ~10s segments, split only on keyframes —
   * it can't start a VOD/clip response at the exact requested `start`
   * second, only at the nearest segment boundary. Our pill time assumes
   * `video.currentTime === 0` lines up with the requested `startSec`
   * exactly, which is off by however far that boundary actually was —
   * visible as a mismatch against a camera's own burned-in timestamp
   * overlay. Fetches the real segment list around the requested time and
   * corrects `_clipStartSec` to the segment's true `start_time` once known.
   *
   * Best-effort: many self-hosted Frigate instances don't send
   * `Access-Control-Allow-Origin` (the same CORS gap that broke direct clip
   * playback before the native-`<video>` fix), so this REST call can fail —
   * caught and silently ignored, leaving the original requested-time
   * approximation in place.
   */
  async _correctClipStartSec(camId, base, requestedStartSec) {
    const clipToken = this._playingClip;
    try {
      const after = requestedStartSec - 1;
      const before = requestedStartSec + 11; // ~one segment of margin either side
      const res = await fetch(`${base}/${camId}/recordings?after=${after}&before=${before}`);
      if (!res.ok) return;
      const segments = await res.json();
      if (this._playingClip !== clipToken) return; // superseded by a newer seek/live
      if (!Array.isArray(segments) || !segments.length) return;
      let best = null;
      let bestDist = Infinity;
      for (const seg of segments) {
        const segStart = Number(seg.start_time);
        const segEnd = Number(seg.end_time);
        if (!Number.isFinite(segStart)) continue;
        if (Number.isFinite(segEnd) && requestedStartSec >= segStart && requestedStartSec <= segEnd) {
          best = segStart;
          break;
        }
        const dist = Math.abs(segStart - requestedStartSec);
        if (dist < bestDist) {
          bestDist = dist;
          best = segStart;
        }
      }
      if (best != null) this._clipStartSec = best;
    } catch (err) {
      console.warn("[frigate-timeline-card] recordings lookup unavailable (CORS or unreachable) — pill time is an approximation", err);
    }
  }

  _seekTo(frac) {
    const win = this._currentWindow();
    const raw = win.start + frac * (win.end - win.start);
    this._playAt(this._nearestEventStartMs(raw));
  }

  async _ensureData() {
    const base = this._config.frigate_url.replace(/\/+$/, "");
    const win = dayWindow(this._dayKey);
    const key = `${base}|${this._dayKey}|${this._config.frigate_camera || ""}`;
    if (this._fetchKey === key) return;
    this._fetchKey = key;

    const camId = this._cameraObjectId();
    const afterSec = Math.floor(win.start / 1000);
    const beforeSec = Math.ceil(win.end / 1000);

    // Same priority the companion camera-gallery-card fork uses: WS first
    // (same-origin through HA, always reachable regardless of how the
    // dashboard itself is being accessed — LAN http, Tailscale https,
    // whatever), REST second as a fast-path enhancement when it happens to
    // be reachable. Doing REST first (as this card did originally) meant
    // events silently vanished under mixed-content blocking (dashboard
    // served https, frigate_url is a plain http:// LAN address) with no
    // visible error — exactly what broke playback and event display here.
    let events = null;
    if (this._hass?.connection) {
      try {
        let wsResult = await this._hass.connection.sendMessagePromise({
          type: "frigate/events/get",
          instance_id: this._config.frigate_instance_id,
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
        console.warn("[frigate-timeline-card] REST /api/events unavailable (CORS or mixed-content) — using WS result only", err);
      }
    }

    // /api/review has no WS equivalent — REST is the only source for exact
    // severity. Falls back to approximating from `events` (already fetched
    // above, WS-first) when REST is unreachable.
    let reviews = null;
    try {
      const res = await fetch(`${base}/api/review?after=${afterSec}&before=${beforeSec}`);
      if (res.ok) reviews = await res.json();
    } catch (err) {
      console.warn("[frigate-timeline-card] REST /api/review unavailable (CORS or mixed-content) — approximating from events", err);
    }

    if (this._fetchKey !== key) return; // a newer fetch superseded this one

    this._events = (Array.isArray(events) ? events : []).filter((ev) => ev.camera === camId);

    if (Array.isArray(reviews)) {
      this._segments = reviews
        .filter((r) => r.camera === camId && Number.isFinite(Number(r.start_time)))
        .map((r) => ({
          start: Number(r.start_time) * 1000,
          end: Number.isFinite(Number(r.end_time)) ? Number(r.end_time) * 1000 : Date.now(),
          severity: r.severity === "alert" ? "alert" : "detection",
        }));
    } else {
      // No REST review data (CORS-blocked or Frigate unreachable directly) —
      // approximate severity from the event list instead, whichever source
      // it came from.
      this._segments = this._events.map((ev) => {
        const startMs = Number(ev.start_time) * 1000;
        const endSec = Number(ev.end_time);
        const endMs = Number.isFinite(endSec) ? endSec * 1000 : startMs + 10000;
        return { start: startMs, end: endMs, severity: approximateSeverity(ev) };
      });
    }
    this._renderTimeline();
  }

  /** Formats a Date as "20:56:54" — 24h, used for the now-pill. */
  _formatClock(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  _updateNowPill() {
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

  _renderTimeline() {
    if (!this._trackEl) return;
    const win = this._currentWindow();
    const span = win.end - win.start;
    if (!(span > 0)) return;

    // Histogram-style marks (like the reference UI): a thin bar per event,
    // gold for a plain detection, taller/red for an alert. No filler block
    // for empty stretches — the dark track itself reads as "nothing here".
    let barsHtml = "";
    for (const s of this._segments) {
      const st = Math.max(s.start, win.start);
      const en = Math.min(s.end, win.end);
      if (en <= st) continue;
      const left = ((st - win.start) / span) * 100;
      const width = Math.max(((en - st) / span) * 100, 0.15);
      const cls = s.severity === "alert" ? "alert" : "detect";
      // Trim a fixed couple of px off each bar's width (not a % — stays a
      // constant, barely-there gap at any zoom level) so back-to-back
      // events read as distinct bars, matching Frigate's own timeline,
      // instead of fusing into one indistinguishable block when they
      // happen to touch or nearly touch in time.
      barsHtml += `<div class="ftc-bar ${cls}" style="left:${left}%;width:max(1px, calc(${width}% - 2px));"></div>`;
    }
    this._trackEl.innerHTML = barsHtml;
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
      frigate_stream: "main",
      ...config,
    };
    if (!this._built) this._build();
    this._sync();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (this._entityPicker) this._entityPicker.hass = hass;
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
    if (this._entityPicker) this._entityPicker.label = this._t("edCamera");
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
        <div id="ftc-ed-entity"></div>
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
        <label class="ftc-ed-field">
          <span data-i18n="edInstance">Frigate instance id (implicit: frigate)</span>
          <input id="ftc-ed-instance" type="text" />
        </label>
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
          <span data-i18n="edLiveSource">Sursă live</span>
          <select id="ftc-ed-live-source">
            <option value="ha" data-i18n="edLiveSourceHa">Home Assistant (ha-camera-stream, implicit)</option>
            <option value="frigate" data-i18n="edLiveSourceFrigate">Frigate direct (go2rtc, bypass HA WebRTC)</option>
          </select>
        </label>
        <div id="ftc-ed-go2rtc-row" style="display:flex;flex-direction:column;gap:16px;">
          <div class="ftc-ed-row">
            <label class="ftc-ed-field" style="flex:2">
              <span data-i18n="edGo2rtcUrl">go2rtc URL (implicit: host Frigate, port 1984)</span>
              <input id="ftc-ed-go2rtc-url" type="text" placeholder="http://192.168.1.11:1984" />
            </label>
            <label class="ftc-ed-field" style="flex:1">
              <span data-i18n="edStream">Stream</span>
              <select id="ftc-ed-frigate-stream">
                <option value="main">main</option>
                <option value="sub">sub</option>
              </select>
            </label>
          </div>
        </div>
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
    const entityRow = this.querySelector("#ftc-ed-entity");
    const picker = document.createElement("ha-entity-picker");
    picker.includeDomains = ["camera"];
    picker.label = this._t("edCamera");
    picker.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      this._update("camera_entity", e.detail.value);
    });
    entityRow.appendChild(picker);
    this._entityPicker = picker;

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
    this.querySelector("#ftc-ed-instance").addEventListener("input", (e) => this._update("frigate_instance_id", e.target.value));
    this.querySelector("#ftc-ed-height").addEventListener("input", (e) => this._update("height", Number(e.target.value) || 44));
    this.querySelector("#ftc-ed-zoom").addEventListener("input", (e) =>
      this._update("default_zoom_hours", Math.min(24, Math.max(0.25, Number(e.target.value) || 10)))
    );
    this.querySelector("#ftc-ed-autohide").addEventListener("input", (e) =>
      this._update("auto_hide_seconds", Math.max(0, Number(e.target.value) || 0))
    );
    this.querySelector("#ftc-ed-live-source").addEventListener("change", (e) => this._update("live_source", e.target.value));
    this.querySelector("#ftc-ed-go2rtc-url").addEventListener("input", (e) => this._update("go2rtc_url", e.target.value));
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

  /** Fetches Frigate's real camera list (from /api/config) and swaps the
   * free-text "frigate_camera" field for a dropdown once it succeeds.
   * Silently keeps the text field as a fallback if the fetch fails
   * (e.g. CORS). */
  async _fetchFrigateCameraList() {
    const url = this._config.frigate_url;
    if (!url) return;
    const base = String(url).replace(/\/+$/, "");
    const token = (this._camFetchToken = (this._camFetchToken || 0) + 1);
    try {
      const res = await fetch(`${base}/api/config`);
      if (res.ok) {
        const cfg = await res.json();
        if (token !== this._camFetchToken) return;
        const names = Object.keys(cfg?.cameras || {});
        if (names.length) {
          this._frigateCameraNames = names;
          this._renderCameraField();
          return;
        }
      }
    } catch (_) {
      // CORS-blocked or unreachable — most self-hosted Frigate instances
      // don't send Access-Control-Allow-Origin. Fall through to the WS
      // route below instead of leaving the plain text field as the only
      // option.
    }
    await this._fetchFrigateCameraListViaWs(token);
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
    if (!this._hass?.connection) return;
    try {
      let result = await this._hass.connection.sendMessagePromise({
        type: "frigate/events/get",
        instance_id: this._config.frigate_instance_id || "frigate",
        after: Math.floor(Date.now() / 1000) - 7 * 24 * 3600,
        before: Math.floor(Date.now() / 1000),
        limit: 500,
      });
      if (typeof result === "string") result = JSON.parse(result);
      if (token !== this._camFetchToken) return;
      if (!Array.isArray(result)) return;
      const names = [...new Set(result.map((ev) => ev.camera).filter(Boolean))].sort();
      if (!names.length) return;
      this._frigateCameraNames = names;
      this._renderCameraField();
    } catch (err) {
      console.warn("[frigate-timeline-card] WS camera discovery failed", err);
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
    if (this._entityPicker) {
      this._entityPicker.value = this._config.camera_entity || "";
      if (this._hass) this._entityPicker.hass = this._hass;
    }
    const set = (id, val) => {
      const el = this.querySelector(id);
      if (el && el.value !== String(val ?? "")) el.value = val ?? "";
    };
    const { host, port } = this._parseFrigateUrl(this._config.frigate_url);
    set("#ftc-ed-host", host);
    set("#ftc-ed-port", port);
    if (!this._frigateCameraNames?.length) set("#ftc-ed-camera", this._config.frigate_camera);
    set("#ftc-ed-instance", this._config.frigate_instance_id);
    set("#ftc-ed-height", this._config.height ?? 44);
    set("#ftc-ed-zoom", this._config.default_zoom_hours ?? 10);
    set("#ftc-ed-autohide", this._config.auto_hide_seconds ?? 0);
    set("#ftc-ed-live-source", this._config.live_source || "ha");
    set("#ftc-ed-go2rtc-url", this._config.go2rtc_url ?? "");
    set("#ftc-ed-frigate-stream", this._config.frigate_stream || "main");
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
