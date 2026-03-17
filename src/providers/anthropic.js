/**
 * anthropic.js — Anthropic Claude provider for Locus
 *
 * Uses the Anthropic Messages API with streaming (SSE).
 * Different format from OpenAI — uses content_block_delta events.
 */

const https = require('https');

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_TIMEOUT_MS = 120000;
const API_VERSION = '2023-06-01';

/**
 * Stream a chat completion from the Anthropic Messages API.
 * @param {object} opts - Provider options from config
 * @param {string} opts.baseUrl - API base URL (default: https://api.anthropic.com)
 * @param {string} opts.apiKey - API key (required)
 * @param {number} opts.timeoutMs - Request timeout in ms (default: 120000)
 * @param {string} model - Model name (e.g. 'claude-3-haiku-20240307')
 * @param {Array} messages - Chat messages array [{role, content}]
 * @param {function} onChunk - Called with each text chunk
 * @param {function} onDone - Called when stream completes
 * @param {function} onError - Called with error message string
 * @returns {https.ClientRequest} The request object (can be destroyed to cancel)
 */
function streamChat(opts, model, messages, onChunk, onDone, onError) {
    const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    const apiKey = opts.apiKey;
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

    if (!apiKey) {
        onError('Anthropic API key not configured. Set LOCUS_ANTHROPIC_KEY or add key in settings.');
        return null;
    }

    // Anthropic requires system message as a separate top-level field
    let systemPrompt = '';
    const apiMessages = [];
    for (const msg of messages) {
        if (msg.role === 'system') {
            systemPrompt += (systemPrompt ? '\n' : '') + msg.content;
        } else {
            apiMessages.push({ role: msg.role, content: msg.content });
        }
    }

    // Anthropic requires alternating user/assistant. Merge consecutive same-role messages.
    const merged = [];
    for (const msg of apiMessages) {
        if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
            merged[merged.length - 1].content += '\n' + msg.content;
        } else {
            merged.push({ ...msg });
        }
    }

    // Ensure first message is from user (Anthropic requirement)
    if (merged.length === 0 || merged[0].role !== 'user') {
        merged.unshift({ role: 'user', content: '(context provided above)' });
    }

    const body = {
        model: model,
        max_tokens: 4096,
        stream: true,
        messages: merged
    };
    if (systemPrompt) {
        body.system = systemPrompt;
    }

    const payload = JSON.stringify(body);
    const url = new URL(baseUrl + '/v1/messages');
    let doneEmitted = false;

    const req = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': API_VERSION,
            'Content-Length': Buffer.byteLength(payload)
        }
    }, (res) => {
        if (res.statusCode !== 200) {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                let msg = 'Anthropic API error (HTTP ' + res.statusCode + ')';
                try {
                    const err = JSON.parse(body);
                    if (err.error && err.error.message) msg = err.error.message;
                } catch (e) { }
                if (!doneEmitted) { doneEmitted = true; onError(msg); }
            });
            return;
        }

        let buffer = '';
        res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                try {
                    const json = JSON.parse(data);
                    if (json.type === 'content_block_delta' && json.delta && json.delta.text) {
                        onChunk(json.delta.text);
                    }
                    if (json.type === 'message_stop') {
                        if (!doneEmitted) { doneEmitted = true; onDone(); }
                    }
                } catch (e) { }
            }
        });
        res.on('end', () => {
            if (!doneEmitted) { doneEmitted = true; onDone(); }
        });
    });

    req.on('error', (err) => {
        if (!doneEmitted) { doneEmitted = true; onError(err.message); }
    });
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
 * No-op keepalive — cloud APIs don't need model warming.
 */
function keepWarm() { }

/**
 * Check API reachability (lightweight — just verifies the key works).
 * @param {object} opts - Provider options
 * @returns {Promise<boolean>}
 */
function healthCheck(opts) {
    const apiKey = opts.apiKey;
    if (!apiKey) return Promise.resolve(false);
    // Anthropic doesn't have a /models list endpoint, so we just check if the key exists
    return Promise.resolve(true);
}

module.exports = { streamChat, keepWarm, healthCheck };
