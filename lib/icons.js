// SPDX-License-Identifier: MIT
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {iconFor} from './model.js';

export const ICON_DIRECTORY = `${Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path()}/icons/gnome`;
const bundledIcons = Gio.File.new_for_path(ICON_DIRECTORY);
const importedIcons = Gio.File.new_for_path(`${GLib.get_user_data_dir()}/gnome-smart-home/icons`);
const shellIcons = new Map();

export const ICON_CHOICES = [
    ['lightbulb-modern-symbolic', 'Light bulb'], ['lamp-symbolic', 'Desk lamp'],
    ['switch-left-symbolic', 'Switch'], ['plug-symbolic', 'Socket'],
    ['chip-symbolic', 'Sensor'], ['devices-symbolic', 'Devices'],
    ['ac-symbolic', 'Wall power'],
    ['display-brightness-symbolic', 'Brightness'], ['night-light-symbolic', 'Night light'],
    ['weather-clear-symbolic', 'Daylight'], ['weather-clear-night-symbolic', 'Moonlight'],
    ['system-shutdown-symbolic', 'Power'],
    ['weather-windy-symbolic', 'Fan'], ['view-list-symbolic', 'Blinds'],
    ['go-home-symbolic', 'Home'], ['starred-symbolic', 'Scene'],
    ['color-select-symbolic', 'Color'],
    ['system-run-symbolic', 'Script'], ['media-playback-start-symbolic', 'Button'],
];

export function resolveIcon(choice, entityId) {
    const name = choice || iconFor(entityId);
    if (name.startsWith('file:///')) {
        const file = Gio.File.new_for_uri(name);
        if (file.query_exists(null))
            return new Gio.FileIcon({file});
        return resolveIcon('', entityId);
    }
    // Some stock Adwaita symbols are not indexed by a theme's GTK icon cache.
    // Read the original GNOME asset directly; no redrawing or replacement art.
    const stock = stockIconFile(name);
    if (stock)
        return new Gio.FileIcon({file: stock});
    if (name.endsWith('-symbolic'))
        return new Gio.ThemedIcon({names: [name, 'go-home-symbolic']});
    return new Gio.ThemedIcon({name: 'go-home-symbolic'});
}

/** Adapt bundled and imported monochrome SVGs to GNOME Shell's symbolic renderer. */
export function resolveShellIcon(choice, entityId) {
    const icon = resolveIcon(choice, entityId);
    if (!(icon instanceof Gio.FileIcon))
        return icon;
    const source = icon.get_file();
    if (!source.has_prefix(bundledIcons) && !source.has_prefix(importedIcons))
        return icon;

    const uri = source.get_uri();
    if (shellIcons.has(uri))
        return shellIcons.get(uri);

    try {
        const [, bytes] = source.load_contents(null);
        // Shell recolors SVG fills. Put the original silhouette in a separate
        // image document and let Shell recolor the rectangle behind its alpha mask.
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="16" height="16">
  <mask id="shape" mask-type="alpha">
    <image width="16" height="16" xlink:href="data:image/svg+xml;base64,${GLib.base64_encode(bytes)}"/>
  </mask>
  <rect width="16" height="16" mask="url(#shape)"/>
</svg>`;
        const checksum = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, svg, -1);
        const directory = `${GLib.get_user_cache_dir()}/gnome-smart-home/icons`;
        const target = Gio.File.new_for_path(`${directory}/${checksum}-${source.get_basename()}`);
        if (!target.query_exists(null)) {
            GLib.mkdir_with_parents(directory, 0o700);
            target.replace_contents(svg, null, false, Gio.FileCreateFlags.PRIVATE, null);
        }
        const shellIcon = new Gio.FileIcon({file: target});
        shellIcons.set(uri, shellIcon);
        return shellIcon;
    } catch {
        return icon;
    }
}

const stockFiles = new Map();
export function stockIconFile(name) {
    if (stockFiles.has(name))
        return stockFiles.get(name);
    const bundled = Gio.File.new_for_path(`${ICON_DIRECTORY}/${name}.svg`);
    if (bundled.query_exists(null)) {
        stockFiles.set(name, bundled);
        return bundled;
    }
    for (const directory of GLib.get_system_data_dirs()) {
        for (const category of ['status', 'actions', 'devices', 'places', 'apps', 'legacy', 'categories', 'ui', 'mimetypes', 'emotes']) {
            const file = Gio.File.new_for_path(`${directory}/icons/Adwaita/symbolic/${category}/${name}.svg`);
            if (file.query_exists(null)) {
                stockFiles.set(name, file);
                return file;
            }
        }
    }
    stockFiles.set(name, null);
    return null;
}

export async function importSymbolicIcon(file, cancellable) {
    const [bytes] = await file.load_contents_async(cancellable);
    if (bytes.length > 256 * 1024)
        throw new Error('invalid-icon');
    const svg = new TextDecoder().decode(bytes);
    // Symbolic vectors only. Reject images, active content and external resources.
    if (!/<svg\b/i.test(svg) || /<(?:image|script|foreignObject|linearGradient|radialGradient)\b|(?:href\s*=|url\s*\()/i.test(svg))
        throw new Error('invalid-icon');
    const colors = [...svg.matchAll(/(?:fill|stroke)\s*=\s*["']([^"']+)["']/gi)]
        .map(match => match[1].toLowerCase()).filter(value => !['none', 'currentcolor', 'inherit'].includes(value));
    if (new Set(colors).size > 1)
        throw new Error('invalid-icon');
    GLib.mkdir_with_parents(importedIcons.get_path(), 0o700);
    const target = importedIcons.get_child(`${GLib.uuid_string_random()}-symbolic.svg`);
    await target.replace_contents_bytes_async(new GLib.Bytes(bytes), null, false,
        Gio.FileCreateFlags.PRIVATE, cancellable);
    return target.get_uri();
}

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
