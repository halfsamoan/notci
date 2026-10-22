// Pure helpers for the Spotify module. No GI imports: node:test runs them as-is.

const str = value => typeof value === 'string' ? value : '';
const int = value => {
    const number = typeof value === 'bigint' ? Number(value) : value;
    return Number.isInteger(number) && number > 0 ? number : 0;
};

// MPRIS Metadata (already recursively unpacked) → plain state; wrong types fall back to empty.
export function metadataToState(metadata) {
    const data = metadata && typeof metadata === 'object' ? metadata : {};
    const artists = Array.isArray(data['xesam:artist']) ? data['xesam:artist'].filter(a => typeof a === 'string' && a) : [];
    return {trackId: str(data['mpris:trackid']), title: str(data['xesam:title']), artists,
        album: str(data['xesam:album']), lengthUs: int(data['mpris:length']), artUrl: str(data['mpris:artUrl'])};
}

// Position in µs extrapolated from the last D-Bus read; held while paused, clamped to the length.
export function positionAt({positionUs = 0, atUs = 0, playing = false, lengthUs = 0}, nowUs) {
    const position = Math.max(0, positionUs + (playing ? Math.max(0, nowUs - atUs) : 0));
    return lengthUs > 0 ? Math.min(position, lengthUs) : position;
}

// Spotify CDN image ids encode the size in their prefix: b273 = 640, 1e02 = 300, 4851 = 64.
export function artVariantUrl(url, scale = 1) {
    if (typeof url !== 'string') return '';
    return url.replace(/^https:\/\/open\.spotify\.com\/image\//, 'https://i.scdn.co/image/')
        .replace(/ab67616d0000b273([0-9a-f]{32})$/, (_match, id) => `${scale > 1 ? 'ab67616d00001e02' : 'ab67616d00004851'}${id}`);
}

const channel = value => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (r, g, b) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
// WCAG contrast on black is (L + 0.05) / 0.05; 4.5:1 needs L >= 0.175.
const MIN_LUMINANCE = 0.175;

// Most saturated-and-bright pixel of a tiny pixbuf, lifted until it reads on black; greys → fallback.
export function accentFromPixels(pixels, width, height, rowstride, nChannels, fallback) {
    let best = null;
    let bestScore = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * rowstride + x * nChannels;
            const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
            const max = Math.max(r, g, b);
            const saturation = max ? (max - Math.min(r, g, b)) / max : 0;
            const score = saturation * max;
            if (score > bestScore) [best, bestScore] = [{r, g, b, saturation}, score];
        }
    }
    if (!best || best.saturation < 0.25) return fallback;
    let {r, g, b} = best;
    for (let step = 0; step < 100 && luminance(r, g, b) < MIN_LUMINANCE; step++) {
        // Scale while the hue survives it, then blend towards white (which always converges).
        const scalable = Math.max(r, g, b) * 1.05 <= 255;
        [r, g, b] = [r, g, b].map(v => scalable ? v * 1.05 : v + (255 - v) * 0.05);
    }
    return `#${[r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

export function formatTime(us) {
    const seconds = Math.max(0, Math.floor((Number(us) || 0) / 1e6));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
