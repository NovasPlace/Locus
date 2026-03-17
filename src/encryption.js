/**
 * Locus Encryption Module — Blueprint: encryption
 * Generated from Ricky Lake evolution gap analysis.
 *
 * Provides data-at-rest encryption for conversation history and config secrets.
 * Uses AES-256-GCM with a machine-derived key (hostname + username + app salt).
 * Zero external dependencies — built on Node.js crypto.
 */
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');

// Deterministic machine-derived key — same machine always produces the same key.
// Not intended for cross-machine portability; protects against casual file browsing.
const SALT = 'locus-sovereign-salt-v1';
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 12;  // GCM standard
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 256-bit key from machine identity.
 * Deterministic: same machine → same key.
 */
function deriveKey() {
    const identity = `${os.hostname()}:${os.userInfo().username}:${SALT}`;
    return crypto.scryptSync(identity, SALT, KEY_LENGTH);
}

/**
 * Encrypt a string. Returns a base64-encoded payload (iv + authTag + ciphertext).
 * @param {string} plaintext
 * @returns {string} base64-encoded encrypted payload
 */
function encrypt(plaintext) {
    const key = deriveKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    // Pack: [iv (12)] [authTag (16)] [ciphertext (...)]
    const payload = Buffer.concat([iv, authTag, encrypted]);
    return payload.toString('base64');
}

/**
 * Decrypt a base64-encoded payload back to plaintext.
 * @param {string} encoded base64-encoded encrypted payload
 * @returns {string} decrypted plaintext
 */
function decrypt(encoded) {
    const key = deriveKey();
    const payload = Buffer.from(encoded, 'base64');

    const iv = payload.subarray(0, IV_LENGTH);
    const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
    ]);
    return decrypted.toString('utf8');
}

/**
 * Write encrypted JSON to a file.
 * @param {string} filepath
 * @param {object} data
 */
function writeEncrypted(filepath, data) {
    const json = JSON.stringify(data, null, 2);
    const encPayload = encrypt(json);
    fs.writeFileSync(filepath, encPayload, 'utf8');
}

/**
 * Read and decrypt JSON from a file.
 * Falls back to plaintext JSON for backward compatibility (migration).
 * @param {string} filepath
 * @returns {object|null}
 */
function readEncrypted(filepath) {
    if (!fs.existsSync(filepath)) return null;
    const raw = fs.readFileSync(filepath, 'utf8').trim();

    // Try encrypted first
    try {
        const json = decrypt(raw);
        return JSON.parse(json);
    } catch (e) {
        // Fallback: might be plaintext JSON from before encryption was added
        try {
            return JSON.parse(raw);
        } catch (e2) {
            console.warn('Encryption: cannot read file', filepath, e.message);
            return null;
        }
    }
}

module.exports = { encrypt, decrypt, writeEncrypted, readEncrypted };
