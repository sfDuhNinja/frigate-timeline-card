/**
 * frigate-timeline-card
 *
 * Minimal Home Assistant Lovelace card: live camera view plus a horizontal
 * Frigate-style event timeline below it (red = alert, orange = detection,
 * dim = no reviewed activity), matching Frigate's own colors. Drag/click the
 * timeline to play the nearest recorded clip inline; a "LIVE" button returns
 * to the live stream.
 *
 * Live view is WebRTC, driven directly via HA's official `camera/webrtc/*`
 * websocket commands (the same protocol `ha-web-rtc-player` uses internally)
 * called straight off `hass.connection`/`hass.callWS` — no `<ha-camera-stream>`
 * / `<ha-web-rtc-player>` element involved. Those components consume Lit
 * context (`@consume` on api/connection) that doesn't resolve reliably when
 * the element is instantiated by outside code rather than mounted by HA's
 * own card-loading path, which reproducibly left the stream stuck on this
 * setup. Driving the WS protocol ourselves sidesteps that entirely. All
 * `<video>` elements here always run with `controls=false` plus our own
 * tap-to-toggle play/pause and mute button — never the browser's native
 * control chrome (which on Safari/iOS renders as the system AVKit player,
 * exactly what this card exists to avoid).
 *
 * No gallery, no thumbnails, no PTZ/talkback/zoom — deliberately narrow
 * scope so the card stays light.
 *
 * Review/event data is fetched two ways and merged:
 *  - direct REST to `frigate_url` (fast, but many Frigate deployments don't
 *    send CORS headers on /api/*, so the browser silently blocks it)
 *  - HA's Frigate integration WebSocket bridge (`frigate/events/get`),
 *    which is same-origin and always works, used as the events/click-to-play
 *    source whenever REST is unavailable, with severity approximated from
 *    label + score since the WS bridge doesn't expose /api/review data.
 *
 * Config:
 *   type: custom:frigate-timeline-card
 *   camera_entity: camera.camera_spate      # required — HA camera entity for live view
 *   frigate_url: http://192.168.1.11:5000   # required — Frigate REST base, reachable from the browser
 *   frigate_camera: spate                   # optional — Frigate's camera name if it can't be derived from the entity id
 *   frigate_instance_id: frigate            # optional — Frigate HA integration config-entry id (default "frigate")
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
    if (!config.camera_entity) {
      throw new Error("frigate-timeline-card: 'camera_entity' is required");
    }
    if (!config.frigate_url) {
      throw new Error("frigate-timeline-card: 'frigate_url' is required");
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
    // `_showLive()` no-ops without `hass` (needed for the WS handshake) —
    // kick it off for real once `hass` actually arrives, unless the user is
    // mid-clip-playback.
    if (first && !this._playingClip) this._showLive();
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
    return { camera_entity: cameraEntity || "", frigate_url: "", height: 44 };
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
  }

  _cameraObjectId() {
    if (this._config.frigate_camera) return this._config.frigate_camera;
    const objectId = String(this._config.camera_entity).split(".").slice(1).join(".");
    // Most Frigate + HA setups name the HA camera entity `camera.camera_<name>`
    // while Frigate's own camera key is just `<name>` — strip that prefix as
    // the default heuristic; `frigate_camera` overrides it when it doesn't hold.
    return objectId.replace(/^camera_/, "");
  }

  _build() {
    this._built = true;
    this.innerHTML = `
      <ha-card>
        <div class="ftc-stage"></div>
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
        frigate-timeline-card .ftc-back-btn {
          position: absolute; top: 8px; left: 8px; z-index: 5;
          background: rgba(0, 0, 0, 0.6); color: #fff; border: none; border-radius: 8px;
          padding: 6px 12px; font-size: 12px; font-weight: 600; letter-spacing: 0.03em;
          cursor: pointer;
        }
        frigate-timeline-card .ftc-mute-btn {
          position: absolute; top: 8px; right: 8px; z-index: 5;
          background: rgba(0, 0, 0, 0.6); color: #fff; border: none; border-radius: 50%;
          width: 32px; height: 32px; font-size: 15px; line-height: 1; cursor: pointer;
        }
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
        frigate-timeline-card .ftc-now-line {
          position: absolute; top: -8px; bottom: 0; width: 0;
          border-left: 1px dashed rgba(255, 255, 255, 0.5);
          transform: translateX(-50%); pointer-events: none; z-index: 3;
        }
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
    this._rtcUnsub?.().catch?.(() => {});
    this._rtcUnsub = null;
    if (this._rtcPeerConnection) {
      try {
        this._rtcPeerConnection.close();
      } catch (_) {
        /* already closed */
      }
      this._rtcPeerConnection = null;
    }
  }

  _addTapToggleControls(video, { showMute } = {}) {
    // Our own minimal controls — never `video.controls = true` (that's the
    // browser's native chrome, AVKit-styled on Safari/iOS, exactly what this
    // card avoids). Tap the video to play/pause; an optional small mute
    // button top-right for live.
    video.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    if (showMute) {
      const muteBtn = document.createElement("button");
      muteBtn.className = "ftc-mute-btn";
      const sync = () => {
        muteBtn.textContent = video.muted ? "🔇" : "🔊";
      };
      sync();
      muteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        video.muted = !video.muted;
        sync();
      });
      this._stageEl.appendChild(muteBtn);
    }
  }

  async _showLive() {
    this._playingClip = null;
    const token = (this._liveToken = (this._liveToken || 0) + 1);
    this._teardownWebRtc();
    this._stageEl.innerHTML = "";
    this._streamEl = null;

    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true; // starts muted so autoplay is allowed; our mute button toggles it
    video.playsInline = true;
    video.controls = false;
    this._stageEl.appendChild(video);
    this._streamEl = video;
    this._addTapToggleControls(video, { showMute: true });

    if (typeof RTCPeerConnection === "undefined" || !this._hass) return;
    const entityId = this._config.camera_entity;

    try {
      const clientConfig = await this._hass.callWS({
        type: "camera/webrtc/get_client_config",
        entity_id: entityId,
      });
      if (token !== this._liveToken) return;

      const pc = new RTCPeerConnection(clientConfig.configuration);
      this._rtcPeerConnection = pc;
      if (clientConfig.dataChannel) pc.createDataChannel(clientConfig.dataChannel);

      const remoteStream = new MediaStream();
      pc.ontrack = (e) => {
        remoteStream.addTrack(e.track);
        video.srcObject = remoteStream;
      };
      pc.addTransceiver("audio", { direction: "recvonly" });
      pc.addTransceiver("video", { direction: "recvonly" });

      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      if (token !== this._liveToken) return;

      let sessionId = null;
      const pendingCandidates = [];
      pc.onicecandidate = (e) => {
        if (!e.candidate?.candidate) return;
        if (sessionId) {
          this._hass.callWS({
            type: "camera/webrtc/candidate",
            entity_id: entityId,
            session_id: sessionId,
            candidate: e.candidate.toJSON(),
          });
        } else {
          pendingCandidates.push(e.candidate);
        }
      };

      this._rtcUnsub = await this._hass.connection.subscribeMessage(
        (event) => {
          if (token !== this._liveToken) return;
          if (event.type === "session") {
            sessionId = event.session_id;
            pendingCandidates.splice(0).forEach((c) => {
              this._hass.callWS({
                type: "camera/webrtc/candidate",
                entity_id: entityId,
                session_id: sessionId,
                candidate: c.toJSON(),
              });
            });
          } else if (event.type === "answer") {
            pc.setRemoteDescription({ type: "answer", sdp: event.answer }).catch((err) =>
              console.warn("[frigate-timeline-card] setRemoteDescription failed", err)
            );
          } else if (event.type === "candidate") {
            const c = event.candidate;
            const candidate =
              c.sdpMid || c.sdpMLineIndex != null
                ? new RTCIceCandidate(c)
                : new RTCIceCandidate({ candidate: c.candidate, sdpMid: "0" });
            pc.addIceCandidate(candidate).catch(() => {});
          } else if (event.type === "error") {
            console.warn("[frigate-timeline-card] WebRTC error from backend:", event.message);
          }
        },
        { type: "camera/webrtc/offer", entity_id: entityId, offer: offer.sdp }
      );
    } catch (err) {
      console.warn("[frigate-timeline-card] WebRTC live view failed", err);
    }
  }

  _playClip(url, label) {
    this._playingClip = { url, label };
    this._liveToken = (this._liveToken || 0) + 1; // invalidate any in-flight _showLive()
    this._teardownWebRtc();
    this._stageEl.innerHTML = "";
    this._streamEl = null;

    const back = document.createElement("button");
    back.className = "ftc-back-btn";
    back.textContent = "● LIVE";
    back.addEventListener("click", (e) => {
      e.stopPropagation();
      this._showLive();
    });
    const video = document.createElement("video");
    video.src = url;
    video.autoplay = true;
    video.muted = false;
    video.playsInline = true;
    video.controls = false; // custom tap-to-toggle below — never native controls
    video.title = label || "";
    this._stageEl.appendChild(video);
    this._stageEl.appendChild(back);
    this._addTapToggleControls(video, { showMute: false });
  }

  _seekTo(frac) {
    const win = this._currentWindow();
    const ts = win.start + frac * (win.end - win.start);
    const nearest = this._nearestEvent(ts);
    if (!nearest) return;
    const base = this._config.frigate_url.replace(/\/+$/, "");
    this._playClip(`${base}/api/events/${nearest.id}/clip.mp4`, nearest.label);
  }

  _nearestEvent(ts) {
    let best = null;
    let bestDiff = Infinity;
    for (const ev of this._events) {
      const evMs = Number(ev.start_time) * 1000;
      if (!Number.isFinite(evMs)) continue;
      const diff = Math.abs(evMs - ts);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = ev;
      }
    }
    return best;
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

    let reviews = null;
    try {
      const res = await fetch(`${base}/api/review?after=${afterSec}&before=${beforeSec}`);
      if (res.ok) reviews = await res.json();
    } catch (err) {
      console.warn("[frigate-timeline-card] REST /api/review unavailable (CORS or network) — falling back", err);
    }

    let events = null;
    try {
      const res = await fetch(`${base}/api/events?after=${afterSec}&before=${beforeSec}&limit=500`);
      if (res.ok) events = await res.json();
    } catch (err) {
      console.warn("[frigate-timeline-card] REST /api/events unavailable (CORS or network) — falling back", err);
    }
    if (!Array.isArray(events) && this._hass?.connection) {
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
    const now = Date.now();
    const inWindow = now >= win.start && now <= win.end;
    this._nowPillEl.style.display = inWindow ? "" : "none";
    this._nowLineEl.style.display = inWindow ? "" : "none";
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
        <ha-textfield id="ftc-ed-url" label="Frigate URL (ex: http://192.168.1.11:5000)" style="width:100%"></ha-textfield>
        <ha-textfield id="ftc-ed-camera" label="Nume cameră în Frigate (opțional, ex: spate)" style="width:100%"></ha-textfield>
        <ha-textfield id="ftc-ed-instance" label="Frigate instance id (implicit: frigate)" style="width:100%"></ha-textfield>
        <ha-textfield id="ftc-ed-height" label="Înălțime timeline (px)" type="number" style="width:100%"></ha-textfield>
      </div>
    `;
    const entityRow = this.querySelector("#ftc-ed-entity");
    const picker = document.createElement("ha-entity-picker");
    picker.includeDomains = ["camera"];
    picker.label = "Cameră (live view)";
    picker.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      this._update("camera_entity", e.detail.value);
    });
    entityRow.appendChild(picker);
    this._entityPicker = picker;

    this.querySelector("#ftc-ed-url").addEventListener("input", (e) => this._update("frigate_url", e.target.value));
    this.querySelector("#ftc-ed-camera").addEventListener("input", (e) => this._update("frigate_camera", e.target.value));
    this.querySelector("#ftc-ed-instance").addEventListener("input", (e) => this._update("frigate_instance_id", e.target.value));
    this.querySelector("#ftc-ed-height").addEventListener("input", (e) => this._update("height", Number(e.target.value) || 44));
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
    set("#ftc-ed-url", this._config.frigate_url);
    set("#ftc-ed-camera", this._config.frigate_camera);
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
