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
 *   camera_entity: camera.camera_spate      # required — HA camera entity, for the ha-camera-stream live view
 *   frigate_url: http://192.168.1.11:5000   # required — Frigate REST base (events enhancement + clip playback; needs http/LAN reachability from the browser)
 *   frigate_camera: spate                   # required — Frigate's own camera name, for scoping events/review data
 *   frigate_instance_id: frigate            # optional — Frigate HA integration config-entry id, for the events WS call (default "frigate")
 *   height: 44                              # optional — timeline strip height in px
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
  setConfig(config) {
    if (!config.frigate_url) {
      throw new Error("frigate-timeline-card: 'frigate_url' is required");
    }
    if (!config.frigate_camera) {
      throw new Error("frigate-timeline-card: 'frigate_camera' is required");
    }
    if (!config.camera_entity) {
      throw new Error("frigate-timeline-card: 'camera_entity' is required (for live view via ha-camera-stream)");
    }
    this._config = { height: 44, frigate_instance_id: "frigate", default_zoom_hours: 10, ...config };
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
        frigate-timeline-card .ftc-timeline { padding: 22px 10px 8px; }
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
    if (!this._windowHours || this._windowHours >= 24) return day;
    const half = (this._windowHours * 3600000) / 2;
    const center = this._centerMs ?? day.start + (day.end - day.start) / 2;
    let start = center - half;
    let end = center + half;
    if (start < day.start) {
      end += day.start - start;
      start = day.start;
    }
    if (end > day.end) {
      start -= end - day.end;
      end = day.end;
    }
    start = Math.max(start, day.start);
    end = Math.min(end, day.end);
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
    const day = dayWindow(this._dayKey);
    const RIGHT_MARGIN_MS = 10 * 60 * 1000;
    const halfMs = (this._windowHours * 3600000) / 2;
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
      const raw = win.start + frac * (win.end - win.start);
      // Scrubbing snaps to the nearest event's start — landing on an exact
      // arbitrary drag position is far less useful than landing where
      // something actually happened, since most of the timeline is empty.
      const ts = this._nearestEventStartMs(raw);
      const pct = Math.min(100, Math.max(0, ((ts - win.start) / (win.end - win.start)) * 100));
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
    playBtn.title = "Play/Pause";
    playBtn.addEventListener("click", () => {
      if (!this._videoEl) return;
      if (this._videoEl.paused) this._videoEl.play().catch(() => {});
      else this._videoEl.pause();
    });

    const muteBtn = document.createElement("button");
    muteBtn.className = "ftc-ctlbtn";
    muteBtn.innerHTML = ICON_VOLUME_OFF;
    muteBtn.title = "Mute/Unmute";
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
    fsBtn.title = "Fullscreen";
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
    liveBtn.innerHTML = '<span class="ftc-live-dot"></span>Live';
    liveBtn.title = "Revino la live";
    liveBtn.addEventListener("click", () => this._showLive());

    bar.append(playBtn, muteBtn, fsBtn, liveBtn);
    this._playBtnEl = playBtn;
    this._muteBtnEl = muteBtn;
    this._liveBtnEl = liveBtn;

    // Timeline show/hide lives next to the day selector, not with the
    // playback controls — it toggles the day-nav row's own sibling
    // section, so it reads more naturally grouped with day navigation.
    const daynav = this.querySelector(".ftc-daynav");
    const timelineToggleBtn = document.createElement("button");
    timelineToggleBtn.className = "ftc-navbtn";
    timelineToggleBtn.innerHTML = ICON_CHEVRON_UP;
    timelineToggleBtn.title = "Ascunde/afișează timeline";
    timelineToggleBtn.addEventListener("click", () => {
      if (!this._timelineEl) return;
      const hidden = this._timelineEl.style.display === "none";
      this._timelineEl.style.display = hidden ? "" : "none";
      timelineToggleBtn.innerHTML = hidden ? ICON_CHEVRON_UP : ICON_CHEVRON_DOWN;
    });
    daynav?.appendChild(timelineToggleBtn);
  }

  /**
   * Live view uses `<ha-camera-stream>`, exactly the way the companion
   * camera-gallery-card fork's proven-working live view does it — same
   * element, same properties, same `customElements.whenDefined()` await
   * before creating it.
   *
   * A prior version of this card connected straight to Frigate's go2rtc
   * over a raw `ws://<lan-ip>:1984/...` — that only works when the
   * dashboard itself is loaded over plain http. The moment it's accessed
   * over https (Tailscale, Nabu Casa, any TLS reverse proxy — a very
   * common setup, not an edge case), the browser blocks that connection
   * outright as mixed content, with no visible error: live view (and, for
   * the same reason, direct HLS clip playback and REST event/review
   * fetches) just silently stopped working. `<ha-camera-stream>` doesn't
   * have this problem because it goes through Home Assistant's own
   * same-origin, already-secure connection rather than a raw fetch/WS to
   * the camera's LAN address.
   */
  async _showLive() {
    this._playingClip = null;
    this._pillMode = "live";
    // Returning to live should mean returning to "now" on the timeline too
    // — if the user was browsing a past day, jump the strip back to today
    // rather than leaving it stranded on a day with no live position to
    // show. Only resets when actually on a different day, so tapping Live
    // while already on today doesn't disturb the current zoom/pan.
    if (this._dayKey !== todayKey()) {
      this._dayKey = todayKey();
      this._resetZoom();
      this._updateDayNavState();
      this._ensureData();
    }
    const token = (this._liveToken = (this._liveToken || 0) + 1);
    this._teardownWebRtc();
    this._teardownHls();
    this._stageEl.innerHTML = "";
    this._streamEl = null;

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
          this._showStageError(
            "Nu s-a putut încărca clipul de la Frigate — verifică CORS (Access-Control-Allow-Origin) pe server."
          );
          return;
        }
        const hls = new window.Hls({ maxBufferLength: 30, backBufferLength: 30 });
        hls.loadSource(hlsUrl);
        hls.attachMedia(video);
        hls.on(window.Hls.Events.ERROR, (_evt, data) => {
          if (!data?.fatal) return;
          console.warn("[frigate-timeline-card] hls.js fatal error", data);
          this._teardownHls();
          this._showStageError(
            "Nu s-a putut încărca clipul de la Frigate — verifică CORS (Access-Control-Allow-Origin) pe server."
          );
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

  /** Formats a Date as "8:56:54 PM" style — matches the reference now-pill. */
  _formatClock(d) {
    let h = d.getHours();
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${ampm}`;
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
      barsHtml += `<div class="ftc-bar ${cls}" style="left:${left}%;width:${width}%;"></div>`;
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
        ? "Astăzi"
        : new Date(win.start).toLocaleDateString(this._hass?.locale?.language || undefined, {
            day: "numeric",
            month: "short",
          });
    }
  }
}

class FrigateTimelineCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { height: 44, frigate_instance_id: "frigate", default_zoom_hours: 10, ...config };
    if (!this._built) this._build();
    this._sync();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._entityPicker) this._entityPicker.hass = hass;
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
            <span>Server Frigate (ex: 192.168.1.11)</span>
            <input id="ftc-ed-host" type="text" />
          </label>
          <label class="ftc-ed-field" style="flex:1">
            <span>Port</span>
            <input id="ftc-ed-port" type="number" />
          </label>
        </div>
        <div id="ftc-ed-camera-row">
          <label class="ftc-ed-field">
            <span>Cameră în Frigate (ex: spate)</span>
            <input id="ftc-ed-camera" type="text" />
          </label>
        </div>
        <label class="ftc-ed-field">
          <span>Frigate instance id (implicit: frigate)</span>
          <input id="ftc-ed-instance" type="text" />
        </label>
        <div class="ftc-ed-row">
          <label class="ftc-ed-field" style="flex:1">
            <span>Înălțime timeline (px)</span>
            <input id="ftc-ed-height" type="number" />
          </label>
          <label class="ftc-ed-field" style="flex:1">
            <span>Zoom implicit (ore)</span>
            <input id="ftc-ed-zoom" type="number" step="0.25" min="0.25" max="24" />
          </label>
        </div>
      </div>
      <style>
        frigate-timeline-card-editor .ftc-ed-form { display: flex; flex-direction: column; gap: 16px; padding: 8px 2px 16px; }
        frigate-timeline-card-editor .ftc-ed-row { display: flex; gap: 8px; }
        frigate-timeline-card-editor .ftc-ed-field {
          display: flex; flex-direction: column; gap: 4px; flex: 1;
          font-size: 12px; color: var(--secondary-text-color, #999);
        }
        frigate-timeline-card-editor .ftc-ed-field input {
          font: inherit; font-size: 15px; color: var(--primary-text-color, #fff);
          background: var(--card-background-color, transparent);
          border: 1px solid var(--divider-color, rgba(127, 127, 127, 0.4));
          border-radius: 6px; padding: 8px 10px; width: 100%; box-sizing: border-box;
        }
        frigate-timeline-card-editor .ftc-ed-field input:focus {
          outline: none; border-color: var(--primary-color, #03a9f4);
        }
        frigate-timeline-card-editor .ftc-ed-field select { font: inherit; }
      </style>
    `;
    const entityRow = this.querySelector("#ftc-ed-entity");
    const picker = document.createElement("ha-entity-picker");
    picker.includeDomains = ["camera"];
    picker.label = "Cameră (live view, via ha-camera-stream)";
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
      if (!res.ok) return;
      const cfg = await res.json();
      if (token !== this._camFetchToken) return;
      const names = Object.keys(cfg?.cameras || {});
      if (!names.length) return;
      this._frigateCameraNames = names;
      this._renderCameraField();
    } catch (_) {
      // CORS-blocked or unreachable — the plain text field stays as-is.
    }
  }

  _renderCameraField() {
    const row = this.querySelector("#ftc-ed-camera-row");
    if (!row || !this._frigateCameraNames?.length) return;
    row.innerHTML = `
      <label class="ftc-ed-field">
        <span>Cameră în Frigate</span>
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
