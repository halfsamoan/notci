import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import {DESIGN} from './designTokens.js';
import {notchGeometry} from './dockModel.js';

// The island continues the top panel as one opaque black slab: concave ears where it
// leaves the panel, vertical sides, a rounded bottom. Like the Dynamic Island it is
// always pure black, whatever the panel colour; a faint key line gives it an edge.
export function createNotchSurface() {
    const surface = new St.Widget({layout_manager: new Clutter.BinLayout(),
        width: DESIGN.geometry.neckWidth, height: DESIGN.geometry.seedHeight,
        visible: false, clip_to_allocation: true});
    const base = [0, 0, 0];

    const shape = new St.DrawingArea({reactive: false, x_expand: true, y_expand: true});
    shape.connect('repaint', area => {
        const [width, height] = area.get_surface_size();
        if (width < 1 || height < 1) return;
        const context = area.get_context();
        const {ear, radius, sliver} = notchGeometry(height, width);
        if (sliver) {
            // The seed sliver is the panel edge pulled down; no corners at this size.
            context.rectangle(0, 0, width, height);
        } else {
            context.moveTo(0, 0);
            context.arc(0, ear, ear, -Math.PI / 2, 0);
            context.lineTo(ear, height - radius);
            context.arcNegative(ear + radius, height - radius, radius, Math.PI, Math.PI / 2);
            context.lineTo(width - ear - radius, height);
            context.arcNegative(width - ear - radius, height - radius, radius, Math.PI / 2, 0);
            context.lineTo(width - ear, ear);
            context.arc(width, ear, ear, Math.PI, 1.5 * Math.PI);
            context.closePath();
        }
        const lift = DESIGN.material.lift;
        if (lift > 0) {
            const fill = new Cairo.LinearGradient(0, 0, 0, height);
            fill.addColorStopRGB(0, ...base);
            fill.addColorStopRGB(1, ...base.map(channel => channel + (1 - channel) * lift));
            context.setSource(fill);
        } else {
            context.setSourceRGB(...base);
        }
        if (sliver) {
            context.fill();
        } else {
            context.fillPreserve();
            // Key line half a pixel inside the edge, on the ears, sides and bottom only:
            // the top edge belongs to the panel.
            context.newPath();
            context.arc(0, ear, ear + 0.5, -Math.PI / 2, 0);
            context.lineTo(ear + 0.5, height - radius);
            context.arcNegative(ear + radius, height - radius, radius - 0.5, Math.PI, Math.PI / 2);
            context.lineTo(width - ear - radius, height - 0.5);
            context.arcNegative(width - ear - radius, height - radius, radius - 0.5, Math.PI / 2, 0);
            context.lineTo(width - ear - 0.5, ear);
            context.arc(width, ear, ear + 0.5, Math.PI, 1.5 * Math.PI);
            context.setSourceRGBA(1, 1, 1, DESIGN.material.keyLineAlpha);
            context.setLineWidth(1);
            context.stroke();
        }
        // GNOME Shell's own repaint handlers free the Cairo context immediately.
        context.$dispose();
    });
    surface.add_child(shape);

    // Two reactive regions approximate the slab without the ears.
    const bodyHit = new St.Widget({reactive: true, can_focus: false, x_expand: true, y_expand: true});
    const bottomHit = new St.Widget({reactive: true, can_focus: false,
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.FILL, y_expand: true});
    surface.add_child(bodyHit);
    surface.add_child(bottomHit);
    const updateHitRegions = () => {
        const width = Math.max(1, surface.width);
        const height = Math.max(1, surface.height);
        const {ear, radius, sliver} = notchGeometry(height, width);
        bodyHit.margin_left = bodyHit.margin_right = sliver ? 0 : ear;
        bodyHit.margin_bottom = sliver ? 0 : radius;
        bottomHit.width = Math.max(1, width - 2 * (ear + radius));
        bottomHit.margin_top = Math.max(0, height - radius);
    };
    // A theme reload (e.g. light/dark switch) resets margin_* to the CSS value 0,
    // which would make the transparent ears reactive until the next resize.
    for (const hit of [bodyHit, bottomHit])
        hit.connect('style-changed', updateHitRegions);
    surface.connect('notify::height', () => {
        updateHitRegions();
        shape.queue_repaint();
    });
    surface.connect('notify::width', () => {
        updateHitRegions();
        shape.queue_repaint();
    });
    // Module content keeps its final size and is revealed by the growing slab instead of
    // being relaid out every frame of the morph. BinLayout would clamp it to the slab,
    // so a fixed-layout holder lets the dock place each module at its slot.
    const holder = new Clutter.Actor({layout_manager: new Clutter.FixedLayout(), x_expand: true, y_expand: true});
    surface.add_child(holder);
    surface._holder = holder;
    updateHitRegions();
    return surface;
}
