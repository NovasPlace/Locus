# Changelog

All notable changes to Locus are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [4.2.3] — 2026-03-17

### Changed
- **UI redesign** — full overlay redesign matching the new aesthetic: `#0d1117` GitHub-dark background, cyan `#00d4aa` accent, JetBrains Mono for code context, Inter for UI text.
- **Header** — `LOCUS AI ⚡` branding, `← →` nav, model badge, icon cluster (screenshot/pin/compact).
- **Context block** — green monospace code block with collapse/push/clear controls replaces old grey text area.
- **AI ANALYSIS** — cyan section label above the streaming response area.
- **Action dock** — icon toolbar (🔧⚡💡📖🔬✏️📋) replaces old tab+button row. All actions still wired.
- **Input bar** — dark `#1c2128` field, cyan send button, refined layout.

### Added
- **Free tier gate** — Blueprint Printer now shows a clear "Manifesto Engine required" message when ME is offline instead of silently hanging. All other features (Fix, Explain, Teach Me, Deep Dive, Review, etc.) work without ME.
- **Engine state broadcast** — `engine-state` IPC fires when ME connects/disconnects. Blueprint mode badge dims to 40% opacity when ME is not ready.

---

## [4.2.2] — 2026-03-17


### Fixed
- **Critical crash:** `contentType is not defined` on every overlay activation — `detectContentType()` and `detectLanguage()` were scoped inside the dead toolbar branch and never reached the active code path. Hoisted above the if/else fork.
- **OCR handler crash:** `updateContextDisplay is not defined` — replaced with inline context box update using existing `contextBox` + `updateCtxChars()`.
- **Git context panel:** `getElementById('chat-input')` referenced a non-existent element (real ID is `cmd`). Fixed with null-safe guard.
- **Duplicate IPC listener:** `ipcRenderer.on('chat-chunk')` was registered twice — once for streaming and once for token counting. Folded token counting inline into the primary handler.
- **Highlight listener zombie loop:** On X11 failures (e.g. display contention), the listener respawned every 2s indefinitely. Added exponential backoff (2s → 4s → 8s → 30s cap) with a 10-failure give-up limit and a 10s grace reset when healthy.

### Changed
- `toolbarFirst` default config set to `false` (toolbar was intentionally removed in v4.2; config still said `true`, causing confusing dead-code branch).
- Companion panel: Context box now appears **above** the mode card (Blueprint Printer / Teach Me / Deep Dive) in all three preview modes.
- Companion panel: Removed redundant red **✕ Cancel** button from Blueprint, Teach Me, and Dive preview screens. The header **✕** close button handles dismissal.
- Companion panel: Removed three dead cancel button event listeners that would throw `TypeError: Cannot read properties of null` on startup.

---

## [4.2.1] — 2026-03-16

### Fixed
- **CSS stray `}`** — extra closing brace on line 126 of `companion-panel.html` broke all styles below `.header-title`. Fixed.
- **Header button group** — Clear + Close consolidated into `.header-btn-group` pill (shared border, rounded ends).
- **Single-word activation** — 21 threshold checks across `main.js` + `companion-panel.html` lowered from `length < 5` to `length < 1`. Highlight a single word → panel activates.
- **Push-to-panel** — `→ Panel` button in main overlay sends `push-context-to-panel` IPC. Opens companion if closed.
- **Selection poller** — `startCompanionSelectionPoller()` watches PRIMARY selection every 500ms, pushes to companion + quiet-updates main context box.

---

## [4.2.0] — 2026-03-15

### Added
- **Companion Panel** — unified tabbed panel replacing 4 separate window files. Tabs: Blueprint, Teach Me, Deep Dive, Terminal.
- **Panel persistence** — companion `blur` handler calls `moveTop()` when pinned; main `blur` checks if companion is focused before hiding.
- **Push context bridge** — `→ Panel` button + `push-context-to-panel` IPC transfers context from main overlay to active companion tab.
- **Mode-aware theming** — cyan for Blueprint, teal for Teach, amber for Dive.
- **Terminal tab** — embedded terminal with kill button inside companion panel.

### Changed
- Blueprint, Teach Me, Deep Dive, Terminal panels consolidated from 4 separate BrowserWindows into one tabbed companion panel.

---

## [4.1.2] — 2026-03-14

### Fixed
- Overlay position clamping on multi-monitor setups.
- Provider health check retry on startup.

---

## [4.1.1] — 2026-03-14

### Fixed
- Companion panel snap offset using hardcoded 420px instead of `mainWindow.getSize()[0]`.
- X11 snap loop: `setPosition()` fires `move` event on Linux → infinite loop. Fixed with `_isSnapping` guard flag.

---

## [4.1.0] — 2026-03-13

### Added
- Multi-model compare (side-by-side streaming from 2 providers).
- OCR integration (region capture → Moondream vision → context injection).
- Git context injection (`📁 Git` button in Tools tab).
- Session stats tracking (`📊 Stats`).
- Clipboard queue (accumulate snippets → batch LLM request).

---

## [4.0.0] — 2026-03-13

### Added
- **Quick-Action Sidebar** — 32px left edge with Blueprint/Terminal/Expand icons.
- **Compact Mode** — `≡` button hides context/tabs for minimal footprint.
- **Streaming wave dots** — 3-dot wave replaces old blink cursor.
- **Context language accent** — cyan (code) / green (text) / purple (other) border variants.
- **Action button micro-animations** — scale + glow on hover/active.
- **Mode switcher** — Blueprint ↔ Teach Me toggle in drag bar badge.
- **Teach Me panel** — structured What / How / Why / Example breakdown with its own window.
- **Deep Dive** — focused technical analysis, snaps south of Teach Me with hinge animation.

---

## [3.5.0] — 2026-03-10

### Added
- Lookup window (dictionary + Wikipedia + LLM streaming).
- Stack trace parser — clickable file:line links in overlay.
- Source file detector from active window title.
- Regex live tester panel (client-side, no LLM call for pattern matching).

---

## [3.3.1] — 2026-03-08

### Fixed
- ASAR packaging missing `src/` subdirectories.
- pynput venv path resolution on first-launch.

---

## [3.3.0] — 2026-03-07

### Added
- Initial AppImage + .deb release.
- Ollama, OpenAI, Anthropic provider support.
- Highlight-to-invoke via pynput (Linux) + clipboard polling (Windows).
- Blueprint Printer via Manifesto Engine.
- CortexDB memory persistence (Pro tier).
