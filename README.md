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
camera_entity: camera.camera_spate      # required — HA camera entity for the live view
frigate_url: http://192.168.1.11:5000   # required — Frigate REST base, reachable from the browser
frigate_camera: spate                   # optional — Frigate's camera name, if it can't be derived from the entity id
frigate_instance_id: frigate            # optional — Frigate HA integration config-entry id (default: "frigate")
height: 44                              # optional — timeline strip height in px
```

A visual editor is also available (entity picker + text fields) when adding the card through the dashboard UI.

| Option | Required | Default | Description |
|---|---|---|---|
| `camera_entity` | yes | — | HA `camera.*` entity used for the live WebRTC view |
| `frigate_url` | yes | — | Frigate's REST base URL, e.g. `http://192.168.1.11:5000` |
| `frigate_camera` | no | derived from `camera_entity` by stripping a leading `camera_` | Frigate's own camera name, if it differs |
| `frigate_instance_id` | no | `frigate` | The Frigate HA integration's config-entry id, used for the websocket fallback |
| `height` | no | `44` | Timeline strip height in pixels |

## Why this exists

Most Frigate/camera Lovelace cards bundle a full media gallery, thumbnails, PTZ, and more — genuinely useful, but heavy when all you want is "show me the camera live, and let me scrub through today's events." This card intentionally does one thing.

## License

MIT
