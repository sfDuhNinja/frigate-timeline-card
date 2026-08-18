# Frigate Timeline Card

A minimal Home Assistant Lovelace card: a live camera view plus a horizontal, Frigate-style event timeline underneath it — nothing else. No gallery, no thumbnail grid, no PTZ/talkback/zoom controls. Built to stay light and fast.

![screenshot placeholder](https://via.placeholder.com/800x300?text=Frigate+Timeline+Card)

## Features

- **Live view** over WebRTC, driven directly via Home Assistant's `camera/webrtc/*` websocket commands — no added latency beyond what HA/go2rtc already provide.
- **No native video controls anywhere.** Every `<video>` element runs with `controls=false` plus this card's own tap-to-toggle play/pause and mute button. Safari/iOS never gets to show its AVKit-styled native player chrome.
- **Horizontal event timeline** below the live view, styled as a histogram: gold bars for detections, taller red bars for alerts, with a live red "now" pill (updating every second) and a dashed guideline.
- **Zoom & pan** on the timeline — mouse wheel or +/− buttons on desktop, two-finger pinch on mobile/tablet; drag to pan once zoomed in.
- **Tap/click a bar** (or anywhere on the timeline) to play the nearest recorded clip inline; a "● LIVE" button returns to the live stream.
- Review/event data is fetched via Frigate's REST `/api/review` and `/api/events` when `frigate_url` is reachable from the browser, with an automatic fallback to Home Assistant's Frigate integration websocket bridge (`frigate/events/get`) when it isn't (common — many Frigate deployments don't send CORS headers).

## Installation (HACS)

1. HACS → the three dots (⋮) in the top right → **Custom repositories**
2. Add `https://github.com/sfDuhNinja/frigate-timeline-card`, category **Dashboard**
3. Install, then add the card to a dashboard (see Configuration below)

## Configuration

```yaml
type: custom:frigate-timeline-card
camera_entity: camera.camera_spate      # required unless live_source: frigate — HA camera entity for the live view
frigate_url: http://192.168.1.11:5000   # required — Frigate REST base, reachable from the browser
frigate_camera: spate                   # required — Frigate's own camera name (not the HA entity)
frigate_instance_id: frigate            # optional — Frigate HA integration config-entry id (default: "frigate")
height: 44                              # optional — timeline strip height in px
default_zoom_hours: 10                  # optional — initial timeline zoom window, in hours (default: 10)
auto_hide_seconds: 0                    # optional — auto-collapse the timeline after N seconds of no interaction (default: 0, disabled)
live_source: ha                         # optional — "ha" (default) or "frigate" (direct go2rtc MSE, bypasses HA's WebRTC bridge)
go2rtc_url: http://192.168.1.11:1984    # optional — only used when live_source: frigate; defaults to the frigate_url host on port 1984
frigate_stream: main                    # optional — only used when live_source: frigate; go2rtc stream suffix, "main" or "sub"
```

A visual editor is also available (entity picker + form fields) when adding the card through the dashboard UI — every option above is reachable there, no YAML editing required.

| Option | Required | Default | Description |
|---|---|---|---|
| `camera_entity` | unless `live_source: frigate` | — | HA `camera.*` entity used for the live view (via `ha-camera-stream`) |
| `frigate_url` | yes | — | Frigate's REST base URL, e.g. `http://192.168.1.11:5000` |
| `frigate_camera` | yes | — | Frigate's own camera name (not the HA entity), used to scope events/review data and clip playback |
| `frigate_instance_id` | no | `frigate` | The Frigate HA integration's config-entry id, used for the websocket fallback |
| `height` | no | `44` | Timeline strip height in pixels |
| `default_zoom_hours` | no | `10` | Initial timeline zoom window, in hours (0.25–24) |
| `auto_hide_seconds` | no | `0` | Auto-collapses the timeline after this many seconds of no interaction; `0` disables it |
| `live_source` | no | `ha` | `ha` uses `ha-camera-stream` (recommended — same-origin, no mixed-content risk); `frigate` connects straight to Frigate's own go2rtc over MSE (WebSocket-delivered fMP4 — more tolerant of tunneled paths like Tailscale than WebRTC's real-time UDP), bypassing HA's WebRTC bridge — opt-in, since it reintroduces the mixed-content failure mode `ha` avoids on https dashboards |
| `go2rtc_url` | no | Frigate host on port `1984` | Only used when `live_source: frigate`; overrides go2rtc's address when it differs from the default |
| `frigate_stream` | no | `main` | Only used when `live_source: frigate`; which go2rtc stream to use, `main` (full quality) or `sub` (lighter) |

## Why this exists

Most Frigate/camera Lovelace cards bundle a full media gallery, thumbnails, PTZ, and more — genuinely useful, but heavy when all you want is "show me the camera live, and let me scrub through today's events." This card intentionally does one thing.

## License

MIT
