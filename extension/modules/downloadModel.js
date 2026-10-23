// Pure big-download logic: no GI imports so node can test it.
// Browsers publish no progress on GNOME Wayland (Firefox has no IPC for it, Chrome only talks to
// libunity on Unity/KDE), so the island watches the download folder's temp files instead.

export const THRESHOLD = 0.7e9;   // SI bytes, like GNOME Files
export const STALL_MS = 10000;

// Firefox writes `<stem>.<random>.<ext>.part`, Chrome `<name>.crdownload`; dotfiles are never downloads.
export function isTempDownload(name) {
    return !name.startsWith('.') && /\.(part|crdownload)$/.test(name);
}

export function isFirefoxTemp(name) {
    return name.endsWith('.part');
}

// [Profile*] Path= entries of a Firefox profiles.ini, made absolute against its directory.
export function firefoxProfileDirs(iniText, baseDir) {
    const dirs = [];
    let profile = null;
    const flush = () => {
        if (profile?.path) dirs.push(profile.relative ? `${baseDir}/${profile.path}` : profile.path);
    };
    for (const raw of (iniText ?? '').split('\n')) {
        const line = raw.trim();
        if (line.startsWith('[')) {
            flush();
            profile = /^\[Profile\d+\]$/.test(line) ? {path: null, relative: true} : null;
        } else if (profile && line.startsWith('Path=')) {
            profile.path = line.slice(5);
        } else if (profile && line.startsWith('IsRelative=')) {
            profile.relative = line.slice(11) !== '0';
        }
    }
    flush();
    return dirs;
}

// downloads.json lists every running download with its Content-Length (totalBytes) and temp path.
export function firefoxTotal(jsonText, partPath) {
    try {
        const entry = (JSON.parse(jsonText).list ?? []).find(item => item?.target?.partFilePath === partPath);
        return entry?.totalBytes > 0 ? entry.totalBytes : 0;
    } catch (_error) {
        return 0;
    }
}

export function formatGB(bytes) {
    const gb = bytes / 1e9;
    return `${gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)} GB`;
}

// The one download the pill shows: the biggest that qualifies (known total, else bytes so far).
export function pickDownload(entries) {
    const size = entry => entry.total || entry.received;
    return entries.filter(entry => size(entry) >= THRESHOLD).sort((a, b) => size(b) - size(a))[0] ?? null;
}

// Known total: ring + whole percent. Unknown (Chrome, or Firefox before downloads.json is read):
// bytes received, no ring. Stalled 10 s: warning tone.
export function pillView(entry, nowMs) {
    if (!entry) return null;
    const tone = nowMs - entry.lastGrowth >= STALL_MS ? 'stalled' : null;
    if (entry.total > 0) {
        const fraction = Math.min(1, entry.received / entry.total);
        // Integer maths: 0.812/1.4 in floats floors to 57.
        return {fraction, text: `${Math.min(100, Math.floor(entry.received * 100 / entry.total))}%`, tone};
    }
    return {fraction: null, text: formatGB(entry.received), tone};
}
