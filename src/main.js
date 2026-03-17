const { app, BrowserWindow, globalShortcut, screen, clipboard, ipcMain, Tray, Menu, nativeImage, dialog, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const child_process = require('child_process');
const http = require('http');
const os = require('os');
const platform = require('./platform');
const providers = require('./providers');
const setup = require('./setup');
const encryption = require('./encryption');
const saveSerializer = require('./save-serializer');
const pluginLoader = require('./plugins');
const contextEngine = require('./context-engine');
const knowledgeMesh = require('./knowledge-mesh');
const codeEngine = require('./code-engine');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'locus');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const CLIPBOARD_ENTRY_MAX = 10000;
const HISTORY_CHAR_BUDGET = 50000;
const SCREENSHOT_RETENTION = 50;
const SEARCH_RESPONSE_MAX = 100000;
const VALID_HOTKEY = /^[A-Za-z0-9+`]+$/;
const TRIGGER_PORT = 19275;

// Resolve paths from config or defaults
function resolveToolPath(name, fallback) {
    const cfgKey = name.replace(/[^a-zA-Z]/g, '_');
    const fromEnv = process.env[`LOCUS_${cfgKey.toUpperCase()}`];
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    if (fs.existsSync(fallback)) return fallback;
    // Try PATH lookup
    try {
        const result = child_process.execFileSync('which', [name], { timeout: 1000, encoding: 'utf8' });
        return result.trim();
    } catch (e) { return fallback; }
}

function resolvePython() {
    const candidates = [
        process.env.LOCUS_PYTHON || '',
        path.join(os.homedir(), '.local/share/locus/venv/bin/python3'),
        '/usr/bin/python3',
    ];
    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    return 'python3';
}

const PYTHON_PATH = resolvePython();
const CORTEX_RECALL = resolveToolPath('cortex_recall.py',
    path.join(os.homedir(), '.local/bin/cortex_recall.py'));
const CORTEX_WRITE = resolveToolPath('cortex_write.py',
    path.join(os.homedir(), '.local/bin/cortex_write.py'));

// Default config
const DEFAULT_CONFIG = {
    hotkey: 'Ctrl+Shift+Space',
    mouseButton: null,
    model: 'llama3.2',
    provider: 'ollama',
    autoRoute: true,
    excludedApps: [],
    toolbarFirst: false,  // toolbar removed in v4.2 — direct-to-overlay activation
    customActions: [],
    providers: {}
};

function stripHtml(str) {
    return (str || '').replace(/<[^>]*>/g, '').trim();
}

function loadConfig() {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        if (fs.existsSync(CONFIG_PATH)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            const merged = { ...DEFAULT_CONFIG, ...data };
            // Sanitize custom actions
            if (Array.isArray(merged.customActions)) {
                merged.customActions = merged.customActions.map(a => ({
                    label: stripHtml(a.label || '').substring(0, 30),
                    prompt: stripHtml(a.prompt || ''),
                    type: a.type || 'text'
                }));
            }
            return merged;
        }
    } catch (e) {
        console.error('Config load error:', e.message);
    }
    return { ...DEFAULT_CONFIG };
}

function saveConfig(config) {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('Config save error:', e.message);
    }
}

function pruneScreenshots(dir) {
    try {
        const files = fs.readdirSync(dir)
            .filter(f => f.endsWith('.png'))
            .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);
        if (files.length > SCREENSHOT_RETENTION) {
            for (const f of files.slice(SCREENSHOT_RETENTION)) {
                fs.unlinkSync(path.join(dir, f.name));
            }
        }
    } catch (e) { /* best-effort cleanup */ }
}

let config = loadConfig();
let activeModel = config.model;
let activeProvider = config.provider || 'ollama';
let activeProviderOpts = providers.getProviderOpts(activeProvider, config.providers);
let autoRoute = config.autoRoute;
let conversationHistory = [];
let mainWindow;
let toolbarWindow;
let lookupWindow;
let lookupDismissTimer = null;
let lookupSelectionPoller = null;
let lookupReadyHandler = null;  // Bug fix: targeted removal instead of removeAllListeners
let activeLlmPaintedHandler = null;  // Bug fix: track persistent on-handler so it can always be cleaned up
let toolbarShowPending = false;
let toolbarDismissTimer = null;
let toolbarSelectionPoller = null;
let toolbarShowTimer = null;
let triggerServer = null;  // Bug fix: hoist to module scope so we can close before respawn

function clearToolbarTimers() {
    if (toolbarShowTimer) { clearTimeout(toolbarShowTimer); toolbarShowTimer = null; }
    if (toolbarDismissTimer) { clearTimeout(toolbarDismissTimer); toolbarDismissTimer = null; }
    if (toolbarSelectionPoller) { clearInterval(toolbarSelectionPoller); toolbarSelectionPoller = null; }
}
let snipWindow;
let tray;
let mouseListenerProc = null;
let isPinned = false;
let pendingContext = '';
let clipboardHistory = [];
const CLIPBOARD_MAX = 20;
let lastClipText = '';
let detectedLanguage = null;  // { lang: 'python', label: 'Python', badge: 'PY' }
let sourceFilePath = null;  // Feature 5: detected source file from active window
// Blueprint Printer — no separate window needed; renders in mainWindow overlay

function startClipboardHistory() {
    setInterval(() => {
        try {
            const text = clipboard.readText();
            if (text && text.trim() && text !== lastClipText) {
                lastClipText = text;
                const truncated = text.trim().substring(0, CLIPBOARD_ENTRY_MAX);
                clipboardHistory.unshift({ text: truncated, time: Date.now() });
                if (clipboardHistory.length > CLIPBOARD_MAX) {
                    clipboardHistory.pop();
                }
            }
        } catch (e) { }
    }, 2000);
}

// ── Blueprint Printer ──────────────────────────────────────
// Slides out as a snapped BrowserWindow to the right of mainWindow.
const MANIFESTO_BASE = 'http://127.0.0.1:8420';
const BLUEPRINT_POLL_MS = 1500;
const BLUEPRINT_MAX_POLLS = 120;

// ── Manifesto Engine Subprocess Lifecycle ──────────────────
let _engineProc = null;          // child_process ref
let _engineReady = false;        // true once health-check passes
let _engineRestarts = 0;         // crash restart counter
const ENGINE_MAX_RESTARTS = 3;
const ENGINE_RESTART_DELAY = 3000;
const ENGINE_HEALTH_URL = MANIFESTO_BASE + '/api/health';

function getEngineConfig() {
    // Pull from Locus config or fall back to reasonable defaults
    const ec = (config && config.blueprintEngine) || {};
    return {
        enabled: ec.enabled !== false, // default on
        path: ec.path || path.join(os.homedir(), 'Desktop/Agent_System/DB-Memory/Manifesto-Engine'),
        model: ec.model || 'llama3.2',
        apiKey: ec.apiKey || '',
        port: ec.port || 8420,
    };
}

function startManifestoEngine() {
    const ec = getEngineConfig();
    if (!ec.enabled) return;
    if (_engineProc && !_engineProc.killed) return; // already running

    const serverPath = path.join(ec.path, 'server.py');
    if (!fs.existsSync(serverPath)) {
        console.warn('[Engine] server.py not found at', serverPath);
        return;
    }

    const env = {
        ...process.env,
        MANIFESTO_PORT: String(ec.port),
        OLLAMA_MODEL: ec.model,
        ...(ec.apiKey ? { OPENAI_API_KEY: ec.apiKey } : {}),
    };

    console.log('[Engine] Spawning Manifesto Engine at', ec.path);
    _engineReady = false;
    _engineProc = require('child_process').spawn('python3', ['server.py'], {
        cwd: ec.path,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    _engineProc.stdout.on('data', (d) => {
        const line = d.toString().trim();
        if (line) console.log('[Engine]', line);
    });
    _engineProc.stderr.on('data', (d) => {
        const line = d.toString().trim();
        if (line) console.warn('[Engine:err]', line);
    });

    _engineProc.on('exit', (code, signal) => {
        _engineReady = false;
        _engineProc = null;
        if (signal === 'SIGTERM' || signal === 'SIGKILL') return; // intentional kill
        if (_engineRestarts < ENGINE_MAX_RESTARTS) {
            _engineRestarts++;
            console.log(`[Engine] Crashed (${code}), restarting in ${ENGINE_RESTART_DELAY}ms (attempt ${_engineRestarts}/${ENGINE_MAX_RESTARTS})`);
            setTimeout(startManifestoEngine, ENGINE_RESTART_DELAY);
        } else {
            console.error('[Engine] Max restarts reached — giving up.');
        }
    });

    // Begin health-check polling
    waitForEngine(ec.port, 30000).then((ok) => {
        if (ok) {
            _engineReady = true;
            _engineRestarts = 0; // reset on successful start
            console.log('[Engine] Ready ✓');
            // Broadcast to UI so Blueprint button lights up
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('engine-state', { ready: true });
            }
        } else {
            console.warn('[Engine] Health-check timed out — engine may not respond');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('engine-state', { ready: false });
            }
        }
    });
}

function waitForEngine(port, timeoutMs) {
    return new Promise((resolve) => {
        const deadline = Date.now() + timeoutMs;
        const url = `http://127.0.0.1:${port}/api/health`;

        function poll() {
            if (Date.now() > deadline) { resolve(false); return; }
            const req = http.get(url, { timeout: 2000 }, (res) => {
                resolve(res.statusCode === 200);
            });
            req.on('error', () => setTimeout(poll, 1500));
            req.on('timeout', () => { req.destroy(); setTimeout(poll, 1500); });
        }
        setTimeout(poll, 1500); // first check after 1.5s
    });
}

function stopManifestoEngine() {
    if (_engineProc && !_engineProc.killed) {
        console.log('[Engine] Stopping child process…');
        _engineProc.kill('SIGTERM');
        setTimeout(() => { // force kill after 3s if still alive
            if (_engineProc && !_engineProc.killed) _engineProc.kill('SIGKILL');
        }, 3000);
    }
    _engineProc = null;
    _engineReady = false;
}

// Snap guard — prevents setPosition→move→setPosition infinite loop on Linux/X11
let _isSnapping = false;

// ── Throttled snap batching (60fps) — fixes panel lag on Linux/X11 ──
let _snapPending = false;
const SNAP_THROTTLE_MS = 16; // ~60fps

function scheduleSnapAll() {
    if (_snapPending) return;
    _snapPending = true;
    setTimeout(() => {
        _snapPending = false;
        snapAllPanels();
    }, SNAP_THROTTLE_MS);
}

function snapAllPanels() {
    if (_isSnapping) return;
    _isSnapping = true;
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            const [mx, my] = mainWindow.getPosition();
            const [mw, mh] = mainWindow.getSize();

            // Companion: east of main
            if (companionPanel && !companionPanel.isDestroyed()) {
                companionPanel.setPosition(mx + mw, my);
                companionPanel.setSize(companionPanel.getSize()[0], mh);
            }
        }
    } finally {
        _isSnapping = false;
    }
}

// ── Companion Panel (replaces Blueprint + Teach + Deep Dive) ────────────
let companionPanel = null;
let _companionMoveHandler = null;
let _sseReq = null;    // active SSE connection (blueprint)
let _teachReq = null;  // active streamChat request (teach)
let _ddRequest = null;  // active streamChat request (deep dive)

let _companionSelectionPoller = null;
let _lastPolledSelection = '';

function openCompanionPanel(mode, text) {
    if (companionPanel && !companionPanel.isDestroyed()) {
        companionPanel.show();
        // Switch tab if already open
        companionPanel.webContents.send('companion-switch', { mode, text: text || '' });
        return companionPanel;
    }

    const [mx, my] = mainWindow.getPosition();
    const [mw, mh] = mainWindow.getSize();

    companionPanel = new BrowserWindow({
        width: 480,
        height: mh,
        x: mx + mw,
        y: my,
        frame: false,
        transparent: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: true,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    companionPanel.loadFile(path.join(__dirname, 'companion-panel.html'));
    companionPanel.webContents.once('did-finish-load', () => {
        if (companionPanel && !companionPanel.isDestroyed()) {
            companionPanel.show();
            companionPanel.webContents.send('companion-switch', { mode, text: text || '' });
        }
    });

    _companionMoveHandler = () => scheduleSnapAll();
    mainWindow.on('move', _companionMoveHandler);
    mainWindow.on('resize', _companionMoveHandler);
    companionPanel.on('move', () => scheduleSnapAll());

    // Start selection poller — watches for new highlights while companion is open
    _lastPolledSelection = text || '';
    startCompanionSelectionPoller();

    companionPanel.on('closed', () => {
        companionPanel = null;
        stopCompanionSelectionPoller();
        if (_sseReq) { try { _sseReq.destroy(); } catch (e) { } _sseReq = null; }
        if (_teachReq) { try { _teachReq.destroy?.() || _teachReq.abort?.(); } catch (e) { } _teachReq = null; }
        if (_ddRequest) { try { _ddRequest.destroy?.() || _ddRequest.abort?.(); } catch (e) { } _ddRequest = null; }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.removeListener('move', _companionMoveHandler);
            mainWindow.removeListener('resize', _companionMoveHandler);
        }
        broadcastPanelState();
    });

    // Keep companion visible when pinned — X11 hides alwaysOnTop windows on desktop click
    companionPanel.on('blur', () => {
        if (isPinned && companionPanel && !companionPanel.isDestroyed()) {
            setTimeout(() => {
                if (companionPanel && !companionPanel.isDestroyed() && isPinned) {
                    companionPanel.moveTop();
                }
            }, 30);
        }
    });

    return companionPanel;
}

function startCompanionSelectionPoller() {
    stopCompanionSelectionPoller();
    _companionSelectionPoller = setInterval(() => {
        if (!companionPanel || companionPanel.isDestroyed()) {
            stopCompanionSelectionPoller();
            return;
        }
        getPrimarySelection().then(sel => {
            if (!sel || sel.trim().length < 1) return;
            const trimmed = sel.trim();
            // Only push if selection actually changed
            if (trimmed === _lastPolledSelection) return;
            _lastPolledSelection = trimmed;
            // Push to companion panel
            companionPanel.webContents.send('companion-context-update', trimmed);
            // Quietly update main overlay context box (no show animation)
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('context-update-quiet', trimmed);
            }
        }).catch(() => { /* ignore polling errors */ });
    }, 500);
}

function stopCompanionSelectionPoller() {
    if (_companionSelectionPoller) {
        clearInterval(_companionSelectionPoller);
        _companionSelectionPoller = null;
    }
}

function sendToCompanion(channel, data) {
    if (companionPanel && !companionPanel.isDestroyed()) {
        companionPanel.webContents.send(channel, data);
    }
}

function broadcastPanelState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('panel-state', {
        companion: !!(companionPanel && !companionPanel.isDestroyed() && companionPanel.isVisible()),
    });
}

// Auto-push new highlighted text to the companion panel (if open)
function pushContextToCompanion(text) {
    if (!text || text.trim().length < 1) return;
    if (!companionPanel || companionPanel.isDestroyed() || !companionPanel.isVisible()) return;
    // Send to whatever tab is active — companion-switch updates preview
    companionPanel.webContents.send('companion-context-update', text.trim());
}

// ── Cascade Close — reverse-order staggered panel closing ──────────────
function cascadeClose(cb) {
    const STAGGER = 100;
    let chain = Promise.resolve();

    // Companion panel
    if (companionPanel && !companionPanel.isDestroyed() && companionPanel.isVisible()) {
        chain = chain.then(() => new Promise(resolve => {
            companionPanel.webContents.send('close-panel');
            setTimeout(() => {
                if (companionPanel && !companionPanel.isDestroyed()) companionPanel.close();
                resolve();
            }, STAGGER + 180);
        }));
    }

    chain.then(() => { if (cb) cb(); });
}

// Terminal child process — runs inside companion panel now
let _termChildProc = null;

// Legacy aliases — route to companion panel
function openBlueprintPanel() { return openCompanionPanel('blueprint'); }
function sendToPanel(channel, data) { sendToCompanion(channel, data); }
function sendToTeach(channel, data) { sendToCompanion(channel, data); }
function sendToDeepDive(channel, data) { sendToCompanion(channel, data); }
function sendBlueprintError(msg) { sendToCompanion('bp-error', msg); }

function blueprintPrint(text, opts = {}) {
    if (!text || text.length < 10) return;

    // ── Free tier gate ──────────────────────────────────────────────
    // Blueprint Printer requires Manifesto Engine. All other features
    // (Fix, Explain, Teach Me, Deep Dive, Review, etc.) work without it.
    if (!_engineReady) {
        const panel = openCompanionPanel('blueprint', text);
        const errPayload = {
            type: 'engine-offline',
            message: [
                '**Blueprint Printer requires Manifesto Engine.**',
                '',
                'All other Locus features (Fix, Explain, Teach Me, Deep Dive, Review) work without it.',
                '',
                'To enable Blueprint:',
                '1. Install Manifesto Engine locally, or',
                '2. Configure a remote ME endpoint in `~/.config/locus/config.json`',
                '',
                '[manifesto-engine.com](https://manifesto-engine.com)',
            ].join('\n'),
        };
        panel.webContents.once('did-finish-load', () => sendToCompanion('bp-error', errPayload.message));
        if (!panel.webContents.isLoading()) sendToCompanion('bp-error', errPayload.message);
        return;
    }
    // ── END free tier gate ──────────────────────────────────────────

    const panel = openCompanionPanel('blueprint', text);
    const initPayload = { prompt: text, mode: opts.mode || 'blueprint' };
    panel.webContents.once('did-finish-load', () => sendToCompanion('bp-init', initPayload));
    if (!panel.webContents.isLoading()) sendToCompanion('bp-init', initPayload);

    // POST to Manifesto Engine
    const postData = JSON.stringify({ prompt: text });
    const reqUrl = new URL(MANIFESTO_BASE + '/api/ignite');
    const req = http.request({
        hostname: reqUrl.hostname,
        port: reqUrl.port,
        path: reqUrl.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 10000,
    }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (res.statusCode !== 200) {
                    sendToCompanion('bp-error', data.detail || ('HTTP ' + res.statusCode));
                    return;
                }
                if (data.session_id) {
                    const sid = data.session_id;
                    sendToCompanion('bp-init', { prompt: text, sessionId: sid });
                    startBlueprintSSE(sid);
                    pollForBlueprint(sid, 0);
                } else {
                    sendToCompanion('bp-error', 'No session ID from Manifesto Engine');
                }
            } catch (e) {
                sendToCompanion('bp-error', 'Parse error: ' + e.message);
            }
        });
    });

    req.on('error', (e) => {
        const msg = e.code === 'ECONNREFUSED'
            ? 'Manifesto Engine not running — start with ./launch.sh'
            : 'Connection failed: ' + e.message;
        sendToCompanion('bp-error', msg);
    });

    req.on('timeout', () => { req.destroy(); sendToCompanion('bp-error', 'Connection timed out'); });
    req.write(postData);
    req.end();
}

function startBlueprintSSE(sessionId) {
    if (_sseReq) { try { _sseReq.destroy(); } catch (e) { } }
    const sseUrl = new URL(MANIFESTO_BASE + '/api/progress?session_id=' + sessionId);
    let buf = '';

    _sseReq = http.request({
        hostname: sseUrl.hostname,
        port: sseUrl.port,
        path: sseUrl.pathname + sseUrl.search,
        method: 'GET',
        headers: { 'Accept': 'text/event-stream' },
    }, (res) => {
        res.on('data', (chunk) => {
            buf += chunk.toString();
            let lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                try {
                    const ev = JSON.parse(line.slice(5).trim());
                    if (ev.done) { _sseReq = null; return; }
                    sendToCompanion('bp-progress', {
                        pct: ev.pct || 0,
                        status: ev.status || ev.stage || 'Processing…',
                    });
                } catch (e) { /* malformed line, skip */ }
            }
        });
        res.on('end', () => { _sseReq = null; });
        res.on('error', () => { _sseReq = null; });
    });

    _sseReq.on('error', () => { _sseReq = null; });
    _sseReq.end();
}

function pollForBlueprint(sessionId, attempt) {
    if (attempt >= BLUEPRINT_MAX_POLLS) {
        sendToCompanion('bp-error', 'Timed out after 3 minutes.');
        return;
    }

    setTimeout(() => {
        const pollUrl = new URL(MANIFESTO_BASE + '/api/session/' + sessionId + '/status');
        const req = http.request({
            hostname: pollUrl.hostname,
            port: pollUrl.port,
            path: pollUrl.pathname,
            method: 'GET',
            timeout: 8000,
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.status === 'generating') {
                        pollForBlueprint(sessionId, attempt + 1);
                    } else if (data.status === 'ready') {
                        if (_sseReq) { try { _sseReq.destroy(); } catch (e) { } _sseReq = null; }
                        sendToCompanion('bp-ready', {
                            manifesto: data.manifesto,
                            blueprint_type: data.blueprint_type,
                            domains_matched: data.domains_matched,
                        });
                    } else if (data.status === 'error') {
                        sendToCompanion('bp-error', data.error || 'Generation failed');
                    } else {
                        if (data.manifesto) {
                            sendToCompanion('bp-ready', { manifesto: data.manifesto });
                        } else {
                            pollForBlueprint(sessionId, attempt + 1);
                        }
                    }
                } catch (e) {
                    pollForBlueprint(sessionId, attempt + 1);
                }
            });
        });
        req.on('error', () => pollForBlueprint(sessionId, attempt + 1));
        req.on('timeout', () => { req.destroy(); pollForBlueprint(sessionId, attempt + 1); });
        req.end();
    }, BLUEPRINT_POLL_MS);
}


function createWindow() {
    mainWindow = new BrowserWindow({
        width: 420,
        height: 500,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        resizable: true,
        minWidth: 320,
        minHeight: 300,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('src/index.html');

    // Debounced blur: prevents premature hide during toolbar→overlay transitions
    let blurTimer = null;
    mainWindow.on('blur', () => {
        if (!isPinned) {
            if (blurTimer) clearTimeout(blurTimer);
            blurTimer = setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
                    // Don't hide if companion panel has focus
                    const companionFocused = companionPanel && !companionPanel.isDestroyed() && companionPanel.isFocused();
                    if (companionFocused) return;
                    mainWindow.hide();
                }
            }, 150);
        }
    });
}

function createToolbarWindow() {
    toolbarWindow = new BrowserWindow({
        width: 420,
        height: 36,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        resizable: false,
        focusable: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    toolbarWindow.loadFile('src/toolbar.html');
}

function createLookupWindow() {
    lookupWindow = new BrowserWindow({
        width: 320,
        height: 160,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        resizable: false,
        focusable: false, // Don't steal focus from the active app
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            backgroundThrottling: false  // Bug fix: without this, Electron throttles timers in hidden windows → signalPainted never fires on second lookup
        }
    });

    lookupWindow.loadFile('src/lookup.html');
}

function dismissLookup() {
    if (lookupDismissTimer) { clearTimeout(lookupDismissTimer); lookupDismissTimer = null; }
    if (lookupSelectionPoller) { clearInterval(lookupSelectionPoller); lookupSelectionPoller = null; }
    if (lookupWindow && !lookupWindow.isDestroyed() && lookupWindow.isVisible()) {
        lookupWindow.hide();
    }
}

// Fetch a structured definition from the Free Dictionary API (no API key required).
// Resolves with the entry object (word, phonetic, audioUrl, meanings, synonyms, antonyms) or null.
function fetchDictionaryEntry(word) {
    return new Promise((resolve) => {
        const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
        const mod = require('https');
        const request = mod.get(url, { timeout: 3000 }, (res) => {
            if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
            let raw = '';
            res.on('data', d => { raw += d; });
            res.on('end', () => {
                try {
                    const entries = JSON.parse(raw);
                    if (!Array.isArray(entries) || entries.length === 0) { resolve(null); return; }
                    const entry = entries[0];

                    // Phonetic text + first available audio URL
                    const phonetics = entry.phonetics || [];
                    const phonetic = entry.phonetic || phonetics.map(p => p.text).find(t => t) || '';
                    const audioUrl = phonetics.map(p => p.audio).find(a => a && a.endsWith('.mp3')) || '';

                    // Top 2 meanings with definitions
                    const meanings = (entry.meanings || []).slice(0, 2).map(m => ({
                        pos: m.partOfSpeech,
                        defs: (m.definitions || []).slice(0, 2).map(d => ({
                            def: d.definition,
                            ex: d.example || ''
                        }))
                    }));

                    // Collect unique synonyms + antonyms across all meanings (top 6 each)
                    const synSet = new Set();
                    const antSet = new Set();
                    for (const m of (entry.meanings || [])) {
                        for (const s of (m.synonyms || [])) synSet.add(s);
                        for (const a of (m.antonyms || [])) antSet.add(a);
                    }

                    resolve({
                        word: entry.word,
                        phonetic,
                        audioUrl,
                        meanings,
                        synonyms: [...synSet].slice(0, 6),
                        antonyms: [...antSet].slice(0, 4)
                    });
                } catch { resolve(null); }
            });
        });
        request.on('error', () => resolve(null));
        request.on('timeout', () => { request.destroy(); resolve(null); });
    });
}

// Fetch a Wikipedia summary for proper nouns, names, and concepts the dictionary misses.
// Resolves with { title, description, extract } or null on miss/error.
function fetchWikipediaEntry(term) {
    return new Promise((resolve) => {
        const encoded = encodeURIComponent(term);
        const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
        const mod = require('https');
        const options = {
            timeout: 3000,
            headers: { 'User-Agent': 'Locus/3.0 (Electron; Linux)' }
        };
        const request = mod.get(url, options, (res) => {
            if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
            let raw = '';
            res.on('data', d => { raw += d; });
            res.on('end', () => {
                try {
                    const data = JSON.parse(raw);
                    // Skip disambiguation pages
                    if (data.type === 'disambiguation') { resolve(null); return; }
                    resolve({
                        title: data.title || term,
                        description: data.description || '',
                        extract: data.extract
                            ? data.extract.split('.').slice(0, 2).join('.').trim() + '.'
                            : ''
                    });
                } catch { resolve(null); }
            });
        });
        request.on('error', () => resolve(null));
        request.on('timeout', () => { request.destroy(); resolve(null); });
    });
}

function quickLookup(text) {
    if (!lookupWindow || lookupWindow.isDestroyed()) createLookupWindow();

    // Always clean up any stale LLM-painted handler from a previous lookup before starting a new one.
    // Without this, the old handler fires on the new lookup's lookup-painted signals and shows
    // the window at the wrong position (the ghost black box).
    if (activeLlmPaintedHandler) {
        ipcMain.removeListener('lookup-painted', activeLlmPaintedHandler);
        activeLlmPaintedHandler = null;
    }

    const term = text.trim();
    if (!term || term.length > 500) return; // v4.0: raised limit from 100 to 500 for code/stack traces

    // Safety net: if renderer hasn't loaded yet (edge case — we preload at startup),
    // defer until did-finish-load so lookup-clear is never sent to a deaf renderer.
    if (lookupWindow.webContents.isLoading()) {
        lookupWindow.webContents.once('did-finish-load', () => quickLookup(text));
        return;
    }

    // Dismiss toolbar if visible — lookup and toolbar are mutually exclusive
    if (toolbarWindow && toolbarWindow.isVisible()) toolbarWindow.hide();

    try {
        const point = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(point);
        const bounds = display.workArea;

        let x = Math.min(point.x - 140, bounds.x + bounds.width - 290);
        let y = Math.max(point.y - 100, bounds.y);
        x = Math.max(x, bounds.x);

        lookupWindow.setPosition(x, y);

        // Hard auto-dismiss
        if (lookupDismissTimer) clearTimeout(lookupDismissTimer);
        lookupDismissTimer = setTimeout(dismissLookup, 12000);

        // Clear renderer DOM and wait for ACK before sending any content.
        if (lookupReadyHandler) {
            ipcMain.removeListener('lookup-ready', lookupReadyHandler);
            lookupReadyHandler = null;
        }

        // v4.0 CONTEXT ENGINE: classify selection type
        const classification = contextEngine.classifySelection(term);
        const handler = contextEngine.getHandler(classification.type);

        // v4.0 KNOWLEDGE MESH: check for cached result
        const cached = knowledgeMesh.recall(term);

        lookupReadyHandler = () => {
            lookupReadyHandler = null;

            // If we have a fresh cached result (freshness > 0.3), show it instantly
            if (cached && cached.freshness > 0.3) {
                const onCachedPainted = (ev, contentH) => {
                    if (!lookupWindow || lookupWindow.isDestroyed()) return;
                    const h = Math.min(Math.max(contentH + 22, 60), 320);
                    lookupWindow.setSize(340, h);
                    lookupWindow.show();
                    if (lookupSelectionPoller) clearInterval(lookupSelectionPoller);
                    lookupSelectionPoller = setInterval(() => {
                        getPrimarySelection().then(sel => {
                            if ((!sel || !sel.trim()) && lookupWindow && !lookupWindow.isDestroyed() && lookupWindow.isVisible()) {
                                dismissLookup();
                            }
                        }).catch(() => { });
                    }, 300);
                };
                ipcMain.once('lookup-painted', onCachedPainted);
                // Show cached result with memory indicator
                lookupWindow.webContents.send('lookup-dict', {
                    word: cached.node.term,
                    phonetic: `📌 From memory (${Math.round(cached.freshness * 100)}% fresh)`,
                    audioUrl: '',
                    meanings: [{ pos: cached.node.source, defs: [{ def: cached.node.definition, ex: '' }] }],
                    synonyms: [],
                    antonyms: [],
                });
                contextEngine.addToSession(term, classification.type, cached.node.definition.substring(0, 100));
                return;
            }

            // Route based on classification type
            if (classification.type === contextEngine.TYPES.WORD) {
                // Original chain: Dictionary → Wikipedia → LLM
                fetchDictionaryEntry(term).then(entry => {
                    if (entry && lookupWindow && !lookupWindow.isDestroyed()) {
                        const onDictPainted = (ev, contentH) => {
                            if (!lookupWindow || lookupWindow.isDestroyed()) return;
                            const h = Math.min(Math.max(contentH + 22, 60), 320);
                            lookupWindow.setSize(340, h);
                            lookupWindow.show();
                            if (lookupSelectionPoller) clearInterval(lookupSelectionPoller);
                            lookupSelectionPoller = setInterval(() => {
                                getPrimarySelection().then(sel => {
                                    if ((!sel || !sel.trim()) && lookupWindow && !lookupWindow.isDestroyed() && lookupWindow.isVisible()) {
                                        dismissLookup();
                                    }
                                }).catch(() => { });
                            }, 300);
                        };
                        ipcMain.once('lookup-painted', onDictPainted);
                        lookupWindow.webContents.send('lookup-dict', entry);
                        // v4.0: cache the result
                        const defText = entry.meanings.map(m => m.defs.map(d => d.def).join('; ')).join(' | ');
                        knowledgeMesh.storeNode(term, defText, 'dictionary');
                        contextEngine.addToSession(term, classification.type, defText.substring(0, 100));
                    } else {
                        fetchWikipediaEntry(term).then(wiki => {
                            if (wiki && lookupWindow && !lookupWindow.isDestroyed()) {
                                const onWikiPainted = (ev, contentH) => {
                                    if (!lookupWindow || lookupWindow.isDestroyed()) return;
                                    const h = Math.min(Math.max(contentH + 22, 60), 320);
                                    lookupWindow.setSize(340, h);
                                    lookupWindow.show();
                                    if (lookupSelectionPoller) clearInterval(lookupSelectionPoller);
                                    lookupSelectionPoller = setInterval(() => {
                                        getPrimarySelection().then(sel => {
                                            if ((!sel || !sel.trim()) && lookupWindow && !lookupWindow.isDestroyed() && lookupWindow.isVisible()) {
                                                dismissLookup();
                                            }
                                        }).catch(() => { });
                                    }, 300);
                                };
                                ipcMain.once('lookup-painted', onWikiPainted);
                                lookupWindow.webContents.send('lookup-wiki', wiki);
                                knowledgeMesh.storeNode(term, wiki.extract, 'wikipedia');
                                contextEngine.addToSession(term, classification.type, wiki.extract.substring(0, 100));
                            } else {
                                runLlmLookup(term);
                            }
                        });
                    }
                });
            } else if (handler.mode === 'llm' || handler.mode === 'toolbar') {
                // v4.1: Senior Engineer Mode — use code-engine expert prompts
                const expert = codeEngine.getExpertPrompt(term, classification.type);
                runLlmLookup(term, expert.system);
            } else {
                // Fallback: expert prompt with session context
                const expert = codeEngine.getExpertPrompt(term, classification.type);
                const sessionCtx = contextEngine.getSessionContext();
                const sysPrompt = sessionCtx
                    ? expert.system + '\n\nPRIOR CONTEXT:\n' + sessionCtx
                    : expert.system;
                runLlmLookup(term, sysPrompt);
            }
        };
        ipcMain.once('lookup-ready', lookupReadyHandler);

        lookupWindow.webContents.send('lookup-clear');
    } catch (err) {
        console.error('Quick lookup error:', err.message);
    }
}

// ── User-friendly error messages ─────────────────────
function friendlyError(raw) {
    const r = (raw || '').toLowerCase();
    if (r.includes('socket hang up')) return 'Model is loading — try again in a moment';
    if (r.includes('econnrefused')) return "Can't reach the AI provider — is it running?";
    if (r.includes('401') || r.includes('403') || r.includes('unauthorized') || r.includes('invalid api'))
        return 'API key invalid or expired — check Settings ⚙';
    if (r.includes('429') || r.includes('rate'))
        return 'Rate limited — wait a moment and try again';
    if (r.includes('timeout') || r.includes('timed out'))
        return 'Request timed out — try a shorter selection';
    if (r.includes('enotfound')) return 'Provider not reachable — check your internet connection';
    if (r.includes('model') && r.includes('not found'))
        return 'Model not found — check Settings ⚙';
    return 'Something went wrong: ' + raw;
}

function runLlmLookup(term, systemPrompt) {
    if (!lookupWindow || lookupWindow.isDestroyed()) return;
    lookupWindow.webContents.send('lookup-term', term);

    const lookupModel = activeModel;
    const sysContent = systemPrompt || 'Define the term in one concise sentence. No preamble.';
    const messages = [
        { role: 'system', content: sysContent },
        { role: 'user', content: term }
    ];

    // Bug fix: don't show window on first chunk — renderer hasn't painted yet.
    // lookup-done triggers signalPainted() in the renderer, which sends lookup-painted.
    // We wait for that ACK before calling show(), same pattern as dict/wiki paths.
    let lookupShown = false;

    // Register the show handler before streaming starts so it's ready when done fires.
    const onLlmPainted = (ev, contentH) => {
        if (!lookupWindow || lookupWindow.isDestroyed()) return;
        const h = Math.min(Math.max(contentH + 22, 60), 320);
        lookupWindow.setSize(340, h);
        if (!lookupShown) {
            lookupWindow.show();
            lookupShown = true;
            if (lookupSelectionPoller) clearInterval(lookupSelectionPoller);
            lookupSelectionPoller = setInterval(() => {
                getPrimarySelection().then(sel => {
                    if ((!sel || !sel.trim()) && lookupWindow && !lookupWindow.isDestroyed() && lookupWindow.isVisible()) {
                        dismissLookup();
                    }
                }).catch(() => { });
            }, 300);
        }
    };
    // Store in module variable so quickLookup can clean it up if a new lookup starts
    activeLlmPaintedHandler = onLlmPainted;
    ipcMain.on('lookup-painted', onLlmPainted);

    providers.streamChat(activeProvider, activeProviderOpts, lookupModel, messages,
        (chunk) => {
            if (lookupWindow && !lookupWindow.isDestroyed()) {
                lookupWindow.webContents.send('lookup-chunk', chunk);
            }
        },
        () => {
            ipcMain.removeListener('lookup-painted', onLlmPainted);
            if (activeLlmPaintedHandler === onLlmPainted) activeLlmPaintedHandler = null;
            if (lookupWindow && !lookupWindow.isDestroyed()) {
                lookupWindow.webContents.send('lookup-done');
                // Safety: if lookup-painted never fires (e.g. renderer unloaded)
                // still show the window after 400ms so we don't ghost forever.
                setTimeout(() => {
                    if (!lookupShown && lookupWindow && !lookupWindow.isDestroyed()) {
                        lookupWindow.show();
                        lookupShown = true;
                    }
                }, 400);
            }
        },
        (err) => {
            ipcMain.removeListener('lookup-painted', onLlmPainted);
            if (activeLlmPaintedHandler === onLlmPainted) activeLlmPaintedHandler = null;
            if (lookupWindow && !lookupWindow.isDestroyed()) {
                const friendly = friendlyError(err);
                lookupWindow.webContents.send('lookup-error', friendly);
                if (!lookupShown) { lookupWindow.show(); lookupShown = true; }
                if (lookupDismissTimer) clearTimeout(lookupDismissTimer);
                lookupDismissTimer = setTimeout(dismissLookup, 4000);
            }
        }
    );
}

let preCapturedImage = null;

function createSnipWindow() {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.bounds;

    snipWindow = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: width,
        height: height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        resizable: false,
        fullscreen: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    snipWindow.loadFile('src/snip-overlay.html');
}

async function startRegionCapture() {
    // 1. Hide all Locus windows
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
    if (toolbarWindow && toolbarWindow.isVisible()) toolbarWindow.hide();
    if (lookupWindow && lookupWindow.isVisible()) lookupWindow.hide();

    // 2. Wait for windows to fully hide
    await new Promise(r => setTimeout(r, 250));

    // 3. Pre-capture the full screen BEFORE showing snip overlay
    try {
        const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1920, height: 1080 }
        });

        if (sources.length === 0) {
            console.error('Region capture: no screen source');
            return;
        }

        preCapturedImage = sources[0].thumbnail;

        // 4. Show the snip overlay (reload to reset canvas state)
        if (!snipWindow || snipWindow.isDestroyed()) {
            createSnipWindow();
        }
        // Always reload to get a clean canvas
        snipWindow.webContents.removeAllListeners('did-finish-load');
        snipWindow.loadFile('src/snip-overlay.html');
        snipWindow.webContents.once('did-finish-load', () => {
            snipWindow.show();
            snipWindow.focus();
        });
    } catch (err) {
        console.error('Region capture failed:', err.message);
    }
}
function getPrimarySelection() {
    return platform.getSelection();
}

// streamOllama removed — now handled by providers/ollama.js via providers.streamChat()

function recallCortex(query) {
    return new Promise((resolve) => {
        child_process.execFile(
            PYTHON_PATH,
            [CORTEX_RECALL, query, '--top-k', '3', '--json'],
            { timeout: 5000 },
            (error, stdout) => {
                if (error || !stdout) {
                    resolve([]);
                    return;
                }
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    resolve([]);
                }
            }
        );
    });
}

// Curated model pool — best-in-class per role, no duplicates
const MODEL_POOL = {
    '⚡ Fast': [
        { name: 'llama3.2:latest', label: 'Llama 3.2 (3.2B, Q4)' },
        { name: 'qwen3.5:2b', label: 'Qwen 3.5 (2.3B, Q8)' },
    ],
    '🔧 Code': [
        { name: 'deepseek-coder-v2:lite', label: 'DeepSeek Coder v2 (15.7B, Q4)' },
        { name: 'qwen3.5:4b', label: 'Qwen 3.5 (4.7B, Q4)' },
    ],
    '🧠 Deep': [
        { name: 'qwen3:8b', label: 'Qwen 3 (8.2B, Q4)' },
    ],
    '🎯 Cortex': [
        { name: 'cortex-bridge-v4:latest', label: 'Cortex Bridge v4 (3.2B, F16)' },
    ],
    '👁️ Vision': [
        { name: 'moondream:latest', label: 'Moondream (1B, Q4)' },
    ]
};

// Auto-routing: map quick actions to optimal model roles
const ACTION_ROUTES = {
    'fix': '🔧 Code',
    'optimize': '🔧 Code',
    'test': '🔧 Code',
    'review': '🧠 Deep',
    'diagnose': '🧠 Deep',
    'explain': '⚡ Fast',
    'rewrite': '⚡ Fast',
    'simplify': '⚡ Fast',
    'translate': '⚡ Fast',
    'summarize': '⚡ Fast',
    'reply': '⚡ Fast',
    'document': '⚡ Fast',
    'search': '⚡ Fast',
    'define': '⚡ Fast',
};

// Round-robin counters per role — cycle through models in each pool
const rotationCounters = {};

/**
 * Get the best model + provider for a given action.
 * Uses task-based routing (ACTION_ROUTES) with round-robin within each pool.
 * Dynamically merges cloud models into pools when API keys are available.
 * @param {string} action - The toolbar action (fix, optimize, etc.)
 * @returns {{ provider: string, providerOpts: object, model: string }}
 */
function getModelForAction(action) {
    const role = ACTION_ROUTES[action];
    if (!role || !MODEL_POOL[role] || MODEL_POOL[role].length === 0) {
        return { provider: activeProvider, providerOpts: activeProviderOpts, model: activeModel };
    }

    // Build the effective pool: local models + any cloud models for this role
    const effectivePool = [];

    // Add local (Ollama) models
    for (const m of MODEL_POOL[role]) {
        effectivePool.push({ ...m, provider: 'ollama' });
    }

    // Merge cloud models into appropriate pools when API keys are configured
    const available = providers.getAvailableProviders(config.providers);
    for (const provName of available) {
        if (provName === 'ollama') continue;
        const cloudModels = providers.getCloudModels(provName);
        for (const cm of cloudModels) {
            // Route cloud models to roles based on naming conventions
            const isSmall = /mini|haiku|flash/i.test(cm.name);
            const targetRole = isSmall ? '⚡ Fast' : '🧠 Deep';
            if (targetRole === role) {
                effectivePool.push({ ...cm, provider: provName });
            }
        }
    }

    if (effectivePool.length === 0) {
        return { provider: activeProvider, providerOpts: activeProviderOpts, model: activeModel };
    }

    // Round-robin: advance counter for this role
    if (!(role in rotationCounters)) rotationCounters[role] = 0;
    const idx = rotationCounters[role] % effectivePool.length;
    rotationCounters[role]++;

    const selected = effectivePool[idx];
    const selProvider = selected.provider || 'ollama';
    const selOpts = providers.getProviderOpts(selProvider, config.providers);

    return { provider: selProvider, providerOpts: selOpts, model: selected.name };
}

async function buildTrayMenu() {
    const providerLabel = activeProvider === 'openai'
        ? (activeProviderOpts.baseUrl || '').includes('nvidia') ? 'NVIDIA NIM' : 'OpenAI'
        : activeProvider === 'anthropic' ? 'Anthropic' : 'Ollama';

    const contextMenu = Menu.buildFromTemplate([
        { label: `${providerLabel} — ${activeModel}`, enabled: false },
        { type: 'separator' },
        { label: 'Clear Conversation', click: () => { conversationHistory = []; mainWindow?.webContents.send('conversation-cleared'); } },
        { label: '📷 Region Capture', accelerator: 'Ctrl+Shift+S', click: () => { startRegionCapture(); } },
        {
            label: '🔧 Blueprint Printer', accelerator: 'Ctrl+Shift+B', click: () => {
                const text = clipboard.readText().trim();
                if (text && text.length >= 10) {
                    blueprintPrint(text);
                } else {
                    dialog.showMessageBox({
                        type: 'warning',
                        title: 'Blueprint Printer',
                        message: 'Clipboard is empty or text is too short. Copy some text first.',
                    });
                }
            }
        },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.quit(); } }
    ]);

    tray.setContextMenu(contextMenu);
    tray.setToolTip('Locus — ' + activeModel + ' (' + providerLabel + ')');
}

function createTray() {
    const iconPath = path.join(__dirname, 'locus-tray.png');
    const icon = nativeImage.createFromPath(iconPath);

    tray = new Tray(icon);
    tray.setToolTip('Locus — ' + activeModel);

    // Left-click opens Settings window
    tray.on('click', () => {
        openSettingsWindow();
    });

    buildTrayMenu().catch(() => { });
}

// ── Settings Window ──────────────────────────────────

let settingsWindow = null;

function openSettingsWindow() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 500, height: 580,
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
        }
    });

    settingsWindow.loadFile('src/settings.html');
    settingsWindow.on('closed', () => { settingsWindow = null; });
}

// Settings IPC handlers — registered in app.whenReady()
function registerSettingsIPC() {
    ipcMain.handle('get-config', () => {
        return { ...config };
    });

    ipcMain.handle('get-autostart', () => {
        return setup.isAutostartEnabled();
    });

    ipcMain.handle('get-session-stats', () => {
        try {
            const statsFile = path.join(app.getPath('userData'), 'stats.json');
            if (fs.existsSync(statsFile)) {
                return JSON.parse(fs.readFileSync(statsFile, 'utf8'));
            }
        } catch (e) { /* best effort */ }
        return { messages: 0, sessionsToday: 0, modelUsage: {}, actionUsage: {} };
    });

    ipcMain.handle('save-settings', (event, settings) => {
        // Apply provider
        const oldHotkey = config.hotkey;
        config.provider = settings.provider || config.provider;
        config.model = settings.model || config.model;
        const rawHotkey = settings.hotkey;
        const isValidHotkey = rawHotkey && !rawHotkey.includes('Press') && !rawHotkey.includes('...') && rawHotkey.length < 30;
        config.hotkey = isValidHotkey ? rawHotkey : config.hotkey;
        // Apply activation mode live — this is the missing piece
        const newMouseButton = settings.mouseButton || null;
        const newHighlight = settings.highlightActivation;
        const activationChanged =
            newMouseButton !== config.mouseButton ||
            newHighlight !== config.highlightActivation;

        config.highlightActivation = newHighlight;
        config.mouseButton = newMouseButton;

        if (activationChanged) {
            if (newMouseButton) {
                setMouseButton(newMouseButton);
            } else if (newHighlight) {
                setHighlightActivation(true);
            } else {
                // Keyboard-only: kill any running listener
                setHighlightActivation(false);
            }
        }

        config.autoRoute = settings.autoRoute;
        config.providers = settings.providers || config.providers;

        // Blueprint Engine — merge and restart if credentials changed
        if (settings.blueprintEngine) {
            const prev = JSON.stringify(config.blueprintEngine || {});
            config.blueprintEngine = { ...(config.blueprintEngine || {}), ...settings.blueprintEngine };
            if (JSON.stringify(config.blueprintEngine) !== prev) {
                stopManifestoEngine();
                setTimeout(startManifestoEngine, 500);
            }
        }

        // Apply live
        activeProvider = config.provider;
        activeProviderOpts = providers.getProviderOpts(activeProvider, config.providers);
        activeModel = config.model;
        autoRoute = config.autoRoute;

        // Save
        saveConfig(config);

        // Autostart
        if (settings.autostart !== undefined) {
            setup.setAutostart(settings.autostart);
        }

        // Rebuild UI
        if (tray && !tray.isDestroyed()) {
            tray.setToolTip('Locus — ' + activeModel + ' (' + activeProvider + ')');
        }
        buildTrayMenu().catch(() => { });

        // Re-register hotkey if changed
        if (isValidHotkey && config.hotkey !== oldHotkey) {
            rebindHotkey(config.hotkey);
        }

        // Health check with new provider
        checkProviderHealth();

        console.log(`[settings] Applied: provider=${activeProvider}, model=${activeModel}`);
        return { ok: true };
    });

    ipcMain.handle('test-provider', async (event, settings) => {
        const providerName = settings.provider || 'ollama';
        const providerOpts = providers.getProviderOpts(providerName, settings.providers || {});

        try {
            const ok = await providers.healthCheck(providerName, providerOpts);
            if (ok) {
                return { ok: true, message: 'Connected to ' + providerName };
            }
            return { ok: false, message: providerName + ' is not reachable' };
        } catch (e) {
            return { ok: false, message: e.message };
        }
    });
}

function syncCustomActions() {
    const actions = config.customActions || [];
    if (toolbarWindow) {
        toolbarWindow.webContents.send('set-custom-actions', actions);
    }
    if (mainWindow) {
        mainWindow.webContents.send('set-custom-actions', actions);
    }
}

// --- Hotkey Management ---

function getActiveWindowClass() {
    return platform.getActiveWindowClass();
}

// --- Activation cooldown: prevent rapid-fire stacking ---
const ACTIVATION_COOLDOWN_MS = 80;  // Reduced: fast enough for rapid re-highlighting
let activationLocked = false;
let lastHighlightText = '';  // Track last highlight for plugin execution

function withActivationLock(fn) {
    if (activationLocked) return;
    activationLocked = true;
    setTimeout(() => { activationLocked = false; }, ACTIVATION_COOLDOWN_MS);
    fn();
}

function invokeLocusOverlay() {
    withActivationLock(() => {
        dismissLookup();
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
            mainWindow.hide();
            return;
        }
        // Hide toolbar if visible — don't return early, fall through to show overlay
        if (toolbarWindow && !toolbarWindow.isDestroyed() && toolbarWindow.isVisible()) {
            clearToolbarTimers();
            toolbarWindow.hide();
        }
        showOverlayAtCursor().catch(err => {
            console.error('showOverlay failed, forcing show:', err.message);
            try {
                const point = screen.getCursorScreenPoint();
                mainWindow.setPosition(point.x, point.y);
                mainWindow.show();
            } catch (e) { console.error('Fallback show failed:', e.message); }
        });
    });
}

function highlightInvoke() {
    withActivationLock(() => {
        dismissLookup();
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
            // Selection came from within Locus itself — don't clobber the context
            if (mainWindow.isFocused()) return;
            getPrimarySelection().then(text => {
                if (text) {
                    lastHighlightText = text;  // Track for plugins
                    if (isPinned) {
                        mainWindow.webContents.send('context-append', text);
                    } else {
                        mainWindow.webContents.send('context-captured', text);
                        pushContextToCompanion(text);
                    }
                }
            }).catch(err => console.error('highlight context update failed:', err.message));
            return;
        }
        // Always do full hide→reposition→showInactive cycle via showOverlayAtCursor.
        // Do NOT early-return when toolbar is visible — X11 won't re-raise a
        // transparent window that was repositioned with setPosition() while visible.
        if (toolbarWindow && !toolbarWindow.isDestroyed() && toolbarWindow.isVisible()) {
            clearToolbarTimers();
            toolbarWindow.hide();
        }
        showOverlayAtCursor().catch(err => {
            console.error('showOverlay failed on highlight, forcing show:', err.message);
            try {
                const point = screen.getCursorScreenPoint();
                mainWindow.setPosition(point.x, point.y);
                mainWindow.show();
            } catch (e) { console.error('Fallback show failed:', e.message); }
        });
    });
}

function detectContentType(text) {
    if (!text || !text.trim()) return 'text';
    const t = text.trim();

    // Error detection: stack traces, error messages
    if (/^(Traceback|Error|Exception|TypeError|SyntaxError|ReferenceError|ValueError)/m.test(t) ||
        /at\s+\S+\s+\(/.test(t) || /File ".*", line \d+/m.test(t)) {
        return 'error';
    }

    // Code detection: syntax patterns
    var codeSignals = 0;
    if (/[{};]/.test(t)) codeSignals++;
    if (/^\s*(def |function |class |const |let |var |import |from |return |if \(|for \()/m.test(t)) codeSignals++;
    if (/=>|->|\|\||&&/.test(t)) codeSignals++;
    if (/^\s{2,}\S/m.test(t)) codeSignals++; // indented lines
    if (/\.(py|js|ts|go|rs|java|cpp|c|rb|sh)$/m.test(t)) codeSignals++;
    if (codeSignals >= 2) return 'code';

    return 'text';
}

// Language detection — pattern-based fingerprinting for highlighted code.
// Returns { lang, label, badge } or null for non-code / ambiguous text.
function detectLanguage(text) {
    if (!text || !text.trim()) return null;
    const t = text.trim();
    const lines = t.split('\n');
    const first = lines[0];

    // Shebang detection
    if (first.startsWith('#!')) {
        if (/python/.test(first)) return { lang: 'python', label: 'Python', badge: 'PY' };
        if (/node|deno|bun/.test(first)) return { lang: 'javascript', label: 'JavaScript', badge: 'JS' };
        if (/bash|sh$/.test(first)) return { lang: 'shell', label: 'Shell', badge: 'SH' };
        if (/ruby/.test(first)) return { lang: 'ruby', label: 'Ruby', badge: 'RB' };
        if (/perl/.test(first)) return { lang: 'perl', label: 'Perl', badge: 'PL' };
    }

    // Score-based detection — accumulate evidence
    const scores = {};
    function bump(lang, n) { scores[lang] = (scores[lang] || 0) + n; }

    // Python
    if (/^(def |class |import |from \S+ import |async def )/m.test(t)) bump('python', 3);
    if (/\bself\b/.test(t)) bump('python', 2);
    if (/^\s*@\w+/m.test(t) && /def /.test(t)) bump('python', 2);
    if (/:$/m.test(t) && /^\s{4}/m.test(t)) bump('python', 1);
    if (/\b(elif|except|finally|yield|lambda)\b/.test(t)) bump('python', 2);
    if (/\bprint\s*\(/.test(t)) bump('python', 1);

    // JavaScript / TypeScript
    if (/\b(const |let |var )\w+\s*=/.test(t)) bump('javascript', 2);
    if (/=>/.test(t)) bump('javascript', 2);
    if (/\bfunction\s+\w+\s*\(/.test(t)) bump('javascript', 2);
    if (/\b(async |await )/.test(t)) bump('javascript', 1);
    if (/\brequire\s*\(/.test(t)) bump('javascript', 2);
    if (/\bconsole\.log\b/.test(t)) bump('javascript', 2);
    if (/\bexport\s+(default|const|function|class)\b/.test(t)) bump('javascript', 2);
    // TypeScript-specific
    if (/:\s*(string|number|boolean|void|any|unknown|never)\b/.test(t)) bump('typescript', 3);
    if (/\binterface\s+\w+/.test(t)) bump('typescript', 3);
    if (/\b(type|enum)\s+\w+\s*[={]/.test(t)) bump('typescript', 3);
    if (/\bas\s+\w+/.test(t) && /:\s*\w+/.test(t)) bump('typescript', 2);

    // Go
    if (/\bfunc\s+(\w+\s*)?\(/.test(t)) bump('go', 3);
    if (/\b(package|fmt\.|:=)/.test(t)) bump('go', 3);
    if (/\bgo\s+func\b/.test(t)) bump('go', 2);
    if (/\bdefer\s+/.test(t)) bump('go', 2);

    // Rust
    if (/\b(fn |let mut |impl |pub fn |struct \w+ \{|enum \w+ \{)/.test(t)) bump('rust', 3);
    if (/\b(unwrap|expect|Ok\(|Err\(|Some\(|None)\b/.test(t)) bump('rust', 2);
    if (/->\s*(\w+|&)/.test(t) && !/=>/.test(t)) bump('rust', 1);

    // Java / Kotlin / C#
    if (/\b(public|private|protected)\s+(static\s+)?(void|int|String|class)\b/.test(t)) bump('java', 3);
    if (/System\.out\.print/.test(t)) bump('java', 2);

    // C / C++
    if (/^#include\s*[<"]/.test(t)) bump('cpp', 3);
    if (/\b(printf|malloc|sizeof|nullptr|std::)\b/.test(t)) bump('cpp', 2);

    // Shell
    if (/^\s*(if \[|fi$|done$|esac$|then$)/m.test(t)) bump('shell', 2);
    if (/\$\{?\w+\}?/.test(t) && !/\$\{.*\}/.test(t.replace(/\$\{\w+\}/g, ''))) bump('shell', 1);
    if (/\b(echo |apt |sudo |chmod |grep |awk |sed )/.test(t)) bump('shell', 2);

    // HTML / CSS
    if (/^\s*<(!DOCTYPE|html|div|span|head|body|script|style|link|meta)/m.test(t)) bump('html', 3);
    if (/^\s*[.#@]\w+.*\{/m.test(t) && /:\s*[\w#].*;/m.test(t)) bump('css', 3);

    // SQL
    if (/\b(SELECT|INSERT INTO|CREATE TABLE|ALTER TABLE|DROP |UPDATE .+ SET)\b/i.test(t)) bump('sql', 3);

    // Pick the highest score
    const entries = Object.entries(scores);
    if (entries.length === 0) return null;
    entries.sort((a, b) => b[1] - a[1]);
    const [top, topScore] = entries[0];
    if (topScore < 2) return null;  // Not enough evidence

    // If typescript scored high but javascript also did, prefer typescript
    if (top === 'javascript' && (scores.typescript || 0) >= 3) {
        return { lang: 'typescript', label: 'TypeScript', badge: 'TS' };
    }

    const LANG_MAP = {
        python: { lang: 'python', label: 'Python', badge: 'PY' },
        javascript: { lang: 'javascript', label: 'JavaScript', badge: 'JS' },
        typescript: { lang: 'typescript', label: 'TypeScript', badge: 'TS' },
        go: { lang: 'go', label: 'Go', badge: 'GO' },
        rust: { lang: 'rust', label: 'Rust', badge: 'RS' },
        java: { lang: 'java', label: 'Java', badge: 'JV' },
        cpp: { lang: 'cpp', label: 'C/C++', badge: 'C+' },
        shell: { lang: 'shell', label: 'Shell', badge: 'SH' },
        html: { lang: 'html', label: 'HTML', badge: 'HT' },
        css: { lang: 'css', label: 'CSS', badge: 'CS' },
        sql: { lang: 'sql', label: 'SQL', badge: 'SQ' },
    };
    return LANG_MAP[top] || null;
}

// Feature 4: Stack trace parser — extracts file paths and line numbers from common stack trace formats.
function parseStackTrace(text) {
    if (!text) return [];
    const locations = [];
    const seen = new Set();

    // Python: File "path", line N
    const pyRe = /File "([^"]+)",\s*line (\d+)/g;
    let m;
    while ((m = pyRe.exec(text)) !== null) {
        const key = m[1] + ':' + m[2];
        if (!seen.has(key)) { seen.add(key); locations.push({ file: m[1], line: parseInt(m[2]), col: 0 }); }
    }

    // Node.js: at Something (/path/to/file.js:line:col) or at /path/to/file.js:line:col
    const nodeRe = /at\s+(?:\S+\s+)?\(?(\/[^:)]+):(\d+)(?::(\d+))?\)?/g;
    while ((m = nodeRe.exec(text)) !== null) {
        const key = m[1] + ':' + m[2];
        if (!seen.has(key)) { seen.add(key); locations.push({ file: m[1], line: parseInt(m[2]), col: parseInt(m[3] || '0') }); }
    }

    // Go: /path/file.go:line
    const goRe = /(\/\S+\.go):(\d+)/g;
    while ((m = goRe.exec(text)) !== null) {
        const key = m[1] + ':' + m[2];
        if (!seen.has(key)) { seen.add(key); locations.push({ file: m[1], line: parseInt(m[2]), col: 0 }); }
    }

    // Rust: --> path/file.rs:line:col
    const rustRe = /-->\s+(\S+):(\d+):(\d+)/g;
    while ((m = rustRe.exec(text)) !== null) {
        const key = m[1] + ':' + m[2];
        if (!seen.has(key)) { seen.add(key); locations.push({ file: m[1], line: parseInt(m[2]), col: parseInt(m[3]) }); }
    }

    // Generic: /absolute/path.ext:line (catch-all for other formats)
    const genericRe = /(\/[\w.\-\/]+\.[a-zA-Z]{1,4}):(\d+)/g;
    while ((m = genericRe.exec(text)) !== null) {
        const key = m[1] + ':' + m[2];
        if (!seen.has(key)) { seen.add(key); locations.push({ file: m[1], line: parseInt(m[2]), col: 0 }); }
    }

    return locations;
}

// Feature 5: Read the active window title to detect source file path.
// Works with VSCode, Cursor, terminals, etc.
function getActiveWindowFile() {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        exec('xdotool getactivewindow getwindowname 2>/dev/null', { timeout: 1000 }, (err, stdout) => {
            if (err || !stdout) return resolve(null);
            const title = stdout.trim();

            // VSCode/Cursor: "filename.py — folder — Visual Studio Code" or "filename.py - folder - Cursor"
            const vsMatch = title.match(/^(\S+)\s+[\u2014\-]\s+(.+?)\s+[\u2014\-]\s+(Visual Studio Code|Cursor|Code - OSS|VSCodium)/);
            if (vsMatch) {
                const fileName = vsMatch[1];
                const folder = vsMatch[2];
                // Try to resolve full path
                const fullPath = require('path').resolve(folder, fileName);
                if (require('fs').existsSync(fullPath)) return resolve(fullPath);
                return resolve(fileName);
            }

            // Vim/Neovim: "filename.py - VIM" or "NVIM"
            const vimMatch = title.match(/^(\S+).*\s[\-\u2014]\s+(N?VIM)/);
            if (vimMatch) return resolve(vimMatch[1]);

            // Terminal titles often contain paths
            const pathMatch = title.match(/(\/[\w.\-\/]+\.[a-zA-Z]{1,6})/);
            if (pathMatch && require('fs').existsSync(pathMatch[1])) return resolve(pathMatch[1]);

            resolve(null);
        });
    });
}

async function showOverlayAtCursor() {
    try {
        // Run exclusion check and selection read in PARALLEL (both spawn subprocesses)
        const hasExclusions = config.excludedApps && config.excludedApps.length > 0;
        const [appClass, text] = await Promise.all([
            hasExclusions ? getActiveWindowClass() : Promise.resolve(''),
            getPrimarySelection()
        ]);

        // Per-app exclusion check (only if exclusion list is non-empty)
        if (hasExclusions && config.excludedApps.some(ex => appClass.includes(ex.toLowerCase()))) {
            return;
        }

        pendingContext = text;

        const point = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(point);
        const bounds = display.workArea;

        // Detect content type and language BEFORE toolbar/overlay fork
        // so both branches can use them (fixes "contentType is not defined" crash)
        const contentType = detectContentType(text);
        detectedLanguage = detectLanguage(text);

        if (config.toolbarFirst && toolbarWindow) {
            // Dismiss lookup if visible — toolbar and lookup are mutually exclusive
            dismissLookup();

            const ACTION_COUNTS = { code: 5, error: 3, text: 7 };
            const customCount = (config.customActions || []).filter(ca => ca.type === 'all' || ca.type === contentType).length;
            const totalBtns = (ACTION_COUNTS[contentType] || 5) + customCount + 1; // +1 for Chat
            const toolbarW = Math.min(55 + totalBtns * 60, 600);

            // CRITICAL: hide before setSize() to prevent X11 compositor ghost artifact.
            toolbarWindow.hide();
            toolbarWindow.setSize(toolbarW, 36);

            let x = Math.min(point.x - Math.round(toolbarW / 2), bounds.x + bounds.width - toolbarW - 10);
            let y = Math.max(point.y - 46, bounds.y);
            x = Math.max(x, bounds.x);

            toolbarWindow.setPosition(x, y);

            toolbarWindow.webContents.send('set-content-type', contentType);
            toolbarWindow.webContents.send('set-custom-actions', config.customActions || []);
            toolbarWindow.webContents.send('set-language', detectedLanguage);

            // Feature 4: Parse stack traces for error content
            if (contentType === 'error') {
                const stackLocations = parseStackTrace(text);
                if (stackLocations.length > 0) {
                    // Send to both toolbar and overlay
                    if (toolbarWindow && !toolbarWindow.isDestroyed()) {
                        toolbarWindow.webContents.send('stack-trace-parsed', stackLocations);
                    }
                }
            }

            // Show only when renderer has actually painted — no blank flash
            clearToolbarTimers();
            function doShowToolbar() {
                if (toolbarShowTimer) { clearTimeout(toolbarShowTimer); toolbarShowTimer = null; }
                ipcMain.removeListener('toolbar-painted', doShowToolbar);
                if (toolbarWindow && !toolbarWindow.isDestroyed()) {
                    toolbarWindow.showInactive();
                    // Hard ceiling: dismiss after 4s no matter what
                    toolbarDismissTimer = setTimeout(() => {
                        if (toolbarWindow && !toolbarWindow.isDestroyed() && toolbarWindow.isVisible()) {
                            clearToolbarTimers();
                            toolbarWindow.hide();
                        }
                    }, 4000);
                    // Poll selection every 300ms — dismiss instantly when text is deselected
                    toolbarSelectionPoller = setInterval(() => {
                        getPrimarySelection().then(sel => {
                            if ((!sel || !sel.trim()) && toolbarWindow && !toolbarWindow.isDestroyed() && toolbarWindow.isVisible()) {
                                clearToolbarTimers();
                                toolbarWindow.hide();
                            }
                        }).catch(() => { });
                    }, 300);
                }
            }
            ipcMain.once('toolbar-painted', doShowToolbar);
            // Safety: show after 200ms regardless if IPC signal never arrives
            toolbarShowTimer = setTimeout(doShowToolbar, 200);
        } else {
            let x = Math.min(point.x, bounds.x + bounds.width - 430);
            let y = Math.min(point.y, bounds.y + bounds.height - 510);
            x = Math.max(x, bounds.x);
            y = Math.max(y, bounds.y);

            mainWindow.setPosition(x, y);
            mainWindow.show();
            lastHighlightText = text;  // Track for plugins
            mainWindow.webContents.send('context-captured', text);
            pushContextToCompanion(text);
            mainWindow.webContents.send('model-changed', activeModel);
            mainWindow.webContents.send('set-custom-actions', config.customActions || []);
            mainWindow.webContents.send('set-language', detectedLanguage);

            // Feature 4: Parse stack traces for error content
            if (contentType === 'error') {
                const stackLocations = parseStackTrace(text);
                if (stackLocations.length > 0) {
                    mainWindow.webContents.send('stack-trace-parsed', stackLocations);
                }
            }

            // Feature 5: Detect source file from active window
            getActiveWindowFile().then(filePath => {
                sourceFilePath = filePath;
                if (filePath && mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('source-file-detected', filePath);
                }
            }).catch(() => { });
        }
    } catch (err) {
        console.error('showOverlayAtCursor error:', err.message);
        // Last-resort fallback: just show the window
        try {
            const point = screen.getCursorScreenPoint();
            mainWindow.setPosition(point.x, point.y);
            mainWindow.show();
        } catch (e) { /* truly fatal */ }
    }
}

function rebindHotkey(newHotkey) {
    globalShortcut.unregisterAll();

    if (!VALID_HOTKEY.test(newHotkey)) {
        console.error('Invalid hotkey rejected:', newHotkey);
        globalShortcut.register(config.hotkey, invokeLocusOverlay);
        return;
    }
    const registered = globalShortcut.register(newHotkey, invokeLocusOverlay);
    if (registered) {
        config.hotkey = newHotkey;
        saveConfig(config);
        console.log('Hotkey changed to:', newHotkey);
        buildTrayMenu().catch(() => { });
    } else {
        console.error('Failed to register hotkey:', newHotkey);
        globalShortcut.register(config.hotkey, invokeLocusOverlay);
    }
}

// --- Mouse Button Binding ---

function setMouseButton(buttonNum) {
    if (mouseListenerProc) {
        try { mouseListenerProc.kill(); } catch (e) { }
        mouseListenerProc = null;
    }

    config.mouseButton = buttonNum;
    config.highlightActivation = false;
    saveConfig(config);
    buildTrayMenu().catch(() => { });

    if (buttonNum) {
        startMouseListener(buttonNum);
    }
}

function setHighlightActivation(enabled) {
    if (mouseListenerProc) {
        try { mouseListenerProc.kill(); } catch (e) { }
        mouseListenerProc = null;
    }

    config.highlightActivation = enabled;
    config.mouseButton = null;
    saveConfig(config);
    buildTrayMenu().catch(() => { });

    if (enabled) {
        startHighlightListener();
    }
}

function startMouseListener(buttonNum) {
    const script = `
import subprocess, sys, socket, json
try:
    from pynput import mouse
except ImportError:
    sys.exit(1)

TARGET_BUTTON = mouse.Button.x1 if ${buttonNum} == 8 else (mouse.Button.x2 if ${buttonNum} == 9 else mouse.Button.middle)
TRIGGER_PORT = ${TRIGGER_PORT}

def on_click(x, y, button, pressed):
    if button == TARGET_BUTTON and pressed:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.connect(('127.0.0.1', TRIGGER_PORT))
            s.sendall(json.dumps({"trigger": "highlight"}).encode())
            s.close()
        except:
            pass

with mouse.Listener(on_click=on_click) as listener:
    listener.join()
`;

    mouseListenerProc = child_process.spawn(PYTHON_PATH, ['-c', script], {
        stdio: 'ignore',
        detached: true,
        env: platform.getSpawnEnv()
    });

    mouseListenerProc.on('error', (err) => {
        console.error('Mouse listener error:', err.message);
    });

    console.log('Mouse button', buttonNum, 'mapped to Locus invoke');
}

// Backoff state for highlight listener respawn
let _hlRestartDelay = 2000;    // starts at 2s
let _hlFailCount = 0;           // consecutive failures
const HL_MAX_FAILURES = 10;     // give up after this many in a row
const HL_MAX_DELAY = 30000;     // cap at 30s

function startHighlightListener() {
    // Bug fix: close existing trigger server before creating a new one.
    // Without this, respawn after pynput exit causes EADDRINUSE on port 19275.
    if (triggerServer) {
        try { triggerServer.close(); } catch (e) { }
        triggerServer = null;
    }

    // Start a tiny TCP server so the pynput script can signal Electron directly
    const net = require('net');
    triggerServer = net.createServer((socket) => {
        let data = '';
        socket.on('data', (chunk) => { data += chunk; });
        socket.on('end', () => {
            try {
                const msg = JSON.parse(data);
                if (msg.trigger === 'highlight') {
                    // All selections go through the toolbar — Define button is there for lookups.
                    // No more auto-popup on short words.
                    highlightInvoke();
                } else if (msg.trigger === 'region-capture') {
                    // Shift+Drag → open precision snip overlay
                    startRegionCapture();
                } else if (msg.trigger === 'dismiss') {
                    // Single click (unhighlight) → dismiss toolbar + lookup instantly
                    clearToolbarTimers();
                    if (toolbarWindow && !toolbarWindow.isDestroyed() && toolbarWindow.isVisible()) {
                        toolbarWindow.hide();
                    }
                    dismissLookup();
                }
            } catch (e) { }
        });
    });

    triggerServer.listen(TRIGGER_PORT, '127.0.0.1', () => {
        console.log('Highlight trigger server on port', TRIGGER_PORT);
    });

    triggerServer.on('error', (err) => {
        console.error('Trigger server error:', err.message);
    });

    // Spawn the pynput drag detector
    const script = `
import subprocess, sys, time, threading, socket, json
try:
    from pynput import mouse, keyboard
except ImportError:
    sys.exit(1)

drag_start = None
drag_end = None
is_dragging = False
last_selection = ""
last_trigger_time = 0
shift_held = False
DRAG_THRESHOLD = 15
DWELL_MS = 0.05   # Reduced: 50ms is enough for selection to stabilise after mouseup
DEBOUNCE_S = 0.25 # Rapid re-highlight: cancel pending trigger if a new mouseup fires within 250ms
TRIGGER_PORT = ${TRIGGER_PORT}
pending_fire_timer = None

${platform.getPynputSelectionCode()}

def send_trigger(payload):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.connect(('127.0.0.1', TRIGGER_PORT))
        s.sendall(json.dumps(payload).encode())
        s.close()
    except:
        pass

def fire_locus(prev_sel=""):
    global last_selection, last_trigger_time, pending_fire_timer
    # Debounce: if another mouseup fires quickly, the timer gets cancelled and restarted.
    # This means rapid highlights always respond to the LATEST selection, never silently drop.
    def _do_fire():
        global last_selection, last_trigger_time, pending_fire_timer
        pending_fire_timer = None
        sel = get_selection()
        if sel and sel != prev_sel and len(sel) > 1:
            last_selection = sel
            last_trigger_time = time.time()
            send_trigger({"trigger": "highlight"})
            def clear_last():
                global last_selection
                time.sleep(10)
                last_selection = ""
            threading.Thread(target=clear_last, daemon=True).start()
    if pending_fire_timer is not None:
        pending_fire_timer.cancel()
    pending_fire_timer = threading.Timer(DWELL_MS, _do_fire)
    pending_fire_timer.start()
last_region_time = 0  # separate cooldown from fire_locus

def fire_region_capture(sx, sy, ex, ey):
    global last_region_time
    now = time.time()
    if now - last_region_time < 1.0:  # own cooldown, independent of highlights
        return
    last_region_time = time.time()
    x = min(sx, ex)
    y = min(sy, ey)
    w = abs(ex - sx)
    h = abs(ey - sy)
    if w > 20 and h > 20:
        send_trigger({"trigger": "region-capture", "x": x, "y": y, "width": w, "height": h})

# Keyboard listener for Shift detection
def on_key_press(key):
    global shift_held
    if key in (keyboard.Key.shift, keyboard.Key.shift_r):
        shift_held = True

def on_key_release(key):
    global shift_held
    if key in (keyboard.Key.shift, keyboard.Key.shift_r):
        shift_held = False

kb_listener = keyboard.Listener(on_press=on_key_press, on_release=on_key_release)
kb_listener.daemon = True
kb_listener.start()

sel_at_press = ""
pending_click_timer = None  # debounce timer for non-drag clicks (handles double-click)

def _capture_sel_at_press():
    global sel_at_press
    sel_at_press = get_selection() or ""

def on_click(x, y, button, pressed):
    global drag_start, drag_end, is_dragging, sel_at_press, pending_click_timer
    if button != mouse.Button.left:
        return
    if pressed:
        drag_start = (x, y)
        is_dragging = False
        sel_at_press = ""  # reset immediately; background thread will fill it
        threading.Thread(target=_capture_sel_at_press, daemon=True).start()
    else:
        drag_end = (x, y)
        if is_dragging and drag_start:
            dx = abs(x - drag_start[0])
            dy = abs(y - drag_start[1])
            if dx > DRAG_THRESHOLD or dy > DRAG_THRESHOLD:
                if shift_held:
                    threading.Thread(target=fire_region_capture, args=(drag_start[0], drag_start[1], x, y), daemon=True).start()
                else:
                    # Pass pre-drag snapshot — scrollbar drags won't change selection
                    threading.Thread(target=fire_locus, args=(sel_at_press,), daemon=True).start()
        else:
            # No drag — could be single click (deselect) OR double-click (word select).
            # Debounce with 200ms: double-click fires two mouseups ~100ms apart.
            # Cancel previous timer so only the LAST mouseup check runs.
            # By then, the word is fully selected and we detect it.
            if pending_click_timer is not None:
                pending_click_timer.cancel()
            snap = sel_at_press  # capture current value for closure
            def _check_click_sel():
                global pending_click_timer
                pending_click_timer = None
                sel = get_selection()
                if sel and len(sel) > 1 and sel != snap:
                    fire_locus(snap)
                elif not sel or len(sel.strip()) == 0:
                    send_trigger({"trigger": "dismiss"})
                # If sel == snap and non-empty, user clicked on already-selected text — do nothing
            pending_click_timer = threading.Timer(0.20, _check_click_sel)
            pending_click_timer.start()
        drag_start = None
        is_dragging = False



def on_move(x, y):
    global is_dragging
    if drag_start:
        dx = abs(x - drag_start[0])
        dy = abs(y - drag_start[1])
        if dx > DRAG_THRESHOLD or dy > DRAG_THRESHOLD:
            is_dragging = True

with mouse.Listener(on_click=on_click, on_move=on_move) as listener:
    listener.join()
`;

    mouseListenerProc = child_process.spawn(PYTHON_PATH, ['-c', script], {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: true,
        env: platform.getSpawnEnv()
    });

    mouseListenerProc.stderr.on('data', (data) => {
        console.error('Highlight listener stderr:', data.toString().trim());
    });

    mouseListenerProc.on('error', (err) => {
        console.error('Highlight listener error:', err.message);
    });

    mouseListenerProc.on('exit', (code) => {
        _hlFailCount++;
        if (_hlFailCount > HL_MAX_FAILURES) {
            console.warn('Highlight listener failed ' + _hlFailCount + ' times — giving up. Restart Locus to re-enable.');
            return;
        }
        console.warn('Highlight listener exited (code ' + code + '), respawning in ' + (_hlRestartDelay / 1000) + 's (attempt ' + _hlFailCount + ')...');
        setTimeout(() => {
            startHighlightListener();
        }, _hlRestartDelay);
        _hlRestartDelay = Math.min(_hlRestartDelay * 2, HL_MAX_DELAY);  // exponential backoff
    });

    // Reset backoff if listener stays alive for 10+ seconds (X11 healthy)
    const _hlGraceTimer = setTimeout(() => {
        _hlFailCount = 0;
        _hlRestartDelay = 2000;
    }, 10000);
    mouseListenerProc.once('exit', () => clearTimeout(_hlGraceTimer));

    console.log('Highlight activation enabled — drag to select text, Locus auto-invokes');
}

// Kill orphaned pynput listeners from previous sessions
function cleanupZombies() {
    try {
        platform.cleanupListeners();
    } catch (e) { }
}

// Check if the active provider is reachable
function checkProviderHealth() {
    providers.healthCheck(activeProvider, activeProviderOpts).then(ok => {
        if (ok) {
            console.log(activeProvider + ': online');
        } else {
            console.warn(activeProvider + ': offline or misconfigured');
            if (activeProvider === 'ollama') {
                notifyOllamaOffline();
            }
        }
    }).catch(e => console.warn('Health check failed:', e.message));
}

function notifyOllamaOffline() {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.once('did-finish-load', () => {
            mainWindow.webContents.send('ollama-status', 'offline');
        });
    }
}

app.whenReady().then(() => {
    cleanupZombies();
    createWindow();
    // Toolbar removed — direct-to-overlay activation is cleaner
    createLookupWindow();  // Bug fix: preload so renderer is ready before first quickLookup
    createTray();
    registerSettingsIPC();
    checkProviderHealth();
    startManifestoEngine(); // Spawn Blueprint Engine alongside Locus

    // v4.1: Auto-model selection — pick the best model that's loaded in VRAM
    if (activeProvider === 'ollama') {
        providers.autoSelectModel(activeProviderOpts).then(({ model, reason }) => {
            if (model && model !== activeModel) {
                console.log(`[auto-model] Selected: ${model} (${reason})`);
                activeModel = model;
                if (tray && !tray.isDestroyed()) {
                    tray.setToolTip('Locus — ' + activeModel + ' (auto)');
                }
            }
        }).catch(e => console.warn('[auto-model] Failed:', e.message));
    }

    // First-launch: show onboarding wizard + bootstrap Python in background
    if (!setup.isSetupDone()) {
        // Bootstrap Python silently
        setup.runFirstLaunch((status) => {
            console.log('Setup:', status);
        });
        // Show welcome wizard
        const welcomeWin = new BrowserWindow({
            width: 520, height: 420,
            frame: false,
            resizable: false,
            center: true,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
            }
        });
        welcomeWin.loadFile('src/welcome.html');
        ipcMain.once('welcome-done', () => {
            welcomeWin.close();
        });
    }

    // Preload the active model and keep it warm with periodic pings
    function keepModelWarm() {
        providers.keepWarm(activeProvider, activeProviderOpts, activeModel);
    }
    keepModelWarm();
    setInterval(keepModelWarm, 2 * 60 * 1000);  // ping every 2 min

    // Register the configured hotkey
    const registered = globalShortcut.register(config.hotkey, invokeLocusOverlay);

    if (!registered) {
        console.error('Failed to register global shortcut:', config.hotkey);
    } else {
        console.log('Locus ready. Invoke with', config.hotkey);
    }

    // Region capture hotkey
    globalShortcut.register('Ctrl+Shift+S', startRegionCapture);

    // Clipboard history
    startClipboardHistory();
    globalShortcut.register('Ctrl+Shift+V', () => {
        if (clipboardHistory.length === 0) return;
        // Show clipboard history in overlay
        const point = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(point);
        const bounds = display.workArea;
        let x = Math.min(point.x - 210, bounds.x + bounds.width - 430);
        let y = Math.min(point.y - 100, bounds.y + bounds.height - 510);
        x = Math.max(x, bounds.x);
        y = Math.max(y, bounds.y);
        mainWindow.setPosition(x, y);
        mainWindow.showInactive();
        mainWindow.webContents.send('clipboard-history', clipboardHistory);
    });

    // Blueprint Printer hotkey — opens panel directly, no overlay interference
    globalShortcut.register('Ctrl+Shift+B', () => {
        const text = clipboard.readText().trim();
        if (text && text.length >= 10) {
            blueprintPrint(text);
        } else {
            // Nothing useful in clipboard — open Locus so user can type a prompt
            invokeLocusOverlay();
        }
    });

    // Start activation listener if configured
    if (config.mouseButton) {
        startMouseListener(config.mouseButton);
    } else if (config.highlightActivation) {
        startHighlightListener();
    }

    // Toolbar-first IPC: user clicked an action in the compact bar
    ipcMain.on('toolbar-action', (event, action) => {
        // 'define' is handled inline — shows lookup overlay without opening main window.
        if (action === 'define') {
            clearToolbarTimers();
            if (toolbarWindow) toolbarWindow.hide();
            quickLookup(pendingContext);
            return;
        }

        clearToolbarTimers();
        if (toolbarWindow) toolbarWindow.hide();

        const point = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(point);
        const bounds = display.workArea;
        let x = Math.min(point.x - 210, bounds.x + bounds.width - 430);
        let y = Math.min(point.y - 46, bounds.y + bounds.height - 510);
        x = Math.max(x, bounds.x);
        y = Math.max(y, bounds.y);

        mainWindow.setPosition(x, y);
        mainWindow.show();
        mainWindow.webContents.send('context-captured', pendingContext);
        pushContextToCompanion(pendingContext);
        mainWindow.webContents.send('model-changed', activeModel);
        mainWindow.webContents.send('set-custom-actions', config.customActions || []);

        if (action !== 'chat') {
            setTimeout(() => {
                if (action.startsWith('custom:')) {
                    const idx = parseInt(action.split(':')[1], 10);
                    const ca = (config.customActions || [])[idx];
                    if (ca) {
                        mainWindow.webContents.send('auto-custom-action', ca.prompt);
                    }
                } else {
                    mainWindow.webContents.send('auto-action', action);
                }
            }, 50);
        }
    });

    ipcMain.on('toolbar-dismiss', () => {
        clearToolbarTimers();
        if (toolbarWindow) toolbarWindow.hide();
    });

    ipcMain.on('lookup-dismiss', () => {
        dismissLookup();
    });

    // Synonym/antonym chip click — re-trigger lookup for that word
    ipcMain.on('lookup-word', (event, word) => {
        if (word && word.trim()) quickLookup(word.trim());
    });

    // Renderer signals content height after paint — resize to fit, no black gap.
    // Fires for both dictionary entries (after lookup-dict) and LLM completions.
    ipcMain.on('lookup-painted', (event, contentH) => {
        if (!lookupWindow || lookupWindow.isDestroyed()) return;
        const h = Math.min(Math.max(contentH + 22, 60), 320);
        lookupWindow.setSize(340, h);
    });

    // Region Capture handlers
    ipcMain.on('snip-complete', async (event, rect) => {
        if (snipWindow) snipWindow.hide();

        if (!preCapturedImage) {
            console.error('No pre-captured image available');
            return;
        }

        try {
            // Account for display scaling
            const display = screen.getPrimaryDisplay();
            const scale = display.scaleFactor || 1;
            const imgSize = preCapturedImage.getSize();

            // Map selection coordinates to image coordinates
            const scaleX = imgSize.width / display.bounds.width;
            const scaleY = imgSize.height / display.bounds.height;

            const cropRect = {
                x: Math.round(rect.x * scaleX),
                y: Math.round(rect.y * scaleY),
                width: Math.round(rect.width * scaleX),
                height: Math.round(rect.height * scaleY)
            };

            // Clamp to image bounds
            cropRect.x = Math.max(0, Math.min(cropRect.x, imgSize.width - 1));
            cropRect.y = Math.max(0, Math.min(cropRect.y, imgSize.height - 1));
            cropRect.width = Math.min(cropRect.width, imgSize.width - cropRect.x);
            cropRect.height = Math.min(cropRect.height, imgSize.height - cropRect.y);

            const cropped = preCapturedImage.crop(cropRect);

            // Save the cropped image
            const screenshotDir = path.join(os.homedir(), '.config', 'locus', 'screenshots');
            if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
            pruneScreenshots(screenshotDir);
            const filename = `snip_${Date.now()}.png`;
            const filepath = path.join(screenshotDir, filename);
            fs.writeFileSync(filepath, cropped.toPNG());

            // Show overlay with the captured region
            const point = screen.getCursorScreenPoint();
            const bounds = display.workArea;
            let x = Math.min(point.x - 210, bounds.x + bounds.width - 430);
            let y = Math.min(point.y - 100, bounds.y + bounds.height - 510);
            x = Math.max(x, bounds.x);
            y = Math.max(y, bounds.y);

            mainWindow.setPosition(x, y);
            mainWindow.showInactive();

            // Send the image path to the overlay for display
            mainWindow.webContents.send('region-captured', { path: filepath, width: rect.width, height: rect.height });

            // Stream to Moondream vision model
            const base64 = cropped.toJPEG(80).toString('base64');
            const VISION_MODEL = 'moondream:latest';
            const messages = [
                { role: 'user', content: 'Describe what you see in this image in detail.', images: [base64] }
            ];

            conversationHistory = [];
            conversationHistory.push({ role: 'system', content: 'You are Locus, analyzing a screen region captured by the user. Describe what you see concisely.' });

            let fullResponse = '';
            // Vision always uses local Ollama (cloud APIs don't support image input via this path)
            const visionOpts = providers.getProviderOpts('ollama', config.providers);
            providers.streamChat('ollama', visionOpts, VISION_MODEL, messages,
                (chunk) => {
                    fullResponse += chunk;
                    mainWindow.webContents.send('chat-chunk', chunk);
                },
                () => {
                    conversationHistory.push({ role: 'assistant', content: fullResponse });
                    mainWindow.webContents.send('chat-done');
                },
                (err) => {
                    mainWindow.webContents.send('chat-error', 'Vision analysis failed: ' + err);
                }
            );
        } catch (err) {
            console.error('Snip processing error:', err.message);
        }

        preCapturedImage = null;
    });

    ipcMain.on('snip-cancel', () => {
        if (snipWindow && !snipWindow.isDestroyed()) {
            snipWindow.destroy();
            snipWindow = null;
        }
        preCapturedImage = null;
    });

    let activeRequest = null;

    // Web Search via DuckDuckGo instant answer API (no API key needed)
    function webSearch(query) {
        return new Promise((resolve) => {
            const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
            const https = require('https');
            https.get(url, { timeout: 5000 }, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                    if (data.length > SEARCH_RESPONSE_MAX) { res.destroy(); resolve('Search results truncated.'); return; }
                });
                res.on('end', () => {
                    try {
                        // DDG sometimes returns HTML instead of JSON for certain queries
                        if (data.trimStart().startsWith('<')) {
                            resolve('No instant answer available for this query.');
                            return;
                        }
                        const json = JSON.parse(data);
                        let results = [];
                        if (json.AbstractText) results.push(json.AbstractText);
                        if (json.Answer) results.push(json.Answer);
                        if (json.RelatedTopics) {
                            json.RelatedTopics.slice(0, 5).forEach(t => {
                                if (t.Text) results.push(t.Text);
                            });
                        }
                        resolve(results.length > 0 ? results.join('\n\n') : 'No search results found.');
                    } catch (e) {
                        resolve('No instant answer available — try a shorter query.');
                    }
                });
            }).on('error', (err) => {
                resolve('Search failed: ' + err.message);
            });
        });
    }

    ipcMain.on('chat', async (event, { context, command, action }) => {
        if (activeRequest) {
            try { activeRequest.destroy(); } catch (e) { }
            activeRequest = null;
        }

        // Auto-route: pick the best model for this action
        let modelToUse = activeModel;
        let providerToUse = activeProvider;
        let providerOptsToUse = activeProviderOpts;
        if (autoRoute && action) {
            const routed = getModelForAction(action);
            modelToUse = routed.model;
            providerToUse = routed.provider;
            providerOptsToUse = routed.providerOpts;
            mainWindow.webContents.send('model-changed', modelToUse);
        }

        // Web Search: fetch results and prepend to context
        let searchContext = '';
        if (action === 'search' && context) {
            mainWindow.webContents.send('chat-chunk', '🔍 Searching...\n\n');
            // DDG instant answer API needs short queries — extract first sentence or 120 chars
            const searchQuery = context
                .replace(/\n+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .split(/[.!?]\s/)[0]
                .substring(0, 120)
                .trim();
            searchContext = await webSearch(searchQuery || context.substring(0, 80));
        }

        // Build system message with context
        // When a toolbar action fires with new context, reset history so the LLM
        // works on the fresh highlight — not stale context from a previous action.
        if (action && context) {
            conversationHistory = [];
        }

        // Feature 5: Vision mode — detect image context and switch to vision model
        let visionImage = null;
        const imageMatch = context && context.match(/\[(Screenshot|Region Capture):\s*(.+?)\]/);
        if (imageMatch) {
            const imagePath = imageMatch[2].trim();
            try {
                const imgBuffer = fs.readFileSync(imagePath);
                visionImage = imgBuffer.toString('base64');
                // Auto-switch to vision model
                const visionPool = MODEL_POOL['👁️ Vision'];
                if (visionPool && visionPool.length > 0) {
                    modelToUse = visionPool[0].name;
                    providerToUse = 'ollama';  // moondream is Ollama-only
                    providerOptsToUse = providers.getProviderOpts('ollama', config.providers);
                    mainWindow.webContents.send('model-changed', modelToUse + ' 👁️');
                }
            } catch (e) { console.warn('Failed to read image for vision:', e.message); }
        }
        if (conversationHistory.length === 0) {
            let systemContent = 'You are Locus, a concise and direct AI assistant. Respond briefly unless asked for detail.';
            if (detectedLanguage) {
                systemContent += `\nThe highlighted code is written in ${detectedLanguage.label}.`;
            }
            if (sourceFilePath) {
                systemContent += `\nSource file: ${sourceFilePath}`;
                // Feature 5: Try to inject surrounding file context for small files
                try {
                    const fileContent = require('fs').readFileSync(sourceFilePath, 'utf8');
                    if (fileContent.length <= 5000) {
                        systemContent += `\n\nFull file contents for reference:\n\`\`\`\n${fileContent}\n\`\`\``;
                    }
                } catch (e) { /* file not readable, skip */ }
            }
            if (context) {
                systemContent += `\n\nThe user has highlighted the following text:\n\`\`\`\n${context}\n\`\`\``;
            }
            if (searchContext) {
                systemContent += `\n\n[Web Search Results]\n${searchContext}`;
            }
            conversationHistory.push({ role: 'system', content: systemContent });
        }

        // Check CortexDB for relevant memories (skip for search — web results are sufficient)
        let memoryContext = '';
        if (action !== 'search') {
            const memories = await recallCortex(command);
            if (memories.length > 0) {
                memoryContext = '\n\n[CortexDB Memories]\n' + memories.map(m => `- ${m.content}`).join('\n');
                mainWindow.webContents.send('memory-found', memories.length);
            }
        }

        const userMsg = memoryContext ? command + memoryContext : command;
        // Feature 5: For vision, use Ollama's images format
        if (visionImage) {
            conversationHistory.push({ role: 'user', content: userMsg, images: [visionImage] });
        } else {
            conversationHistory.push({ role: 'user', content: userMsg });
        }

        let fullResponse = '';
        activeRequest = providers.streamChat(
            providerToUse, providerOptsToUse, modelToUse,
            conversationHistory,
            (chunk) => {
                fullResponse += chunk;
                mainWindow.webContents.send('chat-chunk', chunk);
            },
            () => {
                conversationHistory.push({ role: 'assistant', content: fullResponse });
                // Keep history manageable — cap by count AND total characters
                if (conversationHistory.length > 20) {
                    const system = conversationHistory[0];
                    conversationHistory = [system, ...conversationHistory.slice(-18)];
                }
                let totalChars = conversationHistory.reduce((s, m) => s + (m.content || '').length, 0);
                while (totalChars > HISTORY_CHAR_BUDGET && conversationHistory.length > 2) {
                    conversationHistory.splice(1, 1);
                    totalChars = conversationHistory.reduce((s, m) => s + (m.content || '').length, 0);
                }
                mainWindow.webContents.send('chat-done');
                activeRequest = null;
                saveConversation();  // Feature 4: persist after each response
                trackStats(modelToUse, action);  // v3.6: session stats
            },
            (err) => {
                mainWindow.webContents.send('chat-error', err);
                activeRequest = null;
            }
        );
    });

    // #3: Export conversation as markdown
    ipcMain.on('export-chat', (event, markdown) => {
        try {
            const exportDir = path.join(os.homedir(), '.config', 'locus', 'exports');
            if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filepath = path.join(exportDir, `locus-${ts}.md`);
            fs.writeFileSync(filepath, markdown, 'utf8');

            mainWindow.webContents.send('export-done', filepath);
            console.log('Chat exported to:', filepath);
        } catch (err) {
            console.error('Export failed:', err.message);
        }
    });

    ipcMain.on('copy-response', (event, text) => {
        clipboard.writeText(text);
        mainWindow.webContents.send('copied');
    });

    // #2: Screenshot capture
    ipcMain.on('capture-screenshot', async () => {
        try {
            // Hide overlay briefly so it doesn't capture itself
            const wasVisible = mainWindow.isVisible();
            if (wasVisible) mainWindow.hide();
            await new Promise(r => setTimeout(r, 200));

            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: 1920, height: 1080 }
            });

            if (sources.length === 0) {
                if (wasVisible) mainWindow.show();
                mainWindow.webContents.send('screenshot-error', 'No screen source found');
                return;
            }

            const screenshot = sources[0].thumbnail;
            const screenshotDir = path.join(os.homedir(), '.config', 'locus', 'screenshots');
            if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

            const filename = `locus_${Date.now()}.png`;
            const filepath = path.join(screenshotDir, filename);
            fs.writeFileSync(filepath, screenshot.toPNG());

            if (wasVisible) mainWindow.show();
            mainWindow.webContents.send('screenshot-captured', { path: filepath });
        } catch (err) {
            mainWindow.webContents.send('screenshot-error', err.message);
            if (!mainWindow.isVisible()) mainWindow.show();
        }
    });

    // Feature 4: Open file in editor at specific line
    ipcMain.on('open-in-editor', (event, { file, line, col }) => {
        const editor = process.env.EDITOR || 'code';
        const args = [];
        if (editor === 'code' || editor === 'cursor' || editor === 'codium') {
            // VSCode/Cursor: --goto file:line:col
            args.push('--goto', `${file}:${line || 1}:${col || 1}`);
        } else if (editor === 'vim' || editor === 'nvim' || editor === 'nano') {
            // Terminal editors: +line file
            args.push(`+${line || 1}`, file);
        } else {
            args.push(file);
        }
        child_process.spawn(editor, args, { detached: true, stdio: 'ignore' }).unref();
    });

    // PERSIST TO CORTEXDB — writes the conversation lesson back to the memory pool
    ipcMain.on('persist-to-cortex', (event, { content, tags }) => {
        const safeTags = (tags || 'locus,lesson').replace(/[^a-zA-Z0-9,_-]/g, '');

        child_process.execFile(
            PYTHON_PATH,
            [CORTEX_WRITE, '--content', content, '--tags', safeTags, '--type', 'episodic'],
            { timeout: 5000 },
            (error) => {
                if (error) {
                    mainWindow.webContents.send('persist-error', error.message);
                } else {
                    mainWindow.webContents.send('persist-success');
                }
            }
        );
    });

    // APPLY IN PLACE — types the response into the previously active application
    ipcMain.on('apply-in-place', async (event, text) => {
        // Hide Locus first so focus returns to the previous app
        mainWindow.hide();

        // Smart Paste: detect destination app and format accordingly
        let pasteText = text;
        try {
            const appClass = await getActiveWindowClass();
            const lc = (appClass || '').toLowerCase();

            // Terminal apps: strip all markdown formatting
            const TERMINALS = ['gnome-terminal', 'kitty', 'alacritty', 'konsole', 'xterm', 'terminator', 'tilix', 'wezterm'];
            const EDITORS = ['code', 'cursor', 'jetbrains', 'intellij', 'webstorm', 'pycharm', 'sublime', 'atom', 'neovim', 'vim'];

            if (TERMINALS.some(t => lc.includes(t))) {
                // Strip markdown: headers, bold, italic, bullets, code fences
                pasteText = text
                    .replace(/^#{1,6}\s+/gm, '')
                    .replace(/\*\*(.*?)\*\*/g, '$1')
                    .replace(/\*(.*?)\*/g, '$1')
                    .replace(/`{3}[\w]*\n?/g, '')
                    .replace(/`([^`]+)`/g, '$1')
                    .replace(/^[\-\*]\s+/gm, '  ')
                    .trim();
            } else if (EDITORS.some(e => lc.includes(e))) {
                // Code editors: extract code blocks only
                const codeMatch = text.match(/```[\w]*\n([\s\S]*?)```/);
                if (codeMatch) {
                    pasteText = codeMatch[1].trim();
                }
            }
            // Everything else: paste as-is
        } catch (err) {
            console.error('Smart paste detection error:', err.message);
        }

        // Brief delay to let focus return, then paste via clipboard + Ctrl+V
        setTimeout(() => {
            clipboard.writeText(pasteText);
            platform.simulatePaste().catch(err => {
                console.error('Apply-in-place failed:', err.message);
            });
        }, 200);
    });

    // PIN/UNPIN — toggle whether the overlay stays visible on blur
    // The debounced blur handler in createWindow() already checks isPinned,
    // so we just flip the flag. Never remove/replace the blur listener.
    ipcMain.on('toggle-pin', () => {
        isPinned = !isPinned;
        mainWindow.webContents.send('pin-changed', isPinned);
    });

    // Feature 3: Provider quick-switch — cycle through available providers
    const PROVIDER_ICONS = { ollama: '\ud83c\udfe0', openai: '\ud83c\udf10', anthropic: '\ud83d\udfe3' };
    ipcMain.on('cycle-provider', () => {
        const available = providers.getAvailableProviders(config.providers);
        if (available.length <= 1) return; // nothing to cycle to
        const currentIdx = available.indexOf(activeProvider);
        const nextIdx = (currentIdx + 1) % available.length;
        const nextProvider = available[nextIdx];

        activeProvider = nextProvider;
        activeProviderOpts = providers.getProviderOpts(nextProvider, config.providers);

        // Pick first available model for this provider
        if (nextProvider === 'ollama') {
            activeModel = config.model || 'llama3.2:latest';
        } else {
            const cloudModels = providers.getCloudModels(nextProvider);
            if (cloudModels.length > 0) activeModel = cloudModels[0].name;
        }

        const icon = PROVIDER_ICONS[nextProvider] || '\u2699\ufe0f';
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('provider-changed', {
                provider: nextProvider,
                model: activeModel,
                icon: icon
            });
        }
        tray.setToolTip('Locus \u2014 ' + activeModel + ' (' + nextProvider + ')');
    });

    // Feature 4: Conversation persistence (upgraded with encryption + versioned save)
    const CONV_DIR = path.join(app.getPath('userData'), 'conversations');
    function ensureConvDir() {
        if (!fs.existsSync(CONV_DIR)) fs.mkdirSync(CONV_DIR, { recursive: true });
    }
    function saveConversation() {
        try {
            ensureConvDir();
            const snapshot = saveSerializer.createSnapshot(conversationHistory);
            saveSerializer.save(
                CONV_DIR, 'current.json', snapshot,
                (fp, data) => encryption.writeEncrypted(fp, data)
            );
        } catch (e) { console.warn('Failed to save conversation:', e.message); }
    }
    function loadConversation() {
        try {
            const file = path.join(CONV_DIR, 'current.json');
            const state = saveSerializer.load(file, (fp) => encryption.readEncrypted(fp));
            if (state && state.history && state.history.length > 0) {
                conversationHistory = state.history;
                return state.history;
            }
        } catch (e) { console.warn('Failed to load conversation:', e.message); }
        return null;
    }

    // Restore conversation on startup
    const restored = loadConversation();
    if (restored && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.once('did-finish-load', () => {
            mainWindow.webContents.send('restore-conversation', restored);
        });
    }

    ipcMain.on('new-conversation', () => {
        // Archive current conversation before clearing
        try {
            ensureConvDir();
            const currentFile = path.join(CONV_DIR, 'current.json');
            if (fs.existsSync(currentFile) && conversationHistory.length > 1) {
                const archiveDir = path.join(CONV_DIR, 'archive');
                if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                fs.renameSync(currentFile, path.join(archiveDir, ts + '.json'));
            }
        } catch (e) { console.warn('Failed to archive conversation:', e.message); }
        conversationHistory = [];
    });

    // Blueprint: modding_extensibility — Load plugins and expose to renderer
    let loadedPlugins = pluginLoader.loadPlugins();
    console.log(`Loaded ${loadedPlugins.length} plugin(s)`);

    // Send plugin manifest to renderer on first load
    if (loadedPlugins.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.once('did-finish-load', () => {
            const manifest = loadedPlugins.map(p => ({
                name: p.name, label: p.label, icon: p.icon, style: p.style, tab: p.tab
            }));
            mainWindow.webContents.send('plugins-loaded', manifest);
        });
    }

    // Plugin hot-reload
    ipcMain.on('reload-plugins', () => {
        loadedPlugins = pluginLoader.reloadPlugins();
        const manifest = loadedPlugins.map(p => ({
            name: p.name, label: p.label, icon: p.icon, style: p.style, tab: p.tab
        }));
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('plugins-loaded', manifest);
        }
    });

    // Plugin execution
    ipcMain.on('execute-plugin', async (event, pluginName) => {
        const plugin = loadedPlugins.find(p => p.name === pluginName);
        if (!plugin) return;
        const context = lastHighlightText || '';
        const result = await pluginLoader.executePlugin(plugin, context);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('plugin-result', { name: pluginName, result });
        }
    });

    // ── v3.6 Feature 3: Code Runner ──────────────────────────
    ipcMain.on('run-code', (event, { code, language }) => {
        const TIMEOUT_MS = 10000;
        let cmd, args;
        const lang = (language || '').toLowerCase();
        if (lang === 'python' || lang === 'py') {
            cmd = 'python3'; args = ['-c', code];
        } else if (lang === 'javascript' || lang === 'js' || lang === 'node') {
            cmd = 'node'; args = ['-e', code];
        } else if (lang === 'bash' || lang === 'shell' || lang === 'sh') {
            cmd = 'bash'; args = ['-c', code];
        } else {
            mainWindow.webContents.send('code-run-result', { error: `Unsupported language: ${lang}` });
            return;
        }
        try {
            const proc = child_process.spawn(cmd, args, {
                timeout: TIMEOUT_MS,
                env: { ...process.env, PYTHONUNBUFFERED: '1' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '', stderr = '';
            proc.stdout.on('data', d => { stdout += d.toString(); });
            proc.stderr.on('data', d => { stderr += d.toString(); });
            proc.on('close', (exitCode) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('code-run-result', {
                        stdout: stdout.substring(0, 5000),
                        stderr: stderr.substring(0, 2000),
                        exitCode,
                    });
                }
            });
            proc.on('error', (err) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('code-run-result', { error: err.message });
                }
            });
        } catch (e) {
            mainWindow.webContents.send('code-run-result', { error: e.message });
        }
    });

    // ── v3.6 Feature 4: Git Context ──────────────────────────
    ipcMain.on('get-git-context', async () => {
        try {
            const windowTitle = await new Promise((resolve, reject) => {
                child_process.exec('xdotool getactivewindow getwindowname', { timeout: 1000 }, (err, stdout) => {
                    if (err) reject(err); else resolve(stdout.trim());
                });
            });
            // Extract file path from common editor title patterns
            const fileMatch = windowTitle.match(/(?:^|\s)(\/[^\s]+)/);
            if (!fileMatch) {
                mainWindow.webContents.send('git-context', { error: 'No file path in window title' });
                return;
            }
            const filePath = fileMatch[1];
            const dir = path.dirname(filePath);
            // Check if in a git repo
            const gitRoot = await new Promise((resolve, reject) => {
                child_process.exec('git rev-parse --show-toplevel', { cwd: dir, timeout: 2000 }, (err, stdout) => {
                    if (err) reject(err); else resolve(stdout.trim());
                });
            });
            // Get git diff for this file
            const diff = await new Promise((resolve, reject) => {
                child_process.exec(`git diff -- "${filePath}"`, { cwd: gitRoot, timeout: 3000, maxBuffer: 50000 }, (err, stdout) => {
                    if (err) reject(err); else resolve(stdout.trim());
                });
            });
            // Get git status
            const status = await new Promise((resolve, reject) => {
                child_process.exec('git status --short', { cwd: gitRoot, timeout: 2000 }, (err, stdout) => {
                    if (err) reject(err); else resolve(stdout.trim());
                });
            });
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('git-context', {
                    repo: gitRoot, file: filePath,
                    diff: diff.substring(0, 10000) || '(no changes)',
                    status: status.substring(0, 2000),
                });
            }
        } catch (e) {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('git-context', { error: e.message || 'Not a git repo' });
            }
        }
    });

    // ── v3.6 Feature 5: Session Stats ────────────────────────
    const STATS_FILE = path.join(app.getPath('userData'), 'stats.json');
    let sessionStats = { messages: 0, tokensEstimate: 0, modelUsage: {}, actionUsage: {}, sessionsToday: 0 };
    try {
        if (fs.existsSync(STATS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
            const today = new Date().toISOString().slice(0, 10);
            if (raw.date === today) {
                sessionStats = raw;
            } else {
                sessionStats.date = today;
                sessionStats.sessionsToday = 0;
            }
        }
    } catch (e) { /* fresh stats */ }
    sessionStats.date = new Date().toISOString().slice(0, 10);
    sessionStats.sessionsToday = (sessionStats.sessionsToday || 0) + 1;

    function trackStats(model, action) {
        sessionStats.messages++;
        sessionStats.modelUsage[model] = (sessionStats.modelUsage[model] || 0) + 1;
        if (action) sessionStats.actionUsage[action] = (sessionStats.actionUsage[action] || 0) + 1;
        try { fs.writeFileSync(STATS_FILE, JSON.stringify(sessionStats, null, 2)); } catch (e) { /* best-effort */ }
    }

    ipcMain.on('get-stats', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('session-stats', sessionStats);
        }
    });

    // ── v3.6 Feature 6: Multi-Model Compare ─────────────────
    ipcMain.on('compare-models', (event, { prompt, models }) => {
        // models = array of model names, max 3
        const toCompare = (models || []).slice(0, 3);
        if (toCompare.length < 2) return;

        const systemMsg = { role: 'system', content: 'You are a concise AI assistant. Respond briefly.' };
        const userMsg = { role: 'user', content: prompt };

        toCompare.forEach((modelName, idx) => {
            let fullResponse = '';
            providers.streamChat(
                activeProvider, activeProviderOpts, modelName,
                [systemMsg, userMsg],
                (chunk) => {
                    fullResponse += chunk;
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('compare-chunk', { idx, chunk });
                    }
                },
                () => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('compare-done', { idx, model: modelName, response: fullResponse });
                    }
                },
                (err) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('compare-done', { idx, model: modelName, response: `Error: ${err}` });
                    }
                }
            );
        });
    });

    // ── v3.6 Feature 7: Image OCR ────────────────────────────
    ipcMain.on('ocr-image', (event, imagePath) => {
        child_process.exec(
            `tesseract "${imagePath}" stdout --oem 3 --psm 3 2>/dev/null`,
            { timeout: 10000, maxBuffer: 100000 },
            (err, stdout) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    if (err) {
                        mainWindow.webContents.send('ocr-result', { error: 'OCR failed: ' + (err.message || 'tesseract not installed') });
                    } else {
                        mainWindow.webContents.send('ocr-result', { text: stdout.trim() });
                    }
                }
            }
        );
    });

    ipcMain.on('dismiss', () => {
        if (activeRequest) {
            try { activeRequest.destroy(); } catch (e) { }
            activeRequest = null;
        }
        if (mainWindow) mainWindow.hide();
    });

    // ── Blueprint Printer IPC ───────────────────────────────
    // Fired by the Print button or Ctrl+Shift+B with text already in overlay
    // ── Blueprint: Open panel in preview mode ────────────────
    ipcMain.on('blueprint-open-panel', (event, text) => {
        if (!text || text.trim().length < 1) return;
        const panel = openBlueprintPanel();
        const previewPayload = { text: text.trim(), mode: 'blueprint' };
        const sendPreview = () => sendToPanel('bp-preview', previewPayload);
        panel.webContents.once('did-finish-load', sendPreview);
        if (!panel.webContents.isLoading()) sendPreview();
    });

    // ── Blueprint: User confirmed — start generation ─────────
    ipcMain.on('blueprint-start', (event, text) => {
        if (text && text.trim().length >= 1) blueprintPrint(text.trim());
    });

    // ── Teach: Open panel ───────────────────────────────────
    ipcMain.on('teach-open-panel', (event, text) => {
        if (!text || text.trim().length < 1) return;
        openCompanionPanel('teach', text.trim());
    });

    // ── Teach: User confirmed — start LLM stream ────────────────
    ipcMain.on('teach-start', (event, text) => {
        if (!text || text.trim().length < 1) return;

        const systemPrompt = [
            'You are a clear, friendly technical teacher. When given code or a concept,',
            'explain it with four structured sections using markdown ## headers:',
            '## 1. WHAT IT IS — plain-language definition, 2-3 sentences',
            '## 2. HOW IT WORKS — step-by-step breakdown, use bullet points',
            '## 3. WHY IT MATTERS — real-world value and use cases',
            '## 4. REAL EXAMPLE — a minimal, runnable example with a brief explanation',
            'Be concise. Use **bold** for key terms. Keep code blocks small.',
        ].join('\n');

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text.trim() },
        ];

        let fullResponse = '';
        sendToCompanion('bp-progress', { pct: 10, status: 'Thinking…' });

        _teachReq = providers.streamChat(
            activeProvider, activeProviderOpts, activeModel, messages,
            (chunk) => { fullResponse += chunk; sendToCompanion('bp-progress', { pct: 50, status: 'Explaining…' }); },
            () => { _teachReq = null; sendToCompanion('teach-ready', { text: fullResponse }); },
            (err) => { _teachReq = null; sendToCompanion('bp-error', err?.message || 'Teach Me failed'); }
        );
    });

    // ── Blueprint / Teach cancel ───────────────────────────
    ipcMain.on('blueprint-cancel', () => {
        if (_sseReq) { try { _sseReq.destroy(); } catch (e) { } _sseReq = null; }
        if (_teachReq) { try { _teachReq.destroy?.() || (_teachReq.abort?.()) } catch (e) { } _teachReq = null; }
    });

    // ── Toggle Terminal (opens companion on Terminal tab) ──────────────────
    ipcMain.on('toggle-terminal', () => {
        if (companionPanel && !companionPanel.isDestroyed() && companionPanel.isVisible()) {
            // If already on terminal tab, close; otherwise switch to terminal
            openCompanionPanel('terminal');
        } else {
            openCompanionPanel('terminal');
        }
        setTimeout(broadcastPanelState, 300);
    });

    // ── Toggle companion (single Tools button) ──────────────────────────
    ipcMain.on('toggle-companion', (event, text) => {
        if (companionPanel && !companionPanel.isDestroyed() && companionPanel.isVisible()) {
            const hasText = text && text.trim().length >= 1;
            if (hasText) {
                openCompanionPanel('blueprint', text.trim());
            } else {
                companionPanel.webContents.send('close-panel');
                setTimeout(() => { if (companionPanel && !companionPanel.isDestroyed()) companionPanel.close(); }, 230);
            }
        } else {
            const hasText = text && text.trim().length >= 1;
            openCompanionPanel('blueprint', hasText ? text.trim() : '');
        }
        setTimeout(broadcastPanelState, 300);
    });

    // ── Toggle Blueprint (opens companion on Blueprint tab) ──────────────
    ipcMain.on('toggle-blueprint', (event, text) => {
        const hasText = text && text.trim().length >= 1;
        if (companionPanel && !companionPanel.isDestroyed() && companionPanel.isVisible()) {
            if (hasText) {
                openCompanionPanel('blueprint', text.trim());
            } else {
                companionPanel.webContents.send('close-panel');
                setTimeout(() => { if (companionPanel && !companionPanel.isDestroyed()) companionPanel.close(); }, 230);
            }
        } else {
            openCompanionPanel('blueprint', hasText ? text.trim() : '');
        }
        setTimeout(broadcastPanelState, 300);
    });

    // ── Toggle Teach Me (opens companion on Teach tab) ───────────────────
    ipcMain.on('toggle-teach', (event, text) => {
        const hasText = text && text.trim().length >= 1;
        if (companionPanel && !companionPanel.isDestroyed() && companionPanel.isVisible()) {
            if (hasText) {
                openCompanionPanel('teach', text.trim());
            } else {
                companionPanel.webContents.send('close-panel');
                setTimeout(() => { if (companionPanel && !companionPanel.isDestroyed()) companionPanel.close(); }, 230);
            }
        } else {
            openCompanionPanel('teach', hasText ? text.trim() : '');
        }
        setTimeout(broadcastPanelState, 300);
    });

    // ── Toggle Deep Dive (opens companion on Dive tab) ───────────────────
    ipcMain.on('toggle-deepdive', (event, text) => {
        const hasText = text && text.trim().length >= 1;
        if (companionPanel && !companionPanel.isDestroyed() && companionPanel.isVisible()) {
            if (hasText) {
                openCompanionPanel('dive', text.trim());
            } else {
                companionPanel.webContents.send('close-panel');
                setTimeout(() => { if (companionPanel && !companionPanel.isDestroyed()) companionPanel.close(); }, 230);
            }
        } else {
            openCompanionPanel('dive', hasText ? text.trim() : '');
        }
        setTimeout(broadcastPanelState, 300);
    });

    // ── Deep Dive: Open in preview mode ──────────────────────────────────
    ipcMain.on('deep-dive-open', (event, data) => {
        const text = (typeof data === 'string') ? data : (data.text || '');
        if (!text || text.trim().length < 1) return;
        openCompanionPanel('dive', text.trim());
    });

    // ── Deep Dive: User confirmed — start LLM ─────────────────
    ipcMain.on('deep-dive-start', (event, text) => {
        if (!text || text.trim().length < 1) return;

        const systemPrompt = [
            'You are a depth-focused technical analyst. The user has selected a section from a generated document and wants to go deeper.',
            'Provide a focused, detailed breakdown. Use markdown headers, code blocks, and bullet points.',
            'Be precise and technical. Assume the reader is a developer. Keep it under 400 words.',
        ].join('\n');

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Go deeper on this:\n\n${text.trim()}` },
        ];

        let fullResponse = '';
        sendToCompanion('dd-progress', { pct: 15, status: 'Analysing…' });

        _ddRequest = providers.streamChat(
            activeProvider, activeProviderOpts, activeModel, messages,
            (chunk) => { fullResponse += chunk; sendToCompanion('dd-progress', { pct: 55, status: 'Writing…' }); },
            () => { _ddRequest = null; sendToCompanion('dd-ready', { text: fullResponse }); },
            (err) => { _ddRequest = null; sendToCompanion('dd-error', err?.message || 'Deep dive failed'); }
        );
    });

    // ── Push context from overlay to companion panel ─────────────────────
    ipcMain.on('push-context-to-panel', (_e, text) => {
        if (!text || text.trim().length < 1) return;
        if (companionPanel && !companionPanel.isDestroyed() && companionPanel.isVisible()) {
            companionPanel.webContents.send('companion-context-update', text.trim());
        } else {
            openCompanionPanel('blueprint', text.trim());
        }
    });

    // ── Companion close (from renderer) ──────────────────────────────────
    ipcMain.on('companion-close', () => {
        if (companionPanel && !companionPanel.isDestroyed()) {
            companionPanel.webContents.send('close-panel');
            setTimeout(() => { if (companionPanel && !companionPanel.isDestroyed()) companionPanel.close(); }, 230);
        }
        setTimeout(broadcastPanelState, 300);
    });

    ipcMain.on('deep-dive-cancel', () => {
        if (_ddRequest) { try { _ddRequest.destroy?.() || _ddRequest.abort?.(); } catch (e) { } _ddRequest = null; }
    });

    // ── Terminal IPC (runs inside companion panel) ────────────────────────
    ipcMain.on('open-terminal', () => {
        openCompanionPanel('terminal');
    });

    ipcMain.on('terminal-exec', (_e, cmd) => {
        if (!companionPanel || companionPanel.isDestroyed()) return;
        if (_termChildProc) { try { _termChildProc.kill(); } catch (e) { } }

        _termChildProc = child_process.spawn('bash', ['-c', cmd], {
            cwd: process.env.HOME,
            env: { ...process.env, TERM: 'dumb' },
        });

        _termChildProc.stdout.on('data', (data) => {
            sendToCompanion('terminal-stdout', data.toString());
        });

        _termChildProc.stderr.on('data', (data) => {
            sendToCompanion('terminal-stderr', data.toString());
        });

        _termChildProc.on('close', (code) => {
            _termChildProc = null;
            sendToCompanion('terminal-exit', code);
        });
    });

    ipcMain.on('terminal-kill', () => {
        if (_termChildProc) { try { _termChildProc.kill(); } catch (e) { } _termChildProc = null; }
    });

    ipcMain.on('terminal-input', (_e, input) => {
        if (_termChildProc && _termChildProc.stdin) {
            try { _termChildProc.stdin.write(input); } catch (e) { }
        }
    });

    ipcMain.on('blueprint-copy', (event, text) => {
        clipboard.writeText(text);
    });

    ipcMain.on('blueprint-save', (event, text) => {
        const dir = path.join(os.homedir(), 'Blueprints');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filePath = path.join(dir, 'blueprint-' + ts + '.md');
        fs.writeFileSync(filePath, text, 'utf-8');
        dialog.showMessageBox({ type: 'info', title: 'Blueprint Saved', message: 'Saved to ' + filePath });
    });

    ipcMain.on('blueprint-panel-close', () => {
        if (companionPanel && !companionPanel.isDestroyed()) {
            companionPanel.close();
        }
    });

    // Send blueprint to Locus chat as context for follow-up questions
    ipcMain.on('blueprint-send-to-chat', (event, text) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const snippet = text.length > 120 ? text.slice(0, 120) + '\u2026' : text;
        mainWindow.webContents.send('context-captured', snippet);
        invokeLocusOverlay();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => { });

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopManifestoEngine(); // kill child process before Locus exits
    if (mouseListenerProc) {
        try { mouseListenerProc.kill(); } catch (e) { }
    }
    config.model = activeModel;
    config.provider = activeProvider;
    saveConfig(config);
    // v4.0: flush knowledge mesh to disk
    knowledgeMesh.flushSync();
});
