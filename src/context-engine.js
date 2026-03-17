/**
 * Locus Context Engine — v4.0 Upgrade
 * 
 * Classifies selected text into 10 types via structural heuristics,
 * routes each type to the optimal handler, and tracks session context.
 * No ML, no external deps — pure regex + structural analysis.
 */

// ── Selection Types ──────────────────────────────────

const TYPES = {
    CODE: 'code',
    ERROR: 'error',
    STACK_TRACE: 'stack_trace',
    URL: 'url',
    FILE_PATH: 'file_path',
    TERMINAL: 'terminal_cmd',
    JSON_YAML: 'json_yaml',
    GIT_DIFF: 'git_diff',
    WORD: 'word',
    QUESTION: 'question',
};


// ── Classifier ───────────────────────────────────────

/**
 * Classify selected text into one of 10 types using structural heuristics.
 * Order matters — more specific patterns are checked first.
 * @param {string} text - the selected text
 * @returns {{ type: string, confidence: number, meta: object }}
 */
function classifySelection(text) {
    if (!text || typeof text !== 'string') {
        return { type: TYPES.QUESTION, confidence: 0, meta: {} };
    }

    const trimmed = text.trim();
    if (!trimmed) return { type: TYPES.QUESTION, confidence: 0, meta: {} };

    // Git diff — most specific first
    if (_isGitDiff(trimmed)) {
        return { type: TYPES.GIT_DIFF, confidence: 0.95, meta: { lines: trimmed.split('\n').length } };
    }

    // Stack trace — before error (stack traces contain errors)
    if (_isStackTrace(trimmed)) {
        return { type: TYPES.STACK_TRACE, confidence: 0.9, meta: {} };
    }

    // Error message
    if (_isError(trimmed)) {
        return { type: TYPES.ERROR, confidence: 0.85, meta: {} };
    }

    // URL
    if (_isUrl(trimmed)) {
        return { type: TYPES.URL, confidence: 0.99, meta: { url: trimmed } };
    }

    // File path
    if (_isFilePath(trimmed)) {
        return { type: TYPES.FILE_PATH, confidence: 0.9, meta: { path: trimmed } };
    }

    // JSON/YAML
    if (_isJsonYaml(trimmed)) {
        return { type: TYPES.JSON_YAML, confidence: 0.85, meta: {} };
    }

    // Terminal command
    if (_isTerminalCommand(trimmed)) {
        return { type: TYPES.TERMINAL, confidence: 0.8, meta: {} };
    }

    // Code snippet
    if (_isCode(trimmed)) {
        return { type: TYPES.CODE, confidence: 0.75, meta: {} };
    }

    // Single word → dictionary lookup
    if (_isSingleWord(trimmed)) {
        return { type: TYPES.WORD, confidence: 0.95, meta: { word: trimmed.toLowerCase() } };
    }

    // Fallback: natural language question
    return { type: TYPES.QUESTION, confidence: 0.5, meta: {} };
}


// ── Heuristic detectors ──────────────────────────────

function _isGitDiff(text) {
    return /^diff --git\s/m.test(text) ||
        (/^\+\+\+ /m.test(text) && /^--- /m.test(text)) ||
        (/^@@\s.*@@/m.test(text) && (/^\+[^+]/m.test(text) || /^-[^-]/m.test(text)));
}

function _isStackTrace(text) {
    const lines = text.split('\n');
    // Python traceback
    if (/^Traceback \(most recent call last\)/m.test(text)) return true;
    // Node.js / JS stack
    const atLines = lines.filter(l => /^\s+at\s/.test(l));
    if (atLines.length >= 2) return true;
    // Go panic
    if (/^goroutine \d+/m.test(text)) return true;
    // Rust panic
    if (/^thread '.+' panicked at/m.test(text)) return true;
    // Java
    if (lines.filter(l => /^\s+at\s[\w.]+\([\w.]+:\d+\)/.test(l)).length >= 2) return true;
    return false;
}

function _isError(text) {
    const firstLine = text.split('\n')[0];
    return /^(Error|TypeError|SyntaxError|ReferenceError|RangeError|URIError):/i.test(firstLine) ||
        /^(Exception|RuntimeError|ValueError|KeyError|AttributeError|ImportError|OSError|IOError):/i.test(firstLine) ||
        /^(FATAL|CRITICAL|SEVERE|ENOENT|EACCES|EPERM|ECONNREFUSED)[\s:]/i.test(firstLine) ||
        /^E\d{4}:/.test(firstLine) || // Go-style errors
        /^error\[E\d+\]:/i.test(firstLine); // Rust errors
}

function _isUrl(text) {
    return /^https?:\/\/\S+$/i.test(text) && !text.includes('\n');
}

function _isFilePath(text) {
    if (text.includes('\n')) return false;
    return /^(\/|~\/|\.\/|\.\.\/|[A-Z]:\\)[\w./\\-]+/.test(text) &&
        /\.\w{1,10}$/.test(text); // has file extension
}

function _isJsonYaml(text) {
    const trimmed = text.trim();
    // JSON object or array
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try { JSON.parse(trimmed); return true; } catch { /* not valid JSON */ }
    }
    // YAML — indented key: value lines
    const lines = trimmed.split('\n');
    const yamlLines = lines.filter(l => /^\s*[\w-]+:\s/.test(l));
    return yamlLines.length >= 2 && yamlLines.length >= lines.length * 0.5;
}

function _isTerminalCommand(text) {
    if (text.includes('\n') && text.split('\n').length > 3) return false;
    const firstLine = text.trim();
    // Shell prompt prefixes
    if (/^[$>#]\s/.test(firstLine)) return true;
    // Known commands
    const knownCmds = /^(git|npm|npx|pip|python|python3|node|cargo|docker|kubectl|systemctl|journalctl|curl|wget|ssh|scp|rsync|make|cmake|gcc|g\+\+|ls|cd|cat|grep|find|sed|awk|sort|chmod|chown|kill|ps|top|htop|df|du|tar|zip|unzip|apt|yum|brew|sudo)\s/;
    return knownCmds.test(firstLine);
}

function _isCode(text) {
    const lines = text.split('\n');

    // Single-line check: if it looks like a function definition or statement
    if (lines.length === 1) {
        const l = text.trim();
        return /^(function|def|class|const|let|var|import|export|async)\s/.test(l) ||
            (/[{(]/.test(l) && /[});\]]$/.test(l)) ||
            /=>\s*{/.test(l);
    }

    const codeIndicators = [
        /^\s*(function|def|class|const|let|var|import|from|export|return|if|else|for|while|switch|case|try|catch|async|await)\s/,
        /[{}\[\]();]$/,              // ends with code punctuation
        /=>/,                         // arrow functions
        /\.\w+\(/,                   // method calls
        /^\s*(public|private|protected|static|void|int|string|bool)\s/, // typed languages
        /^\s*#include\s/,            // C/C++
        /^\s*@\w+/,                  // decorators
    ];

    let codeLines = 0;
    for (const line of lines) {
        if (codeIndicators.some(rx => rx.test(line))) codeLines++;
    }

    // If >30% of lines look like code, classify as code
    return lines.length >= 2 && codeLines / lines.length > 0.3;
}

function _isSingleWord(text) {
    return /^[a-zA-Z]{2,}[a-zA-Z'-]*$/.test(text);
}


// ── Handler Routing ──────────────────────────────────

/**
 * Map a selection type to the best handler action.
 * Returns the toolbar action name or a special lookup mode.
 * @param {string} type - one of TYPES
 * @returns {{ action: string, mode: string, prompt?: string }}
 */
function getHandler(type) {
    const HANDLERS = {
        [TYPES.CODE]: { action: 'explain', mode: 'toolbar', prompt: null },
        [TYPES.ERROR]: {
            action: 'diagnose', mode: 'llm',
            prompt: 'Diagnose this error. Explain what caused it, what it means, and how to fix it. Be concise.'
        },
        [TYPES.STACK_TRACE]: {
            action: 'diagnose', mode: 'llm',
            prompt: 'Analyze this stack trace. Identify the root cause, the failing function, and suggest a fix. Be concise.'
        },
        [TYPES.URL]: { action: 'summarize', mode: 'toolbar', prompt: null },
        [TYPES.FILE_PATH]: {
            action: 'explain', mode: 'llm',
            prompt: 'What is this file path? Explain its likely purpose based on the path structure.'
        },
        [TYPES.TERMINAL]: {
            action: 'explain', mode: 'llm',
            prompt: 'Explain this terminal command. What does it do? Break down each flag and argument.'
        },
        [TYPES.JSON_YAML]: {
            action: 'explain', mode: 'llm',
            prompt: 'Explain this data structure. What does each field represent? Identify the schema.'
        },
        [TYPES.GIT_DIFF]: {
            action: 'review', mode: 'llm',
            prompt: 'Review this git diff. Summarize the changes, note any potential issues, and comment on code quality.'
        },
        [TYPES.WORD]: { action: 'define', mode: 'lookup', prompt: null },
        [TYPES.QUESTION]: { action: 'lookup', mode: 'llm', prompt: null },
    };

    return HANDLERS[type] || HANDLERS[TYPES.QUESTION];
}


// ── Session Context ──────────────────────────────────

const SESSION_MAX = 5;
const _sessionHistory = [];

/**
 * Add a lookup to the session context.
 * @param {string} text - what was looked up
 * @param {string} type - classification type
 * @param {string} result - summary of the result
 */
function addToSession(text, type, result) {
    _sessionHistory.push({
        text: text.substring(0, 200),
        type,
        result: (result || '').substring(0, 500),
        timestamp: Date.now(),
    });
    if (_sessionHistory.length > SESSION_MAX) {
        _sessionHistory.shift();
    }
}

/**
 * Get the current session context as a string for LLM prompts.
 * @returns {string} formatted context or empty string
 */
function getSessionContext() {
    if (_sessionHistory.length === 0) return '';
    const items = _sessionHistory.map((h, i) =>
        `[${i + 1}] (${h.type}) "${h.text}" → ${h.result}`
    ).join('\n');
    return `\n\nPrevious lookups in this session:\n${items}\n`;
}

/**
 * Clear session context (e.g. on app restart or after long idle).
 */
function clearSession() {
    _sessionHistory.length = 0;
}


module.exports = {
    TYPES,
    classifySelection,
    getHandler,
    addToSession,
    getSessionContext,
    clearSession,
};
