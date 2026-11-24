// Loads the card source in a bare VM with just enough of a browser to define
// its classes, so the time/scroll math can be tested without a DOM.
import { readFileSync } from "node:fs";
import vm from "node:vm";

export function loadCard() {
  const defined = {};
  const win = {
    customElements: { define: (name, cls) => (defined[name] = cls), get: (n) => defined[n] },
    customCards: [],
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  };
  const ctx = vm.createContext({
    ...win,
    window: win,
    HTMLElement: class {},
    document: { addEventListener() {}, removeEventListener() {}, createElement: () => ({}) },
    console,
    Intl,
    performance,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(readFileSync(new URL("../src/frigate-timeline-card.js", import.meta.url), "utf8"), ctx);
  return { defined, ctx };
}
