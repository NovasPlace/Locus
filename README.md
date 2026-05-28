# Locus

**Local-first workspace context layer for AI.**

Locus sits over your desktop so you can capture text, screenshots, notes, code snippets, terminal output, and browser context without copy-paste chaos. Stage messy context, organize it into clean thread memory, then use local or cloud models only when you choose.

![Locus Overlay](build/icons/256x256.png)

---

## Download

Windows builds are published from the **GitHub Releases** page.

- **Installer:** `Locus Setup.exe`
- **Portable:** `Locus portable.exe`

Download the latest build from:

> **Releases:** https://github.com/NovasPlace/Locus/releases

If a release does not have assets yet, the workflow may still be building or a release tag has not been pushed.

---

## What Locus does

- **Capture workspace context** — highlight text, grab screenshots, capture terminal output, or create notes.
- **Stage before saving** — use Working Context to amend, clean, and organize context before it becomes memory.
- **Save to thread memory** — context cards stay attached to persistent threads instead of disappearing into chat history.
- **Inspect provenance** — keep track of source app, source window, capture type, timestamps, and saved context.
- **Use quick actions** — ask, explain, summarize, simplify, fix, review, diagnose, rewrite, OCR, and more.
- **Customize the radial menu** — choose the six actions you want in the quick action wheel.
- **Use local or cloud models** — route everyday work to local models and reserve cloud models for deeper tasks.

---

## Core workflow

```text
Capture context
  → stage it in Working Context
  → edit or organize it in Note / Document / Screenshot mode
  → save it to a Locus thread
  → search, review, reuse, or send it to a model later
```

The goal is simple:

> **Locus gives AI the context you choose, organized the way you want, with receipts for where it came from.**

---

## Main features

### Working Context

A temporary staging area for selected text or captured material. You can add more context, ask a quick question, amend the content, or save it into a Locus thread.

### Context Cards

Saved memory units attached to a thread. Cards can represent selected text, screenshots, notes, documents, model results, or other captured context.

### Companion Panel

A side panel for deeper work and saved context review. Current directions include context cards, source grouping, timeline view, saved items, and model/action settings.

### Screenshot / Document Notes

Capture a screenshot, write or edit a note about it, then save the clean note and original screenshot provenance to Locus.

### Radial Action Wheel

A configurable quick-action menu that appears near captured context. Pick the actions you actually use.

### Model Routing

Locus is designed around three model tiers:

| Tier | Purpose |
|---|---|
| **Quick** | Local, small, private, fast. Good for tags, titles, summaries, cleanup, and simple explanations. |
| **Standard** | Balanced quality/cost. Good for normal asking, code explanations, and medium context. |
| **Deep** | Premium/high-quality. Good for architecture, hard debugging, safety review, and final checks. |

Locus should never silently move private local context to a cloud model. Cloud escalation should be explicit.

---

## Privacy model

- Locus is local-first.
- Captured text is not sent to a model until you explicitly run an action.
- Local models can be used for private/quick work.
- Cloud providers are optional and should be treated as explicit routing choices.
- Audit/provenance data should track what was sent, where it went, and which model handled it.

---

## Install from source

```bash
git clone https://github.com/NovasPlace/Locus.git
cd Locus
npm ci
npm start
```

Build packages:

```bash
npm run build:win     # Windows NSIS installer + portable exe
npm run build:linux   # AppImage + deb
npm run build:mac     # dmg
```

---

## Windows releases

Windows release artifacts are built by GitHub Actions when a version tag is pushed.

```bash
git tag v4.2.4
git push origin v4.2.4
```

The release workflow builds the Windows app and uploads the installer/portable executables to GitHub Releases.

---

## Repository layout

```text
src/
├── main.js              # Electron main process, IPC, windows, providers
├── index.html           # Main overlay UI
├── companion-panel.html # Companion panel UI
├── quick-panel.html     # Working Context / quick context window
├── platform.js          # Cross-platform helpers
├── thread-store.js      # Thread/context persistence
└── model/               # Model router/provider layer when enabled
```

---

## Roadmap

Near-term focus:

- First-class thread/context/message data model
- Unified Context Panel
- Source-based context grouping
- Context timeline
- Smart tagging and filtering
- Local-first model router
- Interaction audit log
- Screenshot understanding / OCR
- Markdown/JSON export

Later:

- Knowledge graph
- Plugin/action system
- Cross-device sync
- Collaboration/sharing

---

## License

MIT — © Donovan Everitts / NovasPlace
