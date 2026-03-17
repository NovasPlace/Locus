/**
 * Locus Save Serialization Module — Blueprint: save_serialization
 * Generated from Ricky Lake evolution gap analysis.
 *
 * Versioned state persistence with forward migration.
 * Replaces raw JSON writes with versioned, validated state snapshots.
 * Supports rolling auto-save with configurable retention.
 */
const fs = require('fs');
const path = require('path');

const CURRENT_VERSION = 2;
const MAX_AUTOSAVES = 5;

/**
 * Version migration functions.
 * Each migrator takes state at version N and returns state at version N+1.
 */
const MIGRATORS = {
    // v1 → v2: added metadata envelope
    1: (state) => ({
        version: 2,
        metadata: {
            created: state.metadata?.created || new Date().toISOString(),
            modified: new Date().toISOString(),
            messageCount: (state.history || []).filter(m => m.role !== 'system').length,
        },
        history: state.history || [],
        context: state.context || '',
    }),
};

/**
 * Create a versioned state snapshot.
 * @param {Array} history - conversation history
 * @param {string} context - current context
 * @returns {object} versioned state
 */
function createSnapshot(history, context = '') {
    return {
        version: CURRENT_VERSION,
        metadata: {
            created: new Date().toISOString(),
            modified: new Date().toISOString(),
            messageCount: history.filter(m => m.role !== 'system').length,
        },
        history: history,
        context: context,
    };
}

/**
 * Migrate state from any older version to CURRENT_VERSION.
 * @param {object} state - raw parsed state (may be any version)
 * @returns {object} state at CURRENT_VERSION
 */
function migrate(state) {
    if (!state) return createSnapshot([]);

    // Legacy format: no version field → treat as v1
    if (!state.version) {
        state = { version: 1, history: state.history || [], context: state.context || '' };
    }

    let current = state;
    while (current.version < CURRENT_VERSION) {
        const migrator = MIGRATORS[current.version];
        if (!migrator) {
            console.warn(`SaveSerializer: no migrator for v${current.version} → v${current.version + 1}`);
            break;
        }
        current = migrator(current);
    }
    return current;
}

/**
 * Save state with versioning and rolling autosave.
 * @param {string} dir - save directory
 * @param {string} filename - primary save file name
 * @param {object} state - the state to save (will be wrapped in snapshot)
 * @param {function} writer - write function (fs.writeFileSync or encryption.writeEncrypted)
 */
function save(dir, filename, state, writer = null) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filepath = path.join(dir, filename);
    const writeFn = writer || ((fp, data) => fs.writeFileSync(fp, JSON.stringify(data, null, 2)));

    // Snapshot if not already versioned
    const snapshot = state.version ? state : createSnapshot(state.history || [], state.context || '');
    snapshot.metadata.modified = new Date().toISOString();

    // Rolling autosave before overwriting
    if (fs.existsSync(filepath)) {
        const autosaveDir = path.join(dir, '.autosave');
        if (!fs.existsSync(autosaveDir)) fs.mkdirSync(autosaveDir, { recursive: true });

        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const autosavePath = path.join(autosaveDir, `${ts}.json`);

        try {
            fs.copyFileSync(filepath, autosavePath);
        } catch (e) { /* best-effort */ }

        // Prune old autosaves
        try {
            const saves = fs.readdirSync(autosaveDir).sort();
            while (saves.length > MAX_AUTOSAVES) {
                fs.unlinkSync(path.join(autosaveDir, saves.shift()));
            }
        } catch (e) { /* best-effort */ }
    }

    writeFn(filepath, snapshot);
}

/**
 * Load state with version migration.
 * @param {string} filepath - path to the save file
 * @param {function} reader - read function (JSON.parse or encryption.readEncrypted)
 * @returns {object|null} migrated state or null
 */
function load(filepath, reader = null) {
    if (!fs.existsSync(filepath)) return null;

    let raw;
    if (reader) {
        raw = reader(filepath);
    } else {
        try {
            raw = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        } catch (e) {
            console.warn('SaveSerializer: failed to parse', filepath, e.message);
            return null;
        }
    }

    if (!raw) return null;
    return migrate(raw);
}

module.exports = { createSnapshot, migrate, save, load, CURRENT_VERSION };
