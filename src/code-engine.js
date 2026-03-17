/**
 * Locus Code Engine — Senior Engineer Mode
 *
 * Forged by Blueprint Forge (quality 0.780, claude/standard/t=0.7).
 * Makes Locus analyze code like a staff-level engineer.
 *
 * Capabilities:
 *   - Language detection via structural heuristics
 *   - Expert-level LLM system prompts for review, debug, refactor, explain, security
 *   - Context enrichment for errors, stack traces, git diffs
 *   - Response formatting with severity indicators
 *
 * Pure Node.js — no external dependencies.
 * This module generates prompts; LLM calls happen in main.js.
 */
'use strict';

// ── Language Detection ───────────────────────────────

const LANG_SIGNATURES = {
    python: {
        keywords: /\b(def|class|import|from|elif|except|lambda|yield|async\s+def|await|with\s+\w+\s+as)\b/,
        patterns: [/^\s*#!.*python/, /:\s*$/, /self\.\w+/, /print\(/, /__\w+__/, /\.py$/],
        extensions: ['.py'],
    },
    javascript: {
        keywords: /\b(const|let|var|function|=>|require\(|module\.exports|console\.log)\b/,
        patterns: [/===|!==/, /\.then\(/, /\.catch\(/, /async\s+function/, /\)\s*=>\s*{/],
        extensions: ['.js', '.mjs', '.cjs'],
    },
    typescript: {
        keywords: /\b(interface|type\s+\w+\s*=|enum|namespace|readonly|as\s+\w+|implements)\b/,
        patterns: [/:\s*(string|number|boolean|void|any|unknown|never)\b/, /<\w+>/, /\.tsx?$/],
        extensions: ['.ts', '.tsx'],
    },
    rust: {
        keywords: /\b(fn\s+\w+|let\s+mut|impl\s|struct\s|enum\s|trait\s|match\s|pub\s+fn|use\s+\w+::|\bmod\s+\w+)\b/,
        patterns: [/->/, /&mut/, /unwrap\(\)/, /Ok\(|Err\(/, /Vec</, /#\[derive/, /let\s+mut\s/],
        extensions: ['.rs'],
    },
    go: {
        keywords: /\b(func|package|import|defer|goroutine|chan|select|go\s+func)\b/,
        patterns: [/:=/, /fmt\./, /err\s*!=\s*nil/, /func\s*\(/, /\brange\s+\w+/],
        extensions: ['.go'],
    },
    c: {
        keywords: /\b(#include|typedef|struct|malloc|free|printf|sizeof|void\s+\w+\()\b/,
        patterns: [/#include\s*</, /\*\w+/, /->/, /NULL/, /int\s+main\s*\(/],
        extensions: ['.c', '.h'],
    },
    cpp: {
        keywords: /\b(class|template|namespace|std::|cout|cin|virtual|override|nullptr)\b/,
        patterns: [/::/, /#include\s*<\w+>/, /auto\s+\w+/, /std::vector/, /new\s+\w+/],
        extensions: ['.cpp', '.hpp', '.cc'],
    },
    java: {
        keywords: /\b(public\s+class|private\s+\w|protected\s+\w|static\s+void|extends\s|implements\s|@Override|@Autowired)\b/,
        patterns: [/System\.out/, /new\s+\w+\(/, /\.class/, /throws\s+\w+/, /import\s+java\./, /public\s+static\s+void\s+main/],
        extensions: ['.java'],
    },
    bash: {
        keywords: /\b(echo|if\s+\[|fi|done|do|then|elif|esac|case|function\s+\w+)\b/,
        patterns: [/^\s*#!/, /\$\{?\w+\}?/, /\|\|/, /&&/, /\$\(/, />>\s*\//],
        extensions: ['.sh', '.bash'],
    },
    sql: {
        keywords: /\b(SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|ALTER|DROP|JOIN|WHERE|FROM)\b/i,
        patterns: [/\bINNER\s+JOIN\b/i, /\bGROUP\s+BY\b/i, /\bORDER\s+BY\b/i, /\bHAVING\b/i],
        extensions: ['.sql'],
    },
    html: {
        keywords: /(<html|<div|<span|<body|<head|<script|<style|<link|<meta)/i,
        patterns: [/class="/, /id="/, /<\/\w+>/, /<!DOCTYPE/i],
        extensions: ['.html', '.htm'],
    },
    css: {
        keywords: /\b(color|background|margin|padding|display|font-size|border|position)\s*:/,
        patterns: [/\{[^}]*:\s*[^;]+;/, /@media/, /@keyframes/, /\.[\w-]+\s*\{/, /#[\w-]+\s*\{/],
        extensions: ['.css', '.scss', '.less'],
    },
};

/**
 * Detect the programming language of a code snippet.
 * @param {string} code - The code to analyze
 * @returns {{ language: string, confidence: number }}
 */
function detectLanguage(code) {
    if (!code || typeof code !== 'string' || code.length < 3) {
        return { language: 'unknown', confidence: 0 };
    }

    const scores = {};

    for (const [lang, sig] of Object.entries(LANG_SIGNATURES)) {
        let score = 0;

        // Keyword matches (weighted 2x)
        const kwMatches = code.match(sig.keywords);
        if (kwMatches) score += kwMatches.length * 2;

        // Pattern matches
        for (const pat of sig.patterns) {
            if (pat.test(code)) score += 1;
        }

        scores[lang] = score;
    }

    // TypeScript beats JavaScript if both score (TS is a superset)
    if (scores.typescript > 0 && scores.javascript > 0) {
        scores.typescript += 2;
    }
    // C++ beats C if both score
    if (scores.cpp > 0 && scores.c > 0) {
        scores.cpp += 2;
    }
    // Java beats C++ if Java-specific markers present
    if (scores.java > 0 && scores.cpp > 0) {
        if (/System\.out|import\s+java\.|@Override|public\s+static\s+void\s+main/.test(code)) {
            scores.java += 4;
        }
    }

    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0 || sorted[0][1] === 0) {
        return { language: 'unknown', confidence: 0 };
    }

    const topScore = sorted[0][1];
    const maxPossible = 12; // rough max for any language
    const confidence = Math.min(topScore / maxPossible, 0.99);

    return {
        language: sorted[0][0],
        confidence: Math.round(confidence * 100) / 100,
    };
}


// ── Complexity Assessment ────────────────────────────

/**
 * Estimate cyclomatic complexity using structural heuristics.
 * @param {string} code
 * @returns {{ estimate: number, level: string, factors: string[] }}
 */
function assessComplexity(code) {
    const factors = [];
    let complexity = 1; // base

    // Count branching keywords
    const branches = (code.match(/\b(if|else if|elif|case|catch|except|when|guard)\b/g) || []).length;
    complexity += branches;
    if (branches > 0) factors.push(`${branches} branches`);

    // Count loops
    const loops = (code.match(/\b(for|while|do|loop|each|map|filter|reduce)\b/g) || []).length;
    complexity += loops;
    if (loops > 0) factors.push(`${loops} loops`);

    // Count logical operators
    const logicals = (code.match(/&&|\|\||and\s|or\s|\?\?/g) || []).length;
    complexity += Math.floor(logicals / 2);
    if (logicals > 0) factors.push(`${logicals} logical ops`);

    // Count nested depth (indentation-based estimate)
    const lines = code.split('\n');
    let maxDepth = 0;
    for (const line of lines) {
        const indent = line.match(/^(\s*)/)[1].length;
        const depth = Math.floor(indent / 2);
        if (depth > maxDepth) maxDepth = depth;
    }
    if (maxDepth > 3) {
        factors.push(`nesting depth ${maxDepth}`);
        complexity += maxDepth - 3;
    }

    // Count function/method definitions
    const funcs = (code.match(/\b(function|def|fn|func|method|sub)\b/g) || []).length;
    if (funcs > 3) factors.push(`${funcs} functions`);

    let level = 'low';
    if (complexity > 15) level = 'high';
    else if (complexity > 8) level = 'medium';

    return { estimate: complexity, level, factors };
}


// ── Smart Prompts (Staff Engineer Quality) ───────────

const PROMPTS = {
    /**
     * Code review — staff engineer depth. Goes beyond surface bugs into
     * concurrency, growth bounds, testability, and architectural fitness.
     */
    review: (code, lang) => ({
        system: `You are a staff-level ${lang || ''} engineer performing a code review. Think deeply. Be specific.

REVIEW PROTOCOL:
1. State what the code does in ONE sentence.
2. Analyze these categories IN ORDER OF SEVERITY:

🔴 CRITICAL — things that WILL break in production:
- Race conditions, data corruption under concurrency
- Resource leaks (unclosed handles, connections, unbounded caches)
- Null/undefined paths that crash, off-by-one errors
- State mutation that violates invariants
- Error swallowing that hides failures

🟠 ARCHITECTURAL — things that hurt at scale:
- Unbounded growth (lists, caches, maps that grow forever without caps/eviction)
- Thread safety: is this safe to call from multiple threads/coroutines?
- Testability: can this be unit tested without mocking the universe?
  - Hard-coded dependencies (time.now, singletons, global state)
  - IO in constructors or __init__ methods
- API contracts: are preconditions documented? Can callers misuse this?
- Error propagation: do errors bubble up with enough context to debug?

🟡 PERFORMANCE:
- O(n²) or worse where O(n) or O(1) is possible
- Allocations inside hot loops
- Blocking IO in async context
- Missing caching where repeated computation is obvious

🟢 STYLE (only mention if genuinely confusing):
- Misleading names, dead code, functions >40 lines

FORMAT: Use emoji severity tags. Max 2 sentences per finding. Quote the specific line.
If the code is solid, say so — don't fabricate issues. But DIG DEEP before concluding it's clean.`,
        user: code,
    }),

    /**
     * Debugging — staff-level root cause analysis. Goes beyond the stack trace
     * into blast radius, systemic causes, and prevention.
     */
    debug: (error, stackTrace, code) => ({
        system: `You are a staff engineer debugging a production incident. Think systematically.

DEBUGGING PROTOCOL:
1. ERROR TYPE: Classify it (logic, type, null deref, race, resource leak, config, data corruption)
2. ROOT CAUSE: The specific line AND the assumption that was violated
3. BLAST RADIUS: What else could this affect? Is data corrupted? Are other callers impacted?
4. FIX: Exact code change — not a suggestion, the actual fix
5. SYSTEMIC CAUSE: Why did the system allow this bug? Missing validation? No type check? No test?
6. PREVENTION: Specific guard to prevent this class of bug (assertion, type constraint, test case)

Be precise. Engineers are oncall at 3am. They need the fix, not a lecture.`,
        user: [
            error ? `ERROR: ${error}` : '',
            stackTrace ? `STACK TRACE:\n${stackTrace}` : '',
            code ? `CODE:\n${code}` : '',
        ].filter(Boolean).join('\n\n'),
    }),

    /**
     * Refactoring — staff-level structural surgery.
     */
    refactor: (code, lang) => ({
        system: `You are a staff ${lang || ''} engineer refactoring code. Focus on structural health.

REFACTORING PRIORITIES (highest first):
1. DECOUPLE: Extract hard-coded dependencies (time, IO, singletons) into injectable params
2. BOUND: Add caps/limits to anything that grows (lists, caches, retry counts)
3. GUARD: Add invariant checks at function entry points (preconditions)
4. FLATTEN: Guard clauses instead of nested conditionals
5. EXTRACT: Functions >40 lines → smaller focused functions
6. NAME: Replace magic numbers with named constants

OUTPUT FORMAT:
- Show the refactored code first — complete, paste-ready
- Then 2-3 sentences explaining what changed and why
- Preserve behavior — this is refactoring, not feature work`,
        user: code,
    }),

    /**
     * Code explanation — staff-level depth including failure modes.
     */
    explain: (code, lang) => ({
        system: `You are a staff ${lang || ''} engineer explaining code. Go beyond WHAT to WHY and WHEN IT BREAKS.

EXPLANATION FORMAT:
1. PURPOSE: What this code accomplishes (1 sentence)
2. MECHANISM: How it works step by step (numbered, max 5 steps)
3. DESIGN CHOICES: Why was it built this way? What alternatives were considered?
4. FAILURE MODES: How can this break? What happens under bad input, concurrency, resource exhaustion?
5. DEPENDENCIES: What does this assume about its environment?

The reader is an engineer, not a student. Skip basic syntax. Focus on the non-obvious.`,
        user: code,
    }),

    /**
     * Security audit — staff-level, includes supply chain and timing.
     */
    security: (code, lang) => ({
        system: `You are a staff security engineer auditing ${lang || ''} code. OWASP + systems-level analysis.

AUDIT LAYERS:
🔴 INJECTION: SQL, command, XSS, template injection, LDAP, header injection
🔴 AUTH: Broken auth, session fixation, credential exposure, CSRF
🔴 CRYPTO: Weak algorithms, hardcoded keys, insufficient entropy, timing attacks
🟠 SUPPLY CHAIN: Untrusted dependencies, version pinning, dependency confusion
🟠 CONCURRENCY: TOCTOU races, double-spend, lock ordering violations
🟡 ACCESS: IDOR, privilege escalation, missing authz checks
🟡 DATA: PII exposure, missing encryption at rest/transit, sensitive data in logs
🟡 CONFIG: Debug mode, verbose errors, default creds, open CORS

For each finding:
- Severity + Location (quote the line)
- Attack scenario (how an attacker exploits it)
- Fix (specific code change)

Don't fabricate vulnerabilities. But think like an attacker — not just a checklist.`,
        user: code,
    }),
};

/**
 * Get a senior-engineer-level system prompt for the given action.
 * @param {'review'|'debug'|'refactor'|'explain'|'security'} action
 * @param {string} code - The code to analyze
 * @param {object} [opts] - Additional options
 * @param {string} [opts.language] - Detected language
 * @param {string} [opts.error] - Error message (for debug)
 * @param {string} [opts.stackTrace] - Stack trace (for debug)
 * @returns {{ system: string, user: string }}
 */
function getPrompt(action, code, opts = {}) {
    const lang = opts.language || detectLanguage(code).language;
    const promptFn = PROMPTS[action];

    if (!promptFn) {
        // Fallback to review
        return PROMPTS.review(code, lang);
    }

    if (action === 'debug') {
        return promptFn(opts.error || '', opts.stackTrace || '', code);
    }

    return promptFn(code, lang);
}


// ── Context Enrichment ───────────────────────────────

/**
 * Enrich context for better LLM analysis.
 * @param {string} text - The selected text
 * @param {string} type - The classification type from context-engine
 * @returns {{ enrichedText: string, metadata: object }}
 */
function enrichContext(text, type) {
    const metadata = {};

    switch (type) {
        case 'error': {
            // Extract error components
            const errorMatch = text.match(/(\w+Error|\w+Exception|Error):\s*(.+)/);
            if (errorMatch) {
                metadata.errorType = errorMatch[1];
                metadata.errorMessage = errorMatch[2].trim();
            }
            // Extract line numbers
            const lineMatch = text.match(/line\s+(\d+)/i);
            if (lineMatch) metadata.line = parseInt(lineMatch[1]);
            // Extract file
            const fileMatch = text.match(/(?:File\s+["']|at\s+.+\()(.+?\.(?:py|js|ts|rs|go|java))/);
            if (fileMatch) metadata.file = fileMatch[1];
            break;
        }

        case 'stack_trace': {
            // Find the root cause frame (usually the first or last user-code frame)
            const frames = text.split('\n').filter(l =>
                /at\s|File\s|\.py|\.js|\.ts|\.rs|\.go/.test(l) &&
                !/node_modules|site-packages|lib\/python/.test(l)
            );
            if (frames.length > 0) {
                metadata.rootFrame = frames[0].trim();
                metadata.userFrames = frames.length;
            }
            // Extract the exception
            const excMatch = text.match(/^(\w+(?:Error|Exception).*)$/m);
            if (excMatch) metadata.exception = excMatch[1];
            break;
        }

        case 'git_diff': {
            // Count additions and deletions
            const added = (text.match(/^\+[^+]/gm) || []).length;
            const removed = (text.match(/^-[^-]/gm) || []).length;
            metadata.linesAdded = added;
            metadata.linesRemoved = removed;
            metadata.netChange = added - removed;
            // Extract changed files
            const files = text.match(/^(?:---|\+\+\+)\s+[ab]\/(.+)$/gm);
            if (files) {
                metadata.changedFiles = files.map(f => f.replace(/^(?:---|\+\+\+)\s+[ab]\//, ''));
            }
            break;
        }

        case 'code': {
            const detection = detectLanguage(text);
            metadata.language = detection.language;
            metadata.languageConfidence = detection.confidence;
            metadata.complexity = assessComplexity(text);
            metadata.lineCount = text.split('\n').length;
            break;
        }

        default:
            break;
    }

    return { enrichedText: text, metadata };
}


// ── Response Formatting ──────────────────────────────

/**
 * Determine the best action for a given selection type.
 * This overrides the context-engine's generic handlers with
 * senior-engineer-grade prompts.
 * @param {string} type - The classification type
 * @returns {{ action: string, prompt: function }}
 */
function getCodeAction(type) {
    const mapping = {
        code: 'review',
        error: 'debug',
        stack_trace: 'debug',
        git_diff: 'review',
        file_path: 'explain',
        terminal_cmd: 'explain',
        json_yaml: 'explain',
        url: 'explain',
        word: 'explain',
        question: 'explain',
    };

    return mapping[type] || 'explain';
}

/**
 * Get expert system prompt based on selection type and content.
 * This is the main entry point — call this from main.js.
 * @param {string} text - Selected text
 * @param {string} type - Classification type from context-engine
 * @returns {{ system: string, user: string, action: string, metadata: object }}
 */
function getExpertPrompt(text, type) {
    const action = getCodeAction(type);
    const { enrichedText, metadata } = enrichContext(text, type);
    const lang = metadata.language || detectLanguage(text).language;

    const prompt = getPrompt(action, enrichedText, {
        language: lang !== 'unknown' ? lang : undefined,
        error: metadata.errorMessage || metadata.exception,
        stackTrace: type === 'stack_trace' ? text : undefined,
    });

    return {
        system: prompt.system,
        user: prompt.user,
        action,
        metadata,
    };
}


// ── Exports ──────────────────────────────────────────

module.exports = {
    detectLanguage,
    assessComplexity,
    getPrompt,
    enrichContext,
    getCodeAction,
    getExpertPrompt,
    PROMPTS,
};
