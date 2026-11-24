// Run with: node --test test/card.test.mjs
// Covers the date, window and scroll arithmetic plus a few regressions that
// have bitten before. Nothing here needs a browser.
process.env.TZ = "Europe/Bucharest"; // has a DST change, which is the point

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCard } from "./load.mjs";

const { defined, ctx } = loadCard();
const Card = defined["frigate-timeline-card"];
const H = 3600000;

/** A card with no DOM: just the fields the maths reads. */
function card({ day = "2026-11-10", hours = 0.5, center, vertical = false, len = 600 } = {}) {
  const c = Object.create(Card.prototype);
  Object.assign(c, {
    _dayKey: day,
    _windowHours: hours,
    _centerMs: center,
    _vertical: vertical,
    _trackEl: { clientWidth: len, clientHeight: len },
    _config: {},
  });
  return c;
}

test("dayWindow spans 25h on the autumn DST day and 24h otherwise", () => {
  const len = (k) => {
    const w = ctx.dayWindow(k);
    return (w.end - w.start) / H;
  };
  assert.equal(len("2026-10-25"), 25);
  assert.equal(len("2026-11-10"), 24);
});

test("shiftDayKey crosses month and year boundaries", () => {
  assert.equal(ctx.shiftDayKey("2026-12-31", 1), "2027-01-01");
  assert.equal(ctx.shiftDayKey("2026-03-01", -1), "2026-02-28");
});

test("a zoomed window keeps its span and stays inside the day", () => {
  const day = ctx.dayWindow("2026-11-10");
  for (const center of [day.start - 5 * H, day.start + 12 * H, day.end + 5 * H]) {
    const w = card({ center })._currentWindow();
    assert.equal(w.end - w.start, 0.5 * H);
    assert.ok(w.start >= day.start && w.end <= day.end);
  }
});

for (const vertical of [false, true]) {
  test(`scroll offset and window centre round-trip (${vertical ? "vertical" : "horizontal"})`, () => {
    const day = ctx.dayWindow("2026-11-10");
    for (const center of [day.start + 3 * H, day.start + 12 * H, day.end - 2 * H]) {
      const c = card({ center, vertical });
      const pos = c._scrollPosFor(c._currentWindow());
      assert.ok(Math.abs(c._centerFromScroll(pos) - center) < 1, `center ${center}`);
    }
  });
}

test("vertical scroll starts at the newest end of the day", () => {
  const day = ctx.dayWindow("2026-11-10");
  const c = card({ vertical: true, center: day.end });
  assert.equal(c._scrollPosFor(c._currentWindow()), 0);
});

test("a click inside a recording plays from that moment", () => {
  const c = card();
  c._recordings = [{ start: 1000, end: 2000 }];
  assert.equal(c._nearestPlayableMs(1500), 1500);
  assert.equal(c._nearestPlayableMs(500), 1000);
});

test("PTZ home button appears only for cameras with a home preset", async () => {
  const show = async (presets, config = {}) => {
    const c = card();
    const classes = new Set(["ftc-hidden"]);
    c._homeBtnEl = { classList: { toggle: (n, on) => (on ? classes.add(n) : classes.delete(n)) } };
    c._config = { frigate_camera: "garaj", camera_entity: "camera.garaj", ...config };
    c._hass = {
      connection: { sendMessagePromise: async () => (presets ? JSON.stringify({ presets }) : "{}") },
    };
    await c._ensurePtz();
    return !classes.has("ftc-hidden");
  };
  assert.equal(await show(["home", "poarta"]), true);
  assert.equal(await show(["poarta"]), false);
  assert.equal(await show(null), false);
  assert.equal(await show(["home"], { live_only: true }), false);
});

test("the playhead keeps taking touches, so it can be scrubbed", () => {
  // v1.49.0 turned pointer events off on it to let swipes scroll instead,
  // which left only taps working.
  const src = readFileSync(new URL("../src/frigate-timeline-card.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\.ftc-now-line\s*\{[^}]*pointer-events:\s*none/);
});
