import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

// Progress ring shared by the audio battery and the download pill (DynamicNotchKit: 3 px compact,
// 4 px card, round caps, fill on cubic-bezier(0,.55,.45,1)). Bounded Timelines only, never a loop.
export const RING_FILL_DELAY = 100;
const RING_FILL_MS = 800;
const RING_CHANGE_MS = 300;
const RING_CURVE = [new Graphene.Point({x: 0, y: 0.55}), new Graphene.Point({x: 0.45, y: 1})];
const RING_TRACK_ALPHA = 0.25;

// Dim full track in the foreground colour, bright arc from 12 o'clock. Size and stroke come from
// CSS (`-notci-ring-width`) so St scaling applies to both.
export function createRing(baseClass, sizeClass) {
    const area = new St.DrawingArea({style_class: `${baseClass} ${sizeClass}`, y_align: Clutter.ActorAlign.CENTER});
    const ring = {area, baseClass, sizeClass, value: 0, target: null, drawn: false, timeline: null};
    area.connect('repaint', () => {
        const cr = area.get_context();
        try {
            const node = area.get_theme_node();
            const color = node.get_foreground_color();
            const stroke = node.get_length('-notci-ring-width') || 3;
            const [width, height] = area.get_surface_size();
            const radius = (Math.min(width, height) - stroke) / 2;
            const [r, g, b, a] = [color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255];
            cr.setLineWidth(stroke);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setSourceRGBA(r, g, b, a * RING_TRACK_ALPHA);
            cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
            cr.stroke();
            if (ring.value > 0.005) {
                cr.setSourceRGBA(r, g, b, a);
                cr.arc(width / 2, height / 2, radius, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * ring.value);
                cr.stroke();
            }
        } finally {
            cr.$dispose();
        }
    });
    area.connect('style-changed', () => area.queue_repaint());
    area.connect('destroy', () => {
        ring.timeline?.stop();
        ring.timeline = null;
    });
    return ring;
}

// fraction null hides the ring; `fill` plays the 0→value connect fill, otherwise a 300 ms slide.
export function setRing(ring, fraction, toneClass, fill) {
    if (!ring) return;
    ring.area.visible = fraction !== null;
    ring.area.style_class = `${ring.baseClass} ${ring.sizeClass}${toneClass ? ` ${toneClass}` : ''}`;
    if (fraction === null) {
        ring.target = null;
        return;
    }
    // A later redraw toward the same value must not cut the running fill or slide short.
    if (!fill && ring.timeline && Math.abs(fraction - (ring.target ?? -1)) < 0.005) return;
    ring.target = fraction;
    const animate = St.Settings.get().enable_animations;
    if (!fill && (!ring.drawn || !animate || Math.abs(fraction - ring.value) < 0.005)) {
        ring.timeline?.stop();
        ring.timeline = null;
        ring.value = fraction;
        ring.drawn = true;
        ring.area.queue_repaint();
        return;
    }
    ring.timeline?.stop();
    const from = fill ? 0 : ring.value;
    ring.value = from;
    ring.drawn = true;
    if (!animate) {
        ring.value = fraction;
        ring.area.queue_repaint();
        return;
    }
    const timeline = new Clutter.Timeline({actor: ring.area, duration: fill ? RING_FILL_MS : RING_CHANGE_MS,
        delay: fill ? RING_FILL_DELAY : 0});
    timeline.set_cubic_bezier_progress(...RING_CURVE);
    timeline.connect('new-frame', () => {
        ring.value = from + (fraction - from) * timeline.get_progress();
        ring.area.queue_repaint();
    });
    timeline.connect('completed', () => {
        ring.value = fraction;
        ring.timeline = null;
        ring.area.queue_repaint();
    });
    ring.timeline = timeline;
    ring.area.queue_repaint();
    timeline.start();
}
