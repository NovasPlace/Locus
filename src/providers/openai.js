/**
 * openai.js — OpenAI-compatible provider for Locus
 *
 * Works with any OpenAI-compatible API:
 * - OpenAI (api.openai.com)
 * - Groq (api.groq.com)
 * - Together (api.together.xyz)
 * - Any custom endpoint with baseUrl config
 *
 * Uses HTTPS streaming (SSE) with `stream: true`.
 */

const https = require('https');
const http = require('http');

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Stream a chat completion from an OpenAI-compatible API.
 * @param {object} opts - Provider options from config
 * @param {string} opts.baseUrl - API base URL (default: https://api.openai.com/v1)
 * @param {string} opts.apiKey - API key (required)
 * @param {number} opts.timeoutMs - Request timeout in ms (default: 120000)
 * @param {string} model - Model name (e.g. 'gpt-4o-mini')
 * @param {Array} messages - Chat messages array [{role, content}]
 * @param {function} onChunk - Called with each text chunk
 * @param {function} onDone - Called when stream completes
 * @param {function} onError - Called with error message string
 * @returns {http.ClientRequest} The request object (can be destroyed to cancel)
 */
function streamChat(opts, model, messages, onChunk, onDone, onError) {
    const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    const apiKey = opts.apiKey;
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

    if (!apiKey) {
        onError('OpenAI API key not configured. Set LOCUS_OPENAI_KEY or add key in settings.');
        return null;
    }

    const payload = JSON.stringify({
        model: model,
        messages: messages,
        stream: true
    });

    const url = new URL(baseUrl + '/chat/completions');
    const transport = url.protocol === 'https:' ? https : http;
    let doneEmitted = false;

    const req = transport.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
            'Content-Length': Buffer.byteLength(payload)
        }
    }, (res) => {
        if (res.statusCode !== 200) {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                let msg = 'API error (HTTP ' + res.statusCode + ')';
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
                if (data === '[DONE]') {
                    if (!doneEmitted) { doneEmitted = true; onDone(); }
                    return;
                }
                try {
                    const json = JSON.parse(data);
                    const delta = json.choices && json.choices[0] && json.choices[0].delta;
                    if (delta && delta.content) {
                        onChunk(delta.content);
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
 * Check if the API is reachable with the configured key.
 * @param {object} opts - Provider options
 * @returns {Promise<boolean>}
 */
function healthCheck(opts) {
    const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    const apiKey = opts.apiKey;
    if (!apiKey) return Promise.resolve(false);

    return new Promise((resolve) => {
        const url = new URL(baseUrl + '/models');
        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.get({
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname,
            timeout: 5000,
            headers: { 'Authorization': 'Bearer ' + apiKey }
        }, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
    });
}

module.exports = { streamChat, keepWarm, healthCheck };
