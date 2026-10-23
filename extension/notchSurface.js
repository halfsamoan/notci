import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import {DESIGN} from './designTokens.js';
import {notchGeometry} from './dockModel.js';

// Children fill the slab, except the two hit regions that approximate it without the ears. They are
// placed here, during allocation: setting their size from notify::width ran inside the allocation pass,
// re-queued a relayout on every morph frame and made Clutter warn "Can't update stage views ... needs
// an allocation" about 40 times per open or close (measured 2026-10-23).
export const NotchLayout = GObject.registerClass(class NotchLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width() {
        return [0, 0];       // the dock sets the slab size explicitly
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        const width = Math.max(1, box.get_width());
        const height = Math.max(1, box.get_height());
        const {ear, radius, sliver} = notchGeometry(height, width);
        const place = (child, x1, y1, x2, y2) =>
            child.allocate(Clutter.ActorBox.new(box.x1 + x1, box.y1 + y1, box.x1 + x2, box.y1 + y2));
        for (const child of container.get_children()) {
            if (child === this.bodyHit) {
                place(child, sliver ? 0 : ear, 0, sliver ? width : width - ear, sliver ? height : height - radius);
            } else if (child === this.bottomHit) {
                const hitWidth = Math.max(1, width - 2 * (ear + radius));
                const x = (width - hitWidth) / 2;
                place(child, x, Math.max(0, height - radius), x + hitWidth, height);
            } else {
                place(child, 0, 0, width, height);
            }
        }
    }
});

// The island continues the top panel as one opaque black slab: concave ears where it
// leaves the panel, vertical sides, a rounded bottom. Like the Dynamic Island it is
// always pure black, whatever the panel colour; a faint key line gives it an edge.
export function createNotchSurface() {
    const layout = new NotchLayout();
    const surface = new St.Widget({layout_manager: layout,
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

    // Two reactive regions approximate the slab without the ears (placed by NotchLayout).
    layout.bodyHit = new St.Widget({reactive: true, can_focus: false});
    layout.bottomHit = new St.Widget({reactive: true, can_focus: false});
    surface.add_child(layout.bodyHit);
    surface.add_child(layout.bottomHit);
    surface.connect('notify::height', () => shape.queue_repaint());
    surface.connect('notify::width', () => shape.queue_repaint());
    // Module content keeps its final size and is revealed by the growing slab instead of
    // being relaid out every frame of the morph. BinLayout would clamp it to the slab,
    // so a fixed-layout holder lets the dock place each module at its slot.
    const holder = new Clutter.Actor({layout_manager: new Clutter.FixedLayout(), x_expand: true, y_expand: true});
    surface.add_child(holder);
    surface._holder = holder;
    return surface;
}
