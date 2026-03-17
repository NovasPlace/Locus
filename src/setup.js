/**
 * setup.js — First-launch bootstrapper for Locus
 *
 * Handles:
 *   1. Python venv creation + pynput installation
 *   2. Autostart registration (platform-specific)
 *   3. Config directory creation
 *
 * Called from app.whenReady() in main.js. All operations are async
 * and non-blocking — Locus starts immediately, setup runs in background.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const child_process = require('child_process');
const platform = require('./platform');

const VENV_DIR = path.join(os.homedir(), '.local', 'share', 'locus', 'venv');
const CONFIG_DIR = path.join(os.homedir(), '.config', 'locus');
const SETUP_MARKER = path.join(CONFIG_DIR, '.setup-done');

/**
 * Check if first-launch setup has already been completed.
 * @returns {boolean}
 */
function isSetupDone() {
    return fs.existsSync(SETUP_MARKER);
}

/**
 * Find a working Python 3 binary.
 * @returns {string|null}
 */
function findPython() {
    const candidates = [
        process.env.LOCUS_PYTHON || '',
        '/usr/bin/python3',
        '/usr/local/bin/python3',
    ];
    for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
    }
    // Try PATH
    try {
        const result = child_process.execFileSync('which', ['python3'], { timeout: 2000, encoding: 'utf8' });
        return result.trim();
    } catch (e) { return null; }
}

/**
 * Create a Python venv and install pynput.
 * @param {function} onStatus - Callback for status updates (string)
 * @returns {Promise<boolean>} true if successful
 */
function bootstrapPython(onStatus) {
    return new Promise((resolve) => {
        const python = findPython();
        if (!python) {
            onStatus('Python 3 not found. Highlight detection requires Python 3 + pynput.');
            resolve(false);
            return;
        }

        // Check if venv already exists and has pynput
        const venvPython = path.join(VENV_DIR, 'bin', 'python3');
        if (fs.existsSync(venvPython)) {
            // Check if pynput is installed
            try {
                child_process.execFileSync(venvPython, ['-c', 'import pynput'], { timeout: 5000 });
                onStatus('Python environment ready.');
                resolve(true);
                return;
            } catch (e) {
                // pynput not installed in existing venv, will install below
            }
        }

        onStatus('Setting up highlight detection (one-time setup)...');

        // Create venv
        const venvParent = path.dirname(VENV_DIR);
        if (!fs.existsSync(venvParent)) {
            fs.mkdirSync(venvParent, { recursive: true });
        }

        child_process.execFile(python, ['-m', 'venv', VENV_DIR], { timeout: 30000 }, (err) => {
            if (err) {
                onStatus('Venv creation failed: ' + err.message);
                // Fallback: try system Python with --break-system-packages
                onStatus('Trying system-level install...');
                child_process.execFile(python, ['-m', 'pip', 'install', '--break-system-packages', 'pynput'],
                    { timeout: 60000 }, (pipErr) => {
                        if (pipErr) {
                            onStatus('Could not install pynput. Highlight detection disabled.');
                            resolve(false);
                        } else {
                            onStatus('Highlight detection ready (system Python).');
                            resolve(true);
                        }
                    });
                return;
            }

            // Install pynput in the venv
            const pip = path.join(VENV_DIR, 'bin', 'pip');
            onStatus('Installing pynput...');
            child_process.execFile(pip, ['install', 'pynput'], { timeout: 60000 }, (pipErr) => {
                if (pipErr) {
                    onStatus('pynput install failed: ' + pipErr.message);
                    resolve(false);
                } else {
                    onStatus('Highlight detection ready.');
                    resolve(true);
                }
            });
        });
    });
}

/**
 * Register Locus for autostart on login.
 * @param {boolean} enable - true to enable, false to disable
 */
function setAutostart(enable) {
    if (platform.IS_WINDOWS || process.platform === 'darwin') {
        // Electron built-in for macOS and Windows
        app.setLoginItemSettings({ openAtLogin: enable });
        return;
    }

    // Linux: write a .desktop file to ~/.config/autostart/
    const autostartDir = path.join(os.homedir(), '.config', 'autostart');
    const desktopFile = path.join(autostartDir, 'locus.desktop');

    if (enable) {
        if (!fs.existsSync(autostartDir)) {
            fs.mkdirSync(autostartDir, { recursive: true });
        }
        const appPath = process.execPath;
        const appDir = path.dirname(appPath);
        const content = `[Desktop Entry]
Type=Application
Name=Locus
Comment=OS-level contextual AI agent
Exec=${appPath} --no-sandbox
Icon=${path.join(appDir, 'resources', 'app', 'src', 'locus-icon.png')}
Terminal=false
StartupNotify=false
Categories=Utility;
X-GNOME-Autostart-enabled=true
`;
        fs.writeFileSync(desktopFile, content);
    } else {
        if (fs.existsSync(desktopFile)) {
            fs.unlinkSync(desktopFile);
        }
    }
}

/**
 * Check if autostart is currently enabled.
 * @returns {boolean}
 */
function isAutostartEnabled() {
    if (platform.IS_WINDOWS || process.platform === 'darwin') {
        return app.getLoginItemSettings().openAtLogin;
    }
    return fs.existsSync(path.join(os.homedir(), '.config', 'autostart', 'locus.desktop'));
}

/**
 * Run first-launch setup. Non-blocking — returns immediately, work happens in background.
 * @param {function} onStatus - Status update callback
 * @returns {Promise<void>}
 */
async function runFirstLaunch(onStatus) {
    onStatus = onStatus || (() => { });

    // Ensure config dir exists
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // Bootstrap Python + pynput
    const pythonOk = await bootstrapPython(onStatus);
    if (pythonOk) {
        onStatus('Setup complete.');
    }

    // Mark setup as done
    try {
        fs.writeFileSync(SETUP_MARKER, new Date().toISOString());
    } catch (e) { }
}

module.exports = {
    isSetupDone,
    runFirstLaunch,
    setAutostart,
    isAutostartEnabled,
    findPython,
    VENV_DIR
};
