/**
 * providers/index.js — Provider registry for Locus
 *
 * Unified interface for all LLM providers (Ollama, OpenAI, Anthropic).
 * Each provider exports: streamChat(opts, model, messages, onChunk, onDone, onError)
 *
 * API keys are resolved from:
 *   1. Environment variables (LOCUS_OPENAI_KEY, LOCUS_ANTHROPIC_KEY)
 *   2. Config file provider options (opts.apiKey)
 *
 * Keys are NEVER written to config.json by Locus itself.
 */

const ollama = require('./ollama');
const openai = require('./openai');
const anthropic = require('./anthropic');

const PROVIDERS = {
    ollama: ollama,
    openai: openai,
    anthropic: anthropic
};

// Default provider options (merged with user config)
const DEFAULT_PROVIDER_OPTS = {
    ollama: { host: 'http://127.0.0.1:11434', timeoutMs: 180000 },
    openai: { baseUrl: 'https://api.openai.com/v1', timeoutMs: 120000 },
    anthropic: { baseUrl: 'https://api.anthropic.com', timeoutMs: 120000 }
};

// Cloud model pools — shown in tray menu when API key is configured
const CLOUD_MODELS = {
    openai: [
        { name: 'gpt-4o-mini', label: 'GPT-4o Mini' },
        { name: 'gpt-4o', label: 'GPT-4o' },
        { name: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
        { name: 'gpt-4.1', label: 'GPT-4.1' },
    ],
    anthropic: [
        { name: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
        { name: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
    ]
};

/**
 * Resolve API key for a provider from env vars or config.
 * @param {string} providerName - 'openai' or 'anthropic'
 * @param {object} providerOpts - Provider options from config
 * @returns {string|null} API key or null
 */
function resolveApiKey(providerName, providerOpts) {
    const envKeys = {
        openai: 'LOCUS_OPENAI_KEY',
        anthropic: 'LOCUS_ANTHROPIC_KEY'
    };
    const envKey = process.env[envKeys[providerName]];
    if (envKey) return envKey;
    return providerOpts.apiKey || null;
}

/**
 * Get resolved options for a provider (merges defaults + config + env keys).
 * @param {string} providerName - Provider identifier
 * @param {object} configProviders - The `providers` object from config.json
 * @returns {object} Resolved provider options
 */
function getProviderOpts(providerName, configProviders) {
    const defaults = DEFAULT_PROVIDER_OPTS[providerName] || {};
    const userOpts = (configProviders || {})[providerName] || {};
    const merged = { ...defaults, ...userOpts };

    // Resolve API key from env or config
    if (providerName !== 'ollama') {
        merged.apiKey = resolveApiKey(providerName, merged);
    }

    return merged;
}

/**
 * Stream a chat completion through the configured provider.
 * @param {string} providerName - 'ollama', 'openai', or 'anthropic'
 * @param {object} providerOpts - Resolved provider options
 * @param {string} model - Model name
 * @param {Array} messages - Chat messages [{role, content}]
 * @param {function} onChunk - Text chunk callback
 * @param {function} onDone - Completion callback
 * @param {function} onError - Error callback (receives string)
 * @returns {object|null} Request handle (can be destroyed to cancel)
 */
function streamChat(providerName, providerOpts, model, messages, onChunk, onDone, onError) {
    const provider = PROVIDERS[providerName];
    if (!provider) {
        onError('Unknown provider: ' + providerName);
        return null;
    }
    return provider.streamChat(providerOpts, model, messages, onChunk, onDone, onError);
}

/**
 * Keep a model warm (only meaningful for Ollama).
 * @param {string} providerName
 * @param {object} providerOpts
 * @param {string} model
 */
function keepWarm(providerName, providerOpts, model) {
    const provider = PROVIDERS[providerName];
    if (provider && provider.keepWarm) {
        provider.keepWarm(providerOpts, model);
    }
}

/**
 * Check provider health/reachability.
 * @param {string} providerName
 * @param {object} providerOpts
 * @returns {Promise<boolean>}
 */
function healthCheck(providerName, providerOpts) {
    const provider = PROVIDERS[providerName];
    if (!provider) return Promise.resolve(false);
    return provider.healthCheck(providerOpts);
}

/**
 * Get available cloud models for a provider (for tray menu).
 * @param {string} providerName
 * @returns {Array} Model list [{name, label}]
 */
function getCloudModels(providerName) {
    return CLOUD_MODELS[providerName] || [];
}

/**
 * Check which cloud providers have API keys configured.
 * @param {object} configProviders - The `providers` object from config.json
 * @returns {Array<string>} List of provider names with valid keys
 */
/**
 * Auto-select the best Ollama model (checks loaded first, then available).
 * @param {object} providerOpts - Ollama provider options
 * @returns {Promise<{model: string, reason: string}>}
 */
function autoSelectModel(providerOpts) {
    return ollama.autoSelectModel(providerOpts);
}

function getAvailableProviders(configProviders) {
    const available = ['ollama']; // always available (may be offline, but always an option)
    for (const name of ['openai', 'anthropic']) {
        const opts = getProviderOpts(name, configProviders);
        if (opts.apiKey) {
            available.push(name);
        }
    }
    return available;
}

module.exports = {
    streamChat,
    keepWarm,
    healthCheck,
    getProviderOpts,
    getCloudModels,
    getAvailableProviders,
    autoSelectModel,
    CLOUD_MODELS
};
