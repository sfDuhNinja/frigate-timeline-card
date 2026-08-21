# Frigate Timeline Card

A minimal Home Assistant Lovelace card: a live camera view plus a horizontal, Frigate-style event timeline underneath it — nothing else. No gallery, no thumbnail grid, no PTZ/talkback/zoom controls. Built to stay light and fast.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=sfDuhNinja&repository=frigate-timeline-card&category=dashboard)

## Features

- **Live view** over go2rtc's MSE stream, reached through the Frigate integration's own proxy so it stays same-origin with the dashboard — no mixed content on an https front end, and nothing that needs Frigate's address to be reachable from the device.
- **No native video controls anywhere.** Every `<video>` runs with `controls=false` alongside the card's own play/pause and mute. The stream is also declared endless, so a fullscreen handover to Apple's player shows LIVE rather than a clock counting up.
- **A timeline layered the way Frigate's own reads** — a white motion histogram over translucent bands, amber where something happened and red where a person was.
- **Zoom & pan** — wheel or +/− on desktop, two-finger pinch on mobile; drag to pan once zoomed in, and dragging the selector into either end scrolls the window.
- **Tap or scrub anywhere** to play from exactly there; playback carries on into the next stretch of footage when a clip ends. A "● LIVE" button returns to the present.
- **Everything goes through Home Assistant** — `frigate/events/get`, `frigate/reviews/get`, `frigate/recordings/get` over its websocket, clips and live over the integration's proxy on a signed path. Frigate's own endpoints are kept only as a fallback for setups without that integration, because Frigate sends no CORS headers and a browser cannot read them cross-origin.

## Installation (HACS)

Use the badge above, or add it by hand:

1. HACS → the three dots (⋮) in the top right → **Custom repositories**
2. Add `https://github.com/sfDuhNinja/frigate-timeline-card`, category **Dashboard**
3. Install, then add the card to a dashboard (see Configuration below)

The card needs the [Frigate integration](https://github.com/blakeblackshear/frigate-hass-integration) installed. It works without it, but every request then has to reach Frigate directly from the browser, which CORS blocks on most setups.

## Configuration

```yaml
type: custom:frigate-timeline-card
frigate_url: http://192.168.1.11:5000   # required — Frigate's own address
frigate_camera: spate                   # required — Frigate's own camera name (not the HA entity)
live_source: frigate                    # go2rtc MSE through HA's Frigate proxy
height: 44                              # optional — timeline strip height in px
default_zoom_hours: 10                  # optional — initial timeline zoom window, in hours (default: 10)
auto_hide_seconds: 0                    # optional — auto-collapse the timeline after N seconds of no interaction (default: 0, disabled)
frigate_stream: auto                    # optional — "auto" (default), "main" or "sub"
show_motion: true                       # optional — draw the motion histogram (default: true)
pause_offscreen: true                   # optional — stop streaming while off screen (default: true)
```

The visual editor covers what people actually change: Frigate host and port, the camera, timeline height, default zoom, auto-hide, and the stream choice. `camera_entity`, `frigate_instance_id`, `live_source` and `go2rtc_url` are YAML-only — they exist for setups that need them and would be clutter for everyone else.

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
| `frigate_stream` | no | `auto` | Only used when `live_source: frigate`. `auto` picks the sub stream unless the card is rendered wide enough to show more; `main` and `sub` force one |
| `show_motion` | no | `true` | Draw the white motion histogram behind the activity bands |
| `pause_offscreen` | no | `true` | Stop the live stream while the card is scrolled out of view or the app is in the background |

## Timeline

The strip is layered the way Frigate's own timeline reads:

- **White histogram** — motion, from each recording segment's `motion` score. Bar height is the loudest score in that column, square-rooted and scaled against the loudest score *in the visible window*, so zooming into a quiet stretch opens up its detail instead of flattening it against an unrelated peak elsewhere in the day.
- **Amber band** — a review segment: Frigate decided something happened here.
- **Red band** — the same, but a person was in it.

Red tracks people rather than Frigate's `alert` severity, because the two are not the same thing. Over a measured day on a three-camera setup, 97 review segments contained a person but only 68 were alerts — a severity-driven red would have missed 29 of them — while 34 alerts were cats.

Tapping or scrubbing plays from where the selector is, with no snapping to events. The one adjustment is a tap into a gap: Frigate keeps footage only where something happened — around half a day on these cameras — so those land on the nearest recorded edge rather than failing to load. When a clip reaches its end, playback carries on into the next stretch of footage, jumping the gaps, until it catches up with live.

Set `show_motion: false` to drop the histogram. Colors are theme variables: `--frigate-timeline-motion`, `--frigate-timeline-detect`, `--frigate-timeline-alert`.

## Resource use

Measured on a three-camera dashboard: the main streams were decoding 3200x1800, 3840x2160 and 3840x2160 at 20-25fps — **511 megapixels a second between them**, about sixty frames of 4K every second, sustained. Nearly all of it thrown away, since each card renders a few hundred pixels wide.

`frigate_stream: auto` (the default) picks the sub stream unless the card is actually rendered wide enough to show more, using the sub stream's own width as the threshold. On the same dashboard that is roughly a tenth of the decode load and an eighth of the bandwidth, with nothing visibly lost at the size the cards are displayed. `main` and `sub` force the choice.

Live streams stop while the card is out of sight and start again on return — scrolling past it, locking the phone or switching apps all end the decode rather than leaving it running. On a phone showing three cameras only one card fits on screen at a time, so this is the difference between decoding three streams and decoding one. Stopping is delayed a couple of seconds so a scroll straight past doesn't tear a stream down and rebuild it; starting is immediate. Set `pause_offscreen: false` to keep every card streaming regardless.

If a camera drops intermittently, check what it is actually streaming: `frigate_stream: sub` is often the difference between a 4K HEVC stream and a 720p H.264 one, and three simultaneous 4K decodes is where hardware decoders start failing.

## Why this exists

Most Frigate/camera Lovelace cards bundle a full media gallery, thumbnails, PTZ, and more — genuinely useful, but heavy when all you want is "show me the camera live, and let me scrub through today's events." This card intentionally does one thing.

## License

MIT
