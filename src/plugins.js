/**
 * Locus Plugin Loader — Blueprint: modding_extensibility
 * Generated from Ricky Lake evolution gap analysis.
 *
 * Runtime plugin system for custom toolbar actions.
 * Scans ~/.config/locus/plugins/ for .js files.
 * Each plugin exports: { name, label, icon, style, handler(context, send) }
 *
 * Plugins are sandboxed via try/catch — a crashing plugin never takes down Locus.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_DIR = path.join(os.homedir(), '.config', 'locus', 'plugins');

/**
 * Plugin manifest shape:
 * {
 *   name: string,       // unique ID (e.g. 'count-words')
 *   label: string,      // button label (e.g. 'Count')
 *   icon: string,       // emoji prefix (e.g. '🔢')
 *   style: object,      // CSS style overrides for the button { color, borderColor }
 *   tab: string,        // which tab to add to: 'text' | 'code' | 'tools' (default: 'tools')
 *   handler: function,  // (context: string) => string | Promise<string>
 * }
 */

/**
 * Scan plugin directory and load all valid plugins.
 * @returns {Array<object>} loaded plugin manifests
 */
function loadPlugins() {
    const plugins = [];

    if (!fs.existsSync(PLUGIN_DIR)) {
        // Create directory with a README so user knows where to put plugins
        try {
            fs.mkdirSync(PLUGIN_DIR, { recursive: true });
            fs.writeFileSync(
                path.join(PLUGIN_DIR, 'README.md'),
                '# Locus Plugins\n\n' +
                'Drop `.js` files here to add custom toolbar actions.\n\n' +
                '## Plugin Format\n\n' +
                '```javascript\n' +
                'module.exports = {\n' +
                '  name: "my-plugin",\n' +
                '  label: "My Action",\n' +
                '  icon: "⚡",\n' +
                '  style: { color: "#f59e0b", borderColor: "rgba(245,158,11,0.3)" },\n' +
                '  tab: "tools",  // "text" | "code" | "tools"\n' +
                '  handler: async (context) => {\n' +
                '    // context = highlighted text\n' +
                '    // Return a string to display as the result\n' +
                '    return `Processed: ${context.length} chars`;\n' +
                '  }\n' +
                '};\n' +
                '```\n'
            );
        } catch (e) { /* best-effort */ }
        return plugins;
    }

    let files;
    try {
        files = fs.readdirSync(PLUGIN_DIR).filter(f => f.endsWith('.js'));
    } catch (e) {
        console.warn('PluginLoader: failed to read plugin dir:', e.message);
        return plugins;
    }

    for (const file of files) {
        const filepath = path.join(PLUGIN_DIR, file);
        try {
            // Clear require cache so plugins can be hot-reloaded
            delete require.cache[require.resolve(filepath)];
            const plugin = require(filepath);

            // Validate required fields
            if (!plugin.name || !plugin.label || typeof plugin.handler !== 'function') {
                console.warn(`PluginLoader: skipping ${file} — missing name, label, or handler`);
                continue;
            }

            plugins.push({
                name: plugin.name,
                label: plugin.label,
                icon: plugin.icon || '🔌',
                style: plugin.style || { color: '#a78bfa', borderColor: 'rgba(167,139,250,0.3)' },
                tab: plugin.tab || 'tools',
                handler: plugin.handler,
                source: file,
            });
        } catch (e) {
            console.warn(`PluginLoader: failed to load ${file}:`, e.message);
        }
    }

    return plugins;
}

/**
 * Execute a plugin's handler with sandboxed error handling.
 * @param {object} plugin - loaded plugin manifest
 * @param {string} context - highlighted text
 * @returns {Promise<string>} handler result or error message
 */
async function executePlugin(plugin, context) {
    try {
        const result = await Promise.resolve(plugin.handler(context));
        return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (e) {
        return `Plugin "${plugin.name}" error: ${e.message}`;
    }
}

/**
 * Reload all plugins (for hot-reload without restart).
 * @returns {Array<object>} freshly loaded plugins
 */
function reloadPlugins() {
    return loadPlugins();
}

module.exports = { loadPlugins, executePlugin, reloadPlugins, PLUGIN_DIR };
