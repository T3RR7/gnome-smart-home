// SPDX-License-Identifier: MIT
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {hexToRgb, rgbToHex} from './model.js';

const TURN = 2 * Math.PI;
const HUES = [[1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1], [1, 0, 1]];

// Hue runs clockwise from red. The wheel blends toward white at its center.
function wheelRgb(hue, saturation = 1) {
    const sector = hue * HUES.length;
    const index = Math.floor(sector);
    const blend = sector - index;
    const from = HUES[index % HUES.length];
    const to = HUES[(index + 1) % HUES.length];
    return from.map((channel, i) => 1 - saturation + saturation * (channel + (to[i] - channel) * blend));
}

function wheelPosition([red, green, blue]) {
    const peak = Math.max(red, green, blue);
    const range = peak - Math.min(red, green, blue);
    if (range === 0)
        return [0, 0];
    const hue = peak === red ? (green - blue) / range
        : peak === green ? 2 + (blue - red) / range
            : 4 + (red - green) / range;
    return [((hue + 6) % 6) * TURN / 6, range / peak];
}

/** An inline Shell color wheel with an exact RGB hex input. It emits only user selections. */
export const LightColorPicker = GObject.registerClass(
class GshLightColorPicker extends St.BoxLayout {
    _init(onColorPicked) {
        super._init({orientation: Clutter.Orientation.VERTICAL, style_class: 'gsh-light-color-picker',
            x_align: Clutter.ActorAlign.CENTER});
        this._onColorPicked = onColorPicked;
        this._hex = '#ffffff';
        this._wheel = new St.DrawingArea({style_class: 'gsh-color-wheel', reactive: true,
            x_align: Clutter.ActorAlign.CENTER, accessible_name: _('Light color')});
        this._wheel.connect('repaint', () => this._paintWheel());
        this._wheel.connect('button-release-event', (_actor, event) => this._chooseAtPointer(event));
        this.add_child(this._wheel);

        const form = new St.BoxLayout({style_class: 'gsh-hex-form', x_expand: true});
        this._entry = new St.Entry({style_class: 'gsh-hex-entry', accessible_name: _('Hex color'),
            hint_text: '#RRGGBB', text: this._hex, can_focus: true, x_expand: true});
        this._entry.clutter_text.connect('activate', () => this._applyHex());
        this._entry.clutter_text.connect('text-changed', () => this._entry.remove_style_pseudo_class('error'));
        const apply = new St.Button({style_class: 'button gsh-hex-apply', label: _('Apply color'), can_focus: true});
        apply.connect('clicked', () => this._applyHex());
        form.add_child(this._entry);
        form.add_child(apply);
        this.add_child(form);
    }

    setColor(rgb) {
        const hex = Array.isArray(rgb) && rgb.length === 3 && rgb.every(Number.isFinite) ? rgbToHex(rgb) : '#ffffff';
        if (hex === this._hex)
            return;
        // Keep an unfinished hex edit when a device update arrives.
        if (this._entry.text === this._hex)
            this._entry.text = hex;
        this._hex = hex;
        this._wheel.queue_repaint();
    }

    resetEntry() {
        this._entry.text = this._hex;
        this._entry.remove_style_pseudo_class('error');
    }

    _applyHex() {
        const rgb = hexToRgb(this._entry.text);
        if (rgb)
            this._select(rgb);
        else
            this._entry.add_style_pseudo_class('error');
    }

    _select(rgb) {
        this._entry.text = rgbToHex(rgb);
        this._onColorPicked(rgb);
    }

    _wheelRadius(width, height) {
        // Reserve space for the selection ring at the outer edge.
        return Math.min(width, height) / 2 - 6;
    }

    _chooseAtPointer(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [valid, x, y] = this._wheel.transform_stage_point(...event.get_coords());
        const [width, height] = this._wheel.get_size();
        const dx = x - width / 2;
        const dy = y - height / 2;
        const distance = Math.hypot(dx, dy);
        const radius = this._wheelRadius(width, height);
        if (valid && radius > 0 && distance <= radius) {
            const hue = ((Math.atan2(dy, dx) + TURN) % TURN) / TURN;
            this._select(wheelRgb(hue, distance / radius).map(value => Math.round(255 * value)));
        }
        return Clutter.EVENT_STOP;
    }

    _paintWheel() {
        const [width, height] = this._wheel.get_surface_size();
        const radius = this._wheelRadius(width, height);
        if (radius <= 0)
            return;
        const x = width / 2;
        const y = height / 2;
        const cr = this._wheel.get_context();
        try {
            cr.save();
            cr.arc(x, y, radius, 0, TURN);
            cr.clip();
            const slices = 180;
            for (let i = 0; i < slices; i++) {
                cr.moveTo(x, y);
                cr.arc(x, y, radius + 1, i * TURN / slices - 0.01, (i + 1) * TURN / slices);
                cr.closePath();
                cr.setSourceRGB(...wheelRgb((i + 0.5) / slices));
                cr.fill();
            }
            const saturation = new Cairo.RadialGradient(x, y, 0, x, y, radius);
            saturation.addColorStopRGBA(0, 1, 1, 1, 1);
            saturation.addColorStopRGBA(1, 1, 1, 1, 0);
            cr.setSource(saturation);
            cr.paint();
            cr.restore();

            const [angle, fraction] = wheelPosition(hexToRgb(this._hex));
            const markerX = x + Math.cos(angle) * radius * fraction;
            const markerY = y + Math.sin(angle) * radius * fraction;
            cr.arc(markerX, markerY, 4, 0, TURN);
            cr.setSourceRGBA(0, 0, 0, 0.65);
            cr.setLineWidth(3);
            cr.strokePreserve();
            cr.setSourceRGB(1, 1, 1);
            cr.setLineWidth(1.5);
            cr.stroke();
        } finally {
            cr.$dispose();
        }
    }
});
