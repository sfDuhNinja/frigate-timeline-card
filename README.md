# Frigate Timeline Card

A minimal Home Assistant Lovelace card: a live camera view plus a horizontal, Frigate-style event timeline underneath it — nothing else. No gallery, no thumbnail grid, no PTZ/talkback/zoom controls. Built to stay light and fast.

![screenshot placeholder](https://via.placeholder.com/800x300?text=Frigate+Timeline+Card)

## Features

- **Live view** over WebRTC, driven directly via Home Assistant's `camera/webrtc/*` websocket commands — no added latency beyond what HA/go2rtc already provide.
- **No native video controls anywhere.** Every `<video>` element runs with `controls=false` plus this card's own tap-to-toggle play/pause and mute button. Safari/iOS never gets to show its AVKit-styled native player chrome.
- **Horizontal event timeline** below the live view, styled as a histogram: gold bars for detections, taller red bars for alerts, with a live red "now" pill (updating every second) and a dashed guideline.
- **Zoom & pan** on the timeline — mouse wheel or +/− buttons on desktop, two-finger pinch on mobile/tablet; drag to pan once zoomed in.
- **Tap/click a bar** (or anywhere on the timeline) to play the nearest recorded clip inline; a "● LIVE" button returns to the live stream.
- Review/event/recording data is fetched over Home Assistant's own websocket via the Frigate integration (`frigate/events/get`, `frigate/reviews/get`, `frigate/recordings/get`), with Frigate's REST endpoints kept only as a fallback for setups without that integration. Direct REST is a fallback rather than the primary path because Frigate sends no CORS headers, so a browser is blocked from reading those responses cross-origin.

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
live_source: ha                         # optional — "ha" (default) or "frigate" (go2rtc MSE via HA's Frigate proxy)
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
| `live_source` | no | `ha` | `ha` uses `ha-camera-stream`; `frigate` uses Frigate's own go2rtc over MSE (WebSocket-delivered fMP4 — more tolerant of tunneled paths like Tailscale than WebRTC's real-time UDP), reached through the Frigate integration's proxy so it stays same-origin with the dashboard |
| `go2rtc_url` | no | Frigate host on port `1984` | Only used when `live_source: frigate`, and only needed for a go2rtc that isn't the one Frigate bundles. Setting it forces a direct browser→go2rtc connection instead of Home Assistant's proxy, which then has to be reachable from every device and breaks on https dashboards if it isn't TLS itself |
| `frigate_stream` | no | `main` | Only used when `live_source: frigate`; which go2rtc stream to use, `main` (full quality) or `sub` (lighter) |
| `show_motion` | no | `true` | Draw the white motion histogram behind the activity bands |

## Why this exists

Most Frigate/camera Lovelace cards bundle a full media gallery, thumbnails, PTZ, and more — genuinely useful, but heavy when all you want is "show me the camera live, and let me scrub through today's events." This card intentionally does one thing.

## License

MIT

## Timeline

The strip is layered the way Frigate's own timeline reads:

- **White histogram** — motion, from each recording segment's `motion` score. Bar height is the loudest score in that column, square-rooted and scaled against the loudest score *in the visible window*, so zooming into a quiet stretch opens up its detail instead of flattening it against an unrelated peak elsewhere in the day.
- **Amber band** — a review segment: Frigate decided something happened here.
- **Red band** — the same, but a person was in it.

Red tracks people rather than Frigate's `alert` severity, because the two are not the same thing. Over a measured day on a three-camera setup, 97 review segments contained a person but only 68 were alerts — a severity-driven red would have missed 29 of them — while 34 alerts were cats.

Tapping or scrubbing plays from where the selector is, with no snapping to events. The one adjustment is a tap into a gap: Frigate keeps footage only where something happened — around half a day on these cameras — so those land on the nearest recorded edge rather than failing to load. When a clip reaches its end, playback carries on into the next stretch of footage, jumping the gaps, until it catches up with live.

Set `show_motion: false` to drop the histogram. Colors are theme variables: `--frigate-timeline-motion`, `--frigate-timeline-detect`, `--frigate-timeline-alert`.

## Resource use

Live streams stop while the dashboard is out of sight and start again on return — locking the phone or switching apps ends the decode rather than leaving it running. On a phone showing three cameras that is three simultaneous hardware decodes reclaimed.

If a camera drops intermittently, check what it is actually streaming: `frigate_stream: sub` is often the difference between a 4K HEVC stream and a 720p H.264 one, and three simultaneous 4K decodes is where hardware decoders start failing.
