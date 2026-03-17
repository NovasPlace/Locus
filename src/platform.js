/**
 * platform.js — Cross-platform abstraction for Locus
 *
 * Abstracts all OS-specific calls (xdotool, xclip, pkill, DISPLAY env)
 * behind a unified API. Linux uses CLI tools, Windows uses PowerShell/Win32.
 */

const { clipboard } = require('electron');
const child_process = require('child_process');

const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

/**
 * Read the currently selected text.
 * Linux: X11 PRIMARY selection via Electron API, falling back to xclip.
 * Windows: clipboard (Windows auto-copies selection in some apps, but we
 *          simulate Ctrl+C first to capture the selection).
 * @returns {Promise<string>}
 */
function getSelection() {
    return new Promise((resolve) => {
        if (IS_WINDOWS) {
            // On Windows, simulate Ctrl+C to copy selection to clipboard, then read it.
            // Save current clipboard, simulate copy, read, restore.
            const saved = clipboard.readText();
            clipboard.writeText('');
            const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')`;
            child_process.exec(`powershell -NoProfile -Command "${ps}"`, { timeout: 1000 }, () => {
                setTimeout(() => {
                    const sel = clipboard.readText();
                    if (sel && sel.trim()) {
                        resolve(sel.trim());
                    } else {
                        resolve(saved ? saved.trim() : '');
                    }
                }, 100);
            });
            return;
        }

        // Linux: try Electron's selection, then xclip, then clipboard
        const native = clipboard.readText('selection');
        if (native && native.trim()) {
            resolve(native.trim());
            return;
        }
        child_process.exec('xclip -o -selection primary', { timeout: 1000 }, (error, stdout) => {
            if (!error && stdout && stdout.trim()) {
                resolve(stdout.trim());
                return;
            }
            const clip = clipboard.readText('clipboard');
            resolve(clip ? clip.trim() : '');
        });
    });
}

/**
 * Get the class/name of the currently active window.
 * Used for per-app exclusion filtering.
 * @returns {Promise<string>}
 */
function getActiveWindowClass() {
    return new Promise((resolve) => {
        if (IS_WINDOWS) {
            const ps = `(Get-Process -Id (Get-CimInstance Win32_Process -Filter "ProcessId = $((Get-CimInstance Win32_Process -Filter \\"ProcessId = $([System.Diagnostics.Process]::GetCurrentProcess().Id)\\").ParentProcessId)").ProcessId -ErrorAction SilentlyContinue).ProcessName`;
            // Simpler approach: just get foreground window process name
            const cmd = `powershell -NoProfile -Command "(Get-Process -Id ((Add-Type -MemberDefinition '[DllImport(\\\"user32.dll\\\")] public static extern IntPtr GetForegroundWindow();[DllImport(\\\"user32.dll\\\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);' -Name Win32 -Namespace Temp -PassThru)::GetWindowThreadProcessId([Temp.Win32]::GetForegroundWindow(), [ref]($pid = 0)) | Out-Null; $pid)).ProcessName"`;
            child_process.exec(cmd, { timeout: 2000 }, (err, stdout) => {
                resolve(err ? '' : (stdout || '').trim().toLowerCase());
            });
            return;
        }

        // Linux
        child_process.exec('xdotool getactivewindow getwindowclassname', { timeout: 500 }, (err, stdout) => {
            resolve(err ? '' : (stdout || '').trim().toLowerCase());
        });
    });
}

/**
 * Simulate Ctrl+V paste in the active window.
 * @returns {Promise<void>}
 */
function simulatePaste() {
    return new Promise((resolve, reject) => {
        if (IS_WINDOWS) {
            const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')`;
            child_process.exec(`powershell -NoProfile -Command "${ps}"`, { timeout: 2000 }, (err) => {
                err ? reject(err) : resolve();
            });
            return;
        }

        // Linux
        child_process.exec('xdotool key --clearmodifiers ctrl+v', { timeout: 2000 }, (err) => {
            err ? reject(err) : resolve();
        });
    });
}

/**
 * Simulate a hotkey press (used by mouse button listener).
 * @param {string} hotkey - e.g. 'Alt+Space'
 * @returns {string} Shell command to execute
 */
function getHotkeySimCmd(hotkey) {
    if (IS_WINDOWS) {
        // Convert hotkey format: 'Alt+Space' → '%( )' for SendKeys
        const mapping = { 'Alt': '%', 'Ctrl': '^', 'Shift': '+' };
        const parts = hotkey.split('+');
        const key = parts.pop();
        const mods = parts.map(p => mapping[p] || '').join('');
        const sendKey = key === 'Space' ? ' ' : key.toLowerCase();
        return `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${mods}(${sendKey})')"`;
    }
    return `xdotool key '${hotkey}'`;
}

/**
 * Get the shell command for reading selection inside the pynput Python script.
 * @returns {string} Python code snippet
 */
function getPynputSelectionCode() {
    if (IS_WINDOWS) {
        return `
def get_selection():
    try:
        import subprocess
        # Simulate Ctrl+C then read clipboard
        import ctypes
        ctypes.windll.user32.keybd_event(0x11, 0, 0, 0)  # Ctrl down
        ctypes.windll.user32.keybd_event(0x43, 0, 0, 0)  # C down
        ctypes.windll.user32.keybd_event(0x43, 0, 2, 0)  # C up
        ctypes.windll.user32.keybd_event(0x11, 0, 2, 0)  # Ctrl up
        import time; time.sleep(0.1)
        r = subprocess.run(['powershell', '-NoProfile', '-Command', 'Get-Clipboard'],
                          capture_output=True, text=True, timeout=0.5)
        return r.stdout.strip() if r.returncode == 0 else ""
    except:
        return ""
`;
    }
    return `
def get_selection():
    try:
        r = subprocess.run(['xclip', '-o', '-selection', 'primary'],
                          capture_output=True, text=True, timeout=0.3)
        return r.stdout.strip() if r.returncode == 0 else ""
    except:
        return ""
`;
}

/**
 * Environment variables for spawning the pynput listener child process.
 * @returns {object}
 */
function getSpawnEnv() {
    if (IS_WINDOWS) {
        return { ...process.env };
    }
    return { ...process.env, DISPLAY: process.env.DISPLAY || ':1' };
}

/**
 * Kill orphaned pynput listener processes from previous sessions.
 */
function cleanupListeners() {
    try {
        if (IS_WINDOWS) {
            // Kill python processes that were started by Locus
            child_process.execSync('taskkill /F /FI "WINDOWTITLE eq locus-pynput" 2>nul || echo ok', { timeout: 2000 });
        } else {
            child_process.execSync('pkill -f "pynput.*TRIGGER_PORT" 2>/dev/null || true', { timeout: 2000 });
        }
    } catch (e) { }
}

module.exports = {
    IS_WINDOWS,
    IS_LINUX,
    getSelection,
    getActiveWindowClass,
    simulatePaste,
    getHotkeySimCmd,
    getPynputSelectionCode,
    getSpawnEnv,
    cleanupListeners,
};
