// Pure logic for the "AI reply finished" pet: no GI imports so node can test it.
// One original pixel character (not Clawd, not a Codex pet) for both apps; only the palette differs.

export const AGENT_APPS = {
    'com.anthropic.Claude.desktop': 'claude',
    'chatgpt.desktop': 'chatgpt',
};
export const AGENT_LABELS = {claude: 'Claude', chatgpt: 'ChatGPT'};

// Desktop file id first; WM class / notification source title as a fallback for window-backed apps.
export function agentSourceFor({appId = null, wmClass = null, title = null} = {}) {
    if (appId && AGENT_APPS[appId]) return AGENT_APPS[appId];
    const text = `${wmClass ?? ''} ${title ?? ''}`.toLowerCase();
    if (/\bclaude\b/.test(text)) return 'claude';
    if (/\bchatgpt\b|\bcodex\b/.test(text)) return 'chatgpt';
    return null;
}

// 12×12 cells (top row is flame room), drawn at CELL px. '.' is transparent: the black island shows through.
// B body, H highlight, S shade, K feet, E eye, W catchlight, C blush, M mouth, T calm flame tuft.
export const CELL = 2;
export const GRID_W = 12;
export const GRID_H = 12;
export const POSES = {
    base: [
        '............',
        '............',
        '......T.....',
        '.....TT.....',
        '...BBBBBB...',
        '..BHHBBBBB..',
        '.BHBBBBBBBB.',
        '.BBEWBBEWBB.',
        '.BBEEBBEEBB.',
        '.BCBBMMBBCB.',
        '..SSSSSSSS..',
        '...KK..KK...',
    ],
    // Anticipation and landing: one row shorter, one cell wider each side.
    squash: [
        '............',
        '............',
        '............',
        '......T.....',
        '.....TT.....',
        '..BBBBBBBB..',
        '.BHHBBBBBBB.',
        'BHBEWBBEWBBB',
        'BBBEEBBEEBBB',
        'BCBBBMMBBBCB',
        '.SSSSSSSSSS.',
        '..KK....KK..',
    ],
    // Launch: narrower and one row taller, feet together.
    stretch: [
        '............',
        '......T.....',
        '.....TT.....',
        '....BBBB....',
        '...BHBBBB...',
        '..BHBBBBBB..',
        '..BEWBBEWB..',
        '..BEEBBEEB..',
        '..BCBMMBCB..',
        '..BBBBBBBB..',
        '...SSSSSS...',
        '....K..K....',
    ],
    // Done: ^ ^ eyes.
    happy: [
        '............',
        '............',
        '......T.....',
        '.....TT.....',
        '...BBBBBB...',
        '..BHHBBBBB..',
        '.BHBBBBBBBB.',
        '.BBEBBBBEBB.',
        '.BEBEBBEBEB.',
        '.BCBBMMBBCB.',
        '..SSSSSSSS..',
        '...KK..KK...',
    ],
    blink: [
        '............',
        '............',
        '......T.....',
        '.....TT.....',
        '...BBBBBB...',
        '..BHHBBBBB..',
        '.BHBBBBBBBB.',
        '.BBBBBBBBBB.',
        '.BBEEBBEEBB.',
        '.BCBBMMBBCB.',
        '..SSSSSSSS..',
        '...KK..KK...',
    ],
    // Waiting: eyes (with their catchlights) one cell toward the app that finished.
    lookL: [
        '............',
        '............',
        '......T.....',
        '.....TT.....',
        '...BBBBBB...',
        '..BHHBBBBB..',
        '.BHBBBBBBBB.',
        '.BEWBBEWBBB.',
        '.BEEBBEEBBB.',
        '.BCBBMMBBCB.',
        '..SSSSSSSS..',
        '...KK..KK...',
    ],
    lookR: [
        '............',
        '............',
        '......T.....',
        '.....TT.....',
        '...BBBBBB...',
        '..BHHBBBBB..',
        '.BHBBBBBBBB.',
        '.BBBEWBBEWB.',
        '.BBBEEBBEEB.',
        '.BCBBMMBBCB.',
        '..SSSSSSSS..',
        '...KK..KK...',
    ],
};
// Excited tuft: a 4-row flame on the body's top row, flickering between three frames.
// y white-hot core, o flame, r outer edge.
export const FLAMES = [
    ['......y.....', '.....ry.....', '....oyyo....', '...royyor...'],
    ['.......r....', '......yo....', '....royo....', '...royyor...'],
    ['....r.......', '....oy..r...', '....oyyo....', '...royyor...'],
];

export const PALETTES = {
    claude: {B: '#ff8a3d', H: '#ffb577', S: '#d9622b', K: '#c4521f', E: '#2b1a12', W: '#ffffff', C: '#ff7a8a',
        M: '#8f2f17', T: '#ffd166', y: '#fff6d6', o: '#ffc233', r: '#ff5a1f'},
    chatgpt: {B: '#5cc8ff', H: '#a8e4ff', S: '#2e9bdb', K: '#2585c2', E: '#0e2233', W: '#ffffff', C: '#ff8fb1',
        M: '#124a75', T: '#7fe3ff', y: '#f0fdff', o: '#7fe3ff', r: '#2e7bff'},
};

// The pose with its calm tuft swapped for a flame frame (null keeps the tuft).
export function composePose(name, flame = null) {
    const rows = POSES[name].map(row => row.split(''));
    if (flame === null) return rows.map(row => row.join(''));
    for (const row of rows) for (let x = 0; x < row.length; x++) if (row[x] === 'T') row[x] = '.';
    const bodyTop = rows.findIndex(row => row.includes('B'));
    FLAMES[flame % FLAMES.length].forEach((line, i) => {
        const y = bodyTop - FLAMES[0].length + i;
        if (y < 0) return;
        for (let x = 0; x < line.length; x++) if (line[x] !== '.') rows[y][x] = line[x];
    });
    return rows.map(row => row.join(''));
}

// ---- Motion: frames of {pose, y, ms, flame}; y is px (negative is up), kept on whole cells. ----
// Never a vsync transition (see AGENTS.md): each entry is one GLib timer wake and one repaint, at
// least TICK_MS (15 fps). Identical consecutive ticks are written as one longer entry.
// Attention comes from motion onsets, not from motion that keeps going (Abrams & Christ 2003;
// Bartram et al. 2003 "Moticons"): two short bursts with still beats, then sparser re-alerts.
export const TICK_MS = 66;
export const CALM_SLOW_AFTER_MS = 60 * 1000;
export const CALM_NO_HOP_AFTER_MS = 5 * 60 * 1000;
export const CALM_MAX_MS = 10 * 60 * 1000;
// Resolved by agent.js to lookL / lookR / base from where the finished app's window is.
export const LOOK = 'look';

const at = (pose, y, ms = TICK_MS, flame = null) => ({pose, y, ms, flame});

// Pops up through the island's bottom edge: below the clip, a stretched rise, an overshoot, a squash.
export function arriveFrames() {
    return [at('stretch', 24), at('stretch', 16), at('stretch', 8), at('stretch', -2), at('squash', 0),
        at('happy', 0, 3 * TICK_MS)];
}

// Anticipation squash, stretched launch, apex hang, fall, landing squash, settle (Codex "jumping"
// rows and Coucou/Mochi squash keyframes, re-timed to 15 fps).
export function hopFrames(height) {
    const half = -Math.max(CELL, Math.round(height / 2 / CELL) * CELL);
    const fall = height > CELL ? [at('base', half)] : [];
    return [at('squash', 0, 2 * TICK_MS), at('stretch', half), at('happy', -height, 2 * TICK_MS), ...fall,
        at('squash', 0), at('happy', 0, 2 * TICK_MS)];
}

// Two bursts (~5.3 s): hops of 6/4/2 px with the flame flickering one frame per entry, then a
// fully still beat (tuft back) so the next burst is a fresh onset.
export function excitedFrames() {
    const burst = [...hopFrames(6), ...hopFrames(4), ...hopFrames(2)].map((frame, i) => ({...frame, flame: i % FLAMES.length}));
    const beat = at('happy', 0, 14 * TICK_MS);
    return [...burst, beat, ...burst, beat];
}

// One calm cycle at `elapsedMs` into the wait: look toward the app, blink, a small hop. Holds
// stretch 2.5× after a minute and the hop goes after five (~1.0 → ~0.5 → ~0.3 wakes/s).
export function calmCycle(elapsedMs = 0) {
    const s = elapsedMs < CALM_SLOW_AFTER_MS ? 1 : 2.5;
    const hop = elapsedMs < CALM_NO_HOP_AFTER_MS ?
        [at('squash', 0, 2 * TICK_MS), at('happy', -CELL, 3 * TICK_MS), at('squash', 0)] : [];
    return [at('base', 0, 2600 * s), at(LOOK, 0, 800), at('base', 0, 2400 * s), at('blink', 0, 2 * TICK_MS),
        at('base', 0, 1400 * s), ...hop];
}

export function leaveFrames() {
    return [at('squash', 0), at('stretch', -2), at('stretch', 12), at('stretch', 24)];
}
