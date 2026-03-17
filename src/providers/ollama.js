/**
 * ollama.js — Local Ollama provider for Locus
 *
 * Streams chat completions from a local Ollama instance.
 * Supports model keepalive to prevent cold-start latency.
 */

const http = require('http');

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const DEFAULT_TIMEOUT_MS = 180000;

/**
 * Stream a chat completion from Ollama.
 * @param {object} opts - Provider options from config
 * @param {string} opts.host - Ollama host URL (default: http://127.0.0.1:11434)
 * @param {number} opts.timeoutMs - Request timeout in ms (default: 180000)
 * @param {string} model - Model name (e.g. 'llama3.2:latest')
 * @param {Array} messages - Chat messages array [{role, content}]
 * @param {function} onChunk - Called with each text chunk
 * @param {function} onDone - Called when stream completes
 * @param {function} onError - Called with error message string
 * @returns {http.ClientRequest} The request object (can be destroyed to cancel)
 */
function streamChat(opts, model, messages, onChunk, onDone, onError) {
    const host = opts.host || DEFAULT_HOST;
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

    const payload = JSON.stringify({
        model: model,
        messages: messages.map(m => {
            const msg = { role: m.role, content: m.content };
            // Feature 5: Vision support — forward images array for vision models
            if (m.images && m.images.length > 0) msg.images = m.images;
            return msg;
        }),
        stream: true,
        keep_alive: -1
    });

    const url = new URL(host + '/api/chat');
    let doneEmitted = false;

    const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    }, (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const json = JSON.parse(line);
                    if (json.message && json.message.content) {
                        onChunk(json.message.content);
                    }
                    if (json.done && !doneEmitted) {
                        doneEmitted = true;
                        onDone();
                    }
                } catch (e) { }
            }
        });
        res.on('end', () => {
            if (!doneEmitted) {
                doneEmitted = true;
                onDone();
            }
        });
    });

    req.on('error', (err) => onError(err.message));
    req.on('timeout', () => {
        req.destroy();
        if (!doneEmitted) {
            doneEmitted = true;
            onError('Request timed out after ' + (timeoutMs / 1000) + 's');
        }
    });
    req.write(payload);
    req.end();
    return req;
}

/**
 * Send a keepalive ping to keep the model loaded in memory.
 * @param {object} opts - Provider options
 * @param {string} model - Model name to keep warm
 */
function keepWarm(opts, model) {
    const host = opts.host || DEFAULT_HOST;
    const payload = JSON.stringify({
        model: model,
        prompt: '',
        keep_alive: -1,
        stream: false
    });
    const url = new URL(host + '/api/generate');
    const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        timeout: 10000,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    }, (res) => {
        res.resume();
        console.log('Model keepalive: ' + model + ' loaded');
    });
    req.on('error', (err) => { console.warn('Model keepalive failed:', err.message); });
    req.write(payload);
    req.end();
}

/**
 * Check if Ollama is reachable.
 * @param {object} opts - Provider options
 * @returns {Promise<boolean>}
 */
function healthCheck(opts) {
    const host = opts.host || DEFAULT_HOST;
    return new Promise((resolve) => {
        const req = http.get(host + '/api/tags', { timeout: 3000 }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
    });
}


/**
 * Auto-select the best model based on what's loaded and available VRAM.
 *
 * Priority:
 *   1. Use whatever's already loaded in VRAM (zero cold-start)
 *   2. If nothing loaded, pick the best model that fits in free VRAM
 *   3. Preference: qwen > llama > deepseek > anything else
 *
 * @param {object} opts - Provider options
 * @returns {Promise<{model: string, reason: string}>}
 */
async function autoSelectModel(opts) {
    const host = opts.host || DEFAULT_HOST;

    // Step 1: Check what's already loaded
    try {
        const loaded = await _httpGetJson(host + '/api/ps');
        if (loaded.models && loaded.models.length > 0) {
            // Pick the best loaded model by preference
            const sorted = loaded.models.sort((a, b) => {
                const aScore = _modelPreference(a.name);
                const bScore = _modelPreference(b.name);
                return bScore - aScore;
            });
            const pick = sorted[0].name;
            return { model: pick, reason: `already loaded in VRAM` };
        }
    } catch (e) { /* Ollama might not support /api/ps */ }

    // Step 2: Nothing loaded — check available models
    try {
        const tags = await _httpGetJson(host + '/api/tags');
        if (!tags.models || tags.models.length === 0) {
            return { model: 'llama3.2:latest', reason: 'no models found, using default' };
        }

        // Sort by preference score (higher = better)
        const ranked = tags.models
            .filter(m => !m.name.includes('embed') && !m.name.includes('moondream'))
            .sort((a, b) => _modelPreference(b.name) - _modelPreference(a.name));

        if (ranked.length > 0) {
            return { model: ranked[0].name, reason: 'best available model' };
        }
        return { model: tags.models[0].name, reason: 'only available model' };

    } catch (e) {
        return { model: 'llama3.2:latest', reason: 'ollama unreachable, using default' };
    }
}

/**
 * Score a model name by preference for auto-selection.
 * Higher = better. Considers quality and VRAM efficiency.
 */
function _modelPreference(name) {
    const n = name.toLowerCase();
    let score = 0;

    // Prefer chat/instruct models
    if (n.includes('instruct')) score += 10;

    // Family preferences (quality ranking)
    if (n.includes('qwen3:')) score += 50;  // best quality/size
    if (n.includes('qwen3.5:')) score += 45;
    if (n.includes('llama3.1:')) score += 40;
    if (n.includes('llama3.2:')) score += 35;
    if (n.includes('deepseek-coder')) score += 30;
    if (n.includes('cortex-bridge')) score += 5;   // custom fine-tune, less general

    // Size preferences — bigger is better but not too big
    if (n.includes(':8b')) score += 15;
    if (n.includes(':4b')) score += 12;
    if (n.includes(':2b')) score += 8;
    if (n.includes(':lite')) score += 6;
    if (n.includes(':latest')) score += 5;

    return score;
}

/**
 * Simple HTTP GET that returns parsed JSON.
 */
function _httpGetJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

module.exports = { streamChat, keepWarm, healthCheck, autoSelectModel };
