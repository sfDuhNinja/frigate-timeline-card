#!/bin/bash
# Concatenates the vendored hls.js bundle with the card source into the
# single self-contained file HACS installs (see hacs.json's "filename").
# No real bundler needed — hls.js's UMD build just needs to execute before
# our code does, in the same script, so `window.Hls` is already defined.
set -euo pipefail
cd "$(dirname "$0")"

{
  echo "/* hls.js (vendored, light build) — see vendor/hls.min.js for its own license header */"
  # Wrapped in a function the card calls only when a browser can't play HLS
  # itself: Safari never needs it, and nobody pays its start-up cost until
  # a clip actually needs it.
  echo "function loadVendoredHls() {"
  # Drop the bundle's trailing `//# sourceMappingURL=` line: we ship the
  # minified file alone, so browsers were chasing a .map that doesn't exist
  # next to the installed card and logging a source-map load error for it.
  sed -e 's|^//# sourceMappingURL=.*$||' vendor/hls.min.js
  echo
  echo "}"
  echo "/* frigate-timeline-card — see src/frigate-timeline-card.js */"
  cat src/frigate-timeline-card.js
} > frigate-timeline-card.js

echo "Built frigate-timeline-card.js ($(wc -c < frigate-timeline-card.js) bytes)"
