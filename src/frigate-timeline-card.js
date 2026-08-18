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
 * Recorded-clip playback goes through hls.js — bundled directly into this
 * file, not loaded from a CDN — even on Safari, via MediaSource Extensions,
 * rather than handing Safari a raw .m3u8 (native HLS playback on Safari/
 * iOS/macOS shows its own AirPlay/fullscreen chrome unconditionally,
 * exactly the native player this card exists to avoid).
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
  if (ALERT_LABEL_RE.test(label) && (label.endsWith("-verified") || score >= ALERT_SCORE_THRESHOLD)) {
    return "alert";
  }
  return "detection";
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
    this._config = { height: 44, frigate_instance_id: "frigate", ...config };
    this._dayKey = todayKey();
    this._segments = [];
    this._events = [];
    this._fetchKey = null;
    if (!this._built) this._build();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    // ha-camera-stream needs `hass`/`stateObj` for the live view, and the
    // events fallback needs `hass.connection` — both gated on its first
    // arrival, since `_build()` runs before `hass` exists at all.
    if (first && !this._playingClip) this._showLive();
    if (this._streamEl?.tagName === "HA-CAMERA-STREAM") {
      this._streamEl.hass = hass;
      this._streamEl.stateObj = hass.states?.[this._config.camera_entity];
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

  _cameraObjectId() {
    return this._config.frigate_camera;
  }

  _build() {
    this._built = true;
    this.innerHTML = `
      <ha-card>
        <div class="ftc-stage"></div>
        <div class="ftc-controlbar"></div>
        <div class="ftc-daynav">
          <button class="ftc-navbtn" data-dir="-1" title="Previous day">‹</button>
          <span class="ftc-daylabel"></span>
          <button class="ftc-navbtn" data-dir="1" title="Next day">›</button>
          <span class="ftc-navspacer"></span>
          <button class="ftc-zoombtn" data-zoom="out" title="Zoom out">−</button>
          <span class="ftc-zoomlabel"></span>
          <button class="ftc-zoombtn" data-zoom="in" title="Zoom in">+</button>
          <button class="ftc-zoombtn" data-zoom="reset" title="Reset zoom">⤢</button>
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
        frigate-timeline-card .ftc-controlbar {
          display: flex; align-items: center; gap: 4px; padding: 6px 8px;
          background: var(--card-background-color, #1c1c1c);
          border-bottom: 1px solid rgba(127, 127, 127, 0.15);
        }
        frigate-timeline-card .ftc-ctlbtn {
          background: none; border: none; color: var(--primary-text-color, #fff);
          font-size: 16px; line-height: 1; cursor: pointer; padding: 6px 10px; border-radius: 6px;
        }
        frigate-timeline-card .ftc-ctlbtn:hover { background: rgba(127, 127, 127, 0.15); }
        frigate-timeline-card .ftc-ctl-spacer { flex: 1; }
        frigate-timeline-card .ftc-live-btn {
          font-size: 12px; font-weight: 700; letter-spacing: 0.02em; opacity: 0.4;
        }
        frigate-timeline-card .ftc-live-btn.active { opacity: 1; }
        frigate-timeline-card .ftc-daynav {
          display: flex; align-items: center; justify-content: center; gap: 6px;
          padding: 6px 10px 0; font-size: 13px; color: var(--primary-text-color, #fff);
        }
        frigate-timeline-card .ftc-daylabel { padding: 0 4px; }
        frigate-timeline-card .ftc-navspacer { width: 12px; }
        frigate-timeline-card .ftc-navbtn, frigate-timeline-card .ftc-zoombtn {
          background: none; border: none; color: inherit; font-size: 16px; line-height: 1;
          cursor: pointer; padding: 3px 9px; border-radius: 6px;
        }
        frigate-timeline-card .ftc-navbtn:hover, frigate-timeline-card .ftc-zoombtn:hover {
          background: rgba(127, 127, 127, 0.15);
        }
        frigate-timeline-card .ftc-zoomlabel {
          font-size: 11px; color: var(--secondary-text-color, #999); min-width: 30px; text-align: center;
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
          position: absolute; top: -8px; bottom: 0; width: 0;
          border-left: 1px dashed rgba(255, 255, 255, 0.5);
          transform: translateX(-50%); pointer-events: none; z-index: 3;
        }
        frigate-timeline-card .ftc-now-line.clip { border-left-color: rgba(79, 195, 247, 0.7); }
        frigate-timeline-card .ftc-scrub {
          position: absolute; top: 0; bottom: 0; width: 2px; background: #4fc3f7;
          box-shadow: 0 0 6px rgba(79, 195, 247, 0.9); pointer-events: none;
        }
        frigate-timeline-card .ftc-ticks {
          position: relative; height: 16px; font-size: 10px;
          color: var(--secondary-text-color, #999); margin-top: 2px;
        }
        frigate-timeline-card .ftc-tick { position: absolute; transform: translateX(-50%); white-space: nowrap; }
      </style>
    `;
    this._stageEl = this.querySelector(".ftc-stage");
    this._trackEl = this.querySelector(".ftc-track");
    this._ticksEl = this.querySelector(".ftc-ticks");
    this._dayLabelEl = this.querySelector(".ftc-daylabel");
    this._nowPillEl = this.querySelector(".ftc-now-pill");
    this._nowLineEl = this.querySelector(".ftc-now-line");
    this._zoomLabelEl = this.querySelector(".ftc-zoomlabel");
    this._trackEl.style.height = `${this._config.height}px`;
    this._buildControlBar();
    this._wireTrackInteraction();
    this.querySelectorAll(".ftc-navbtn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._dayKey = shiftDayKey(this._dayKey, Number(btn.dataset.dir));
        this._resetZoom();
        this._ensureData();
      });
    });
    this.querySelectorAll(".ftc-zoombtn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const mode = btn.dataset.zoom;
        if (mode === "reset") {
          this._resetZoom();
          return;
        }
        const win = this._currentWindow();
        const center = win.start + (win.end - win.start) / 2;
        this._applyZoom(this._windowHours * (mode === "in" ? 1 / 1.6 : 1.6), center);
      });
    });
    this._updateZoomLabel();
    this._showLive();
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

  _resetZoom() {
    this._windowHours = 24;
    this._centerMs = null;
    this._updateZoomLabel();
    this._renderTimeline();
  }

  _updateZoomLabel() {
    if (!this._zoomLabelEl) return;
    const h = this._windowHours || 24;
    this._zoomLabelEl.textContent = h >= 24 ? "24h" : h >= 1 ? `${h % 1 === 0 ? h : h.toFixed(1)}h` : `${Math.round(h * 60)}m`;
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
    video.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    const syncPlay = () => {
      if (this._playBtnEl) this._playBtnEl.textContent = video.paused ? "▶" : "⏸";
    };
    const syncMute = () => {
      if (this._muteBtnEl) this._muteBtnEl.textContent = video.muted ? "🔇" : "🔊";
    };
    video.addEventListener("play", syncPlay);
    video.addEventListener("pause", syncPlay);
    video.addEventListener("volumechange", syncMute);
    syncPlay();
    syncMute();
    if (this._liveBtnEl) this._liveBtnEl.classList.toggle("active", this._pillMode !== "live");
  }

  /** Builds the shared control bar once — play/pause, mute, fullscreen,
   * and "back to live" — wired generically against `this._videoEl`, so the
   * same buttons keep working across live ↔ clip swaps without rebuilding. */
  _buildControlBar() {
    const bar = this.querySelector(".ftc-controlbar");
    const playBtn = document.createElement("button");
    playBtn.className = "ftc-ctlbtn";
    playBtn.textContent = "▶";
    playBtn.title = "Play/Pause";
    playBtn.addEventListener("click", () => {
      if (!this._videoEl) return;
      if (this._videoEl.paused) this._videoEl.play().catch(() => {});
      else this._videoEl.pause();
    });

    const muteBtn = document.createElement("button");
    muteBtn.className = "ftc-ctlbtn";
    muteBtn.textContent = "🔊";
    muteBtn.title = "Mute/Unmute";
    muteBtn.addEventListener("click", () => {
      // Clip mode: this._videoEl is a plain <video>. Live mode: it's null
      // (ha-camera-stream isn't a <video>) — toggle the stream element's
      // own public `.muted` property instead.
      const target = this._videoEl || this._streamEl;
      if (!target) return;
      target.muted = !target.muted;
      muteBtn.textContent = target.muted ? "🔇" : "🔊";
    });

    const fsBtn = document.createElement("button");
    fsBtn.className = "ftc-ctlbtn";
    fsBtn.textContent = "⛶";
    fsBtn.title = "Fullscreen";
    fsBtn.addEventListener("click", () => {
      const doc = document;
      const isFs = doc.fullscreenElement || doc.webkitFullscreenElement;
      if (isFs) {
        (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc);
        return;
      }
      const el = this._stageEl;
      if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      else if (this._videoEl?.webkitEnterFullscreen) this._videoEl.webkitEnterFullscreen(); // iPhone Safari
    });

    const spacer = document.createElement("span");
    spacer.className = "ftc-ctl-spacer";

    const liveBtn = document.createElement("button");
    liveBtn.className = "ftc-ctlbtn ftc-live-btn";
    liveBtn.textContent = "🔴 Live";
    liveBtn.title = "Revino la live";
    liveBtn.addEventListener("click", () => this._showLive());

    bar.append(playBtn, muteBtn, fsBtn, spacer, liveBtn);
    this._playBtnEl = playBtn;
    this._muteBtnEl = muteBtn;
    this._liveBtnEl = liveBtn;
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
    const token = (this._liveToken = (this._liveToken || 0) + 1);
    this._teardownWebRtc();
    this._teardownHls();
    this._stageEl.innerHTML = "";
    this._streamEl = null;

    if (!this._hass || !this._config.camera_entity) return;
    await customElements.whenDefined("ha-camera-stream");
    if (token !== this._liveToken) return;

    const player = document.createElement("ha-camera-stream");
    player.stateObj = this._hass.states?.[this._config.camera_entity];
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
    if (this._muteBtnEl) this._muteBtnEl.textContent = player.muted ? "🔇" : "🔊";
    if (this._liveBtnEl) this._liveBtnEl.classList.toggle("active", false);
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
   * Plays a short window of *recorded* footage centered on `tsMs`, via
   * Frigate's `/vod/<camera>/start/<start>/end/<end>/index.m3u8` HLS
   * endpoint — real segmented streaming, not a single `clip.mp4` download.
   * That distinction matters: a Frigate "clip" spans a whole review item,
   * which for a long continuous presence can be many minutes and tens to
   * hundreds of MB — playing it as one non-seekable `<video src>` file is
   * what made tapping the timeline effectively a no-op (the browser just
   * sat there trying to buffer it). VOD HLS is exactly what Frigate's own
   * UI uses for timeline scrubbing, and works for ANY point in time, not
   * only points that happen to land on a detected event.
   */
  _playAt(tsMs) {
    const camId = this._cameraObjectId();
    const base = this._config.frigate_url.replace(/\/+$/, "");
    const nowSec = Math.floor(Date.now() / 1000);
    let startSec = Math.floor(tsMs / 1000) - 20;
    // Clamp the end a few seconds behind "now" — Frigate needs a moment to
    // finalize very recent segments, and asking HLS for a range that
    // partly doesn't exist yet is exactly what made playback choppy/stuck
    // when tapping near the live edge of the timeline.
    let endSec = Math.min(Math.floor(tsMs / 1000) + 40, nowSec - 5);
    if (endSec <= startSec) endSec = startSec + 15;
    const url = `${base}/vod/${camId}/start/${startSec}/end/${endSec}/index.m3u8`;

    this._playingClip = { url, tsMs };
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
    video.muted = false;
    video.playsInline = true;
    video.controls = false; // controls live in the shared bar below — never native
    video.addEventListener("timeupdate", () => {
      this._clipCurrentMs = (this._clipStartSec + video.currentTime) * 1000;
      this._updateNowPill();
    });
    this._stageEl.appendChild(video);
    this._bindVideoControls(video);

    // Always go through hls.js — including on Safari, via MediaSource
    // Extensions — rather than handing Safari the raw .m3u8 URL. Native
    // HLS playback on Safari/iOS/macOS shows its own AirPlay/fullscreen
    // chrome unconditionally for that code path, regardless of the
    // `controls` attribute; that chrome is exactly the "native player"
    // this card exists to avoid. Once hls.js feeds the video via MSE,
    // Safari treats it as a plain buffered video and adds none of that.
    const attach = () => {
      if (!window.Hls?.isSupported()) {
        // Extremely old/unsupported browser — last-resort native fallback.
        video.src = url;
        return;
      }
      const hls = new window.Hls({ maxBufferLength: 30, backBufferLength: 30 });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (data?.fatal) console.warn("[frigate-timeline-card] hls.js fatal error", data);
      });
      this._hls = hls;
    };
    if (window.Hls) attach();
    else this._loadHlsJs().then(attach).catch((err) => console.warn("[frigate-timeline-card] hls.js failed to load", err));
  }

  _seekTo(frac) {
    const win = this._currentWindow();
    const ts = win.start + frac * (win.end - win.start);
    this._playAt(ts);
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
    if (!this._nowPillEl) return;
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
    this._config = { height: 44, frigate_instance_id: "frigate", ...config };
    if (!this._built) this._build();
    this._sync();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._entityPicker) this._entityPicker.hass = hass;
  }

  _build() {
    this._built = true;
    this.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px;padding:8px 2px 16px;">
        <div id="ftc-ed-entity"></div>
        <div style="display:flex;gap:8px;">
          <ha-textfield id="ftc-ed-host" label="Server Frigate (ex: 192.168.1.11)" style="flex:2"></ha-textfield>
          <ha-textfield id="ftc-ed-port" label="Port" type="number" style="flex:1"></ha-textfield>
        </div>
        <div id="ftc-ed-camera-row">
          <ha-textfield id="ftc-ed-camera" label="Cameră în Frigate (ex: spate)" style="width:100%"></ha-textfield>
        </div>
        <ha-textfield id="ftc-ed-instance" label="Frigate instance id (implicit: frigate)" style="width:100%"></ha-textfield>
        <ha-textfield id="ftc-ed-height" label="Înălțime timeline (px)" type="number" style="width:100%"></ha-textfield>
      </div>
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
      <ha-select id="ftc-ed-camera-select" label="Cameră în Frigate" style="width:100%">
        ${this._frigateCameraNames
          .map((n) => `<mwc-list-item value="${n}">${n}</mwc-list-item>`)
          .join("")}
      </ha-select>
    `;
    const sel = row.querySelector("#ftc-ed-camera-select");
    sel.value = this._config.frigate_camera || "";
    sel.addEventListener("selected", (e) => this._update("frigate_camera", e.target.value));
    sel.addEventListener("closed", (e) => e.stopPropagation());
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
