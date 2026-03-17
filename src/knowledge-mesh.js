/**
 * Locus Knowledge Mesh — v4.0 Upgrade
 * 
 * Persistent cross-session lookup memory. Every lookup result is stored
 * as a knowledge node. Subsequent lookups for the same term return
 * the cached result instantly with a freshness indicator.
 * 
 * Storage: ~/.config/locus/knowledge-mesh.json (encrypted at rest)
 * Uses encryption.js for read/write when available.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MESH_DIR = path.join(os.homedir(), '.config', 'locus');
const MESH_FILE = path.join(MESH_DIR, 'knowledge-mesh.json');
const MAX_NODES = 2000;
const DECAY_DAYS = 30;
const FRESHNESS_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Lazy-load encryption module — mesh works without it (plaintext fallback)
let _enc = null;
function _getEncryption() {
    if (_enc === null) {
        try {
            _enc = require('./encryption');
        } catch {
            _enc = false;
        }
    }
    return _enc || null;
}


// ── In-memory mesh ───────────────────────────────────

let _nodes = {};       // term → node
let _dirty = false;
let _loaded = false;


// ── Persistence ──────────────────────────────────────

/**
 * Load the mesh from disk.
 */
function load() {
    if (_loaded) return;
    _loaded = true;

    if (!fs.existsSync(MESH_FILE)) {
        _nodes = {};
        return;
    }

    try {
        const enc = _getEncryption();
        if (enc) {
            const data = enc.readEncrypted(MESH_FILE);
            _nodes = (data && typeof data === 'object') ? data : {};
        } else {
            const raw = fs.readFileSync(MESH_FILE, 'utf8');
            _nodes = JSON.parse(raw);
        }
    } catch (e) {
        console.warn('KnowledgeMesh: failed to load, starting fresh:', e.message);
        _nodes = {};
    }
}

/**
 * Save the mesh to disk (debounced — call frequently, writes rarely).
 */
let _saveTimer = null;
function save() {
    _dirty = true;
    if (_saveTimer) return;
    _saveTimer = setTimeout(_flush, 5000);
}

function _flush() {
    _saveTimer = null;
    if (!_dirty) return;
    _dirty = false;

    try {
        if (!fs.existsSync(MESH_DIR)) {
            fs.mkdirSync(MESH_DIR, { recursive: true });
        }
        const enc = _getEncryption();
        if (enc) {
            enc.writeEncrypted(MESH_FILE, _nodes);
        } else {
            fs.writeFileSync(MESH_FILE, JSON.stringify(_nodes, null, 2), 'utf8');
        }
    } catch (e) {
        console.warn('KnowledgeMesh: failed to save:', e.message);
    }
}

/**
 * Force immediate save (call on app quit).
 */
function flushSync() {
    if (_saveTimer) {
        clearTimeout(_saveTimer);
        _saveTimer = null;
    }
    _flush();
}


// ── Node operations ──────────────────────────────────

/**
 * Store a lookup result as a knowledge node.
 * @param {string} term - the looked-up term (normalised to lowercase)
 * @param {string} definition - the result text
 * @param {string} source - 'dictionary' | 'wikipedia' | 'llm'
 * @param {object} [meta] - optional extra data
 */
function storeNode(term, definition, source, meta = {}) {
    load();
    const key = term.toLowerCase().trim();
    if (!key) return;

    _nodes[key] = {
        term: key,
        definition: definition.substring(0, 10000),
        source,
        meta,
        createdAt: _nodes[key]?.createdAt || Date.now(),
        lastAccessed: Date.now(),
        accessCount: (_nodes[key]?.accessCount || 0) + 1,
    };

    // Cap total nodes
    const keys = Object.keys(_nodes);
    if (keys.length > MAX_NODES) {
        // Evict oldest by lastAccessed
        keys.sort((a, b) => _nodes[a].lastAccessed - _nodes[b].lastAccessed);
        const evictCount = keys.length - MAX_NODES;
        for (let i = 0; i < evictCount; i++) {
            delete _nodes[keys[i]];
        }
    }

    save();
}

/**
 * Recall a previously looked-up term.
 * @param {string} term
 * @returns {{ node: object, freshness: number } | null}
 *   freshness: 1.0 = just looked up, 0.0 = very stale, <0 = decayed
 */
function recall(term) {
    load();
    const key = term.toLowerCase().trim();
    const node = _nodes[key];
    if (!node) return null;

    // Update access stats
    node.lastAccessed = Date.now();
    node.accessCount = (node.accessCount || 0) + 1;
    save();

    const age = Date.now() - node.createdAt;
    const freshness = Math.exp(-age / FRESHNESS_HALF_LIFE_MS);

    return { node, freshness: Math.round(freshness * 100) / 100 };
}

/**
 * Find related terms using prefix + substring matching.
 * @param {string} term
 * @param {number} [limit=5]
 * @returns {Array<{ term: string, source: string, freshness: number }>}
 */
function suggestRelated(term, limit = 5) {
    load();
    const key = term.toLowerCase().trim();
    if (!key || key.length < 2) return [];

    const results = [];
    for (const [k, node] of Object.entries(_nodes)) {
        if (k === key) continue;

        // Prefix match (strongest signal)
        if (k.startsWith(key) || key.startsWith(k)) {
            const age = Date.now() - node.createdAt;
            results.push({
                term: node.term,
                source: node.source,
                freshness: Math.round(Math.exp(-age / FRESHNESS_HALF_LIFE_MS) * 100) / 100,
                score: 2,
            });
            continue;
        }

        // Substring match
        if (k.includes(key) || key.includes(k)) {
            const age = Date.now() - node.createdAt;
            results.push({
                term: node.term,
                source: node.source,
                freshness: Math.round(Math.exp(-age / FRESHNESS_HALF_LIFE_MS) * 100) / 100,
                score: 1,
            });
        }
    }

    results.sort((a, b) => b.score - a.score || b.freshness - a.freshness);
    return results.slice(0, limit).map(({ term, source, freshness }) => ({ term, source, freshness }));
}

/**
 * Remove nodes not accessed within DECAY_DAYS.
 * @returns {number} count of pruned nodes
 */
function decaySweep() {
    load();
    const threshold = Date.now() - DECAY_DAYS * 24 * 60 * 60 * 1000;
    let pruned = 0;

    for (const [key, node] of Object.entries(_nodes)) {
        if (node.lastAccessed < threshold) {
            delete _nodes[key];
            pruned++;
        }
    }

    if (pruned > 0) save();
    return pruned;
}

/**
 * Get mesh statistics.
 * @returns {{ totalNodes: number, topTerms: Array<string>, sizeMB: number }}
 */
function getStats() {
    load();
    const entries = Object.values(_nodes);
    entries.sort((a, b) => (b.accessCount || 0) - (a.accessCount || 0));
    const topTerms = entries.slice(0, 10).map(n => n.term);

    const sizeBytes = JSON.stringify(_nodes).length;

    return {
        totalNodes: entries.length,
        topTerms,
        sizeMB: Math.round(sizeBytes / 1024 / 1024 * 100) / 100,
    };
}


module.exports = {
    load,
    save,
    flushSync,
    storeNode,
    recall,
    suggestRelated,
    decaySweep,
    getStats,
};
