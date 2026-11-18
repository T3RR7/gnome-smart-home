// SPDX-License-Identifier: GPL-3.0-or-later
// No GNOME imports: state handling and service payloads can be tested separately.

export const SUPPORTED_DOMAINS = new Set([
    'light', 'switch', 'input_boolean', 'fan', 'cover', 'climate',
    'scene', 'script', 'button', 'input_button', 'sensor', 'binary_sensor',
]);

export function domainOf(entityId) {
    return String(entityId ?? '').split('.')[0];
}

export function normalizeUrl(input) {
    const url = String(input ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^/?#\s]+(?:\/[^?#\s]*)?$/i.test(url) || /[\\@]/.test(url))
        throw new Error('invalid-url');
    return url.replace(/^https?:/i, scheme => scheme.toLowerCase());
}

export function websocketUrl(url) {
    return `${normalizeUrl(url).replace(/^http/, 'ws')}/api/websocket`;
}

export function parseDevices(json) {
    let value;
    try {
        value = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    return value.filter(item => {
        if (!item || typeof item.id !== 'string' ||
            !/^[a-z_]+\.[a-z0-9_]+$/.test(item.id) ||
            !SUPPORTED_DOMAINS.has(domainOf(item.id)) || seen.has(item.id))
            return false;
        seen.add(item.id);
        return true;
    }).map(item => {
        const device = {id: item.id, name: typeof item.name === 'string' ? item.name.trim() : ''};
        if (typeof item.icon === 'string' && (item.icon.startsWith('file:///') || /^[a-z0-9-]+$/.test(item.icon)))
            device.icon = item.icon;
        return device;
    });
}

export function isAvailable(entity) {
    return Boolean(entity && !['unknown', 'unavailable'].includes(entity.state));
}

export function isOn(entity) {
    if (!isAvailable(entity))
        return false;
    if (domainOf(entity.entity_id) === 'climate')
        return entity.state !== 'off';
    if (domainOf(entity.entity_id) === 'cover')
        return ['open', 'opening'].includes(entity.state);
    return entity.state === 'on';
}

export function entityName(entity, favorite = null) {
    return favorite?.name || entity?.attributes?.friendly_name || favorite?.id || entity?.entity_id || '';
}

export function iconFor(entityOrId) {
    const entity = typeof entityOrId === 'object' && entityOrId !== null ? entityOrId : null;
    const entityId = entity?.entity_id ?? entityOrId;
    const deviceClass = entity?.attributes?.device_class;
    if (domainOf(entityId) === 'switch' && deviceClass === 'outlet')
        return 'plug-symbolic';
    return {
        light: 'lightbulb-modern-symbolic',
        switch: 'switch-left-symbolic',
        input_boolean: 'switch-left-symbolic',
        fan: 'weather-windy-symbolic',
        cover: 'view-list-symbolic',
        climate: 'weather-clear-symbolic',
        scene: 'starred-symbolic',
        script: 'system-run-symbolic',
        button: 'media-playback-start-symbolic',
        input_button: 'media-playback-start-symbolic',
        sensor: 'chip-symbolic',
        binary_sensor: 'chip-symbolic',
    }[domainOf(entityId)] ?? 'go-home-symbolic';
}

export function lightCapabilities(entity) {
    if (domainOf(entity?.entity_id) !== 'light')
        return {color: false, temperature: null};
    const a = entity.attributes ?? {};
    const modes = a.supported_color_modes ?? [];
    const color = modes.some(mode => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(mode));
    const temperature = modes.includes('color_temp') || modes.includes('rgbww');
    const min = Number.isFinite(a.min_color_temp_kelvin) ? a.min_color_temp_kelvin : 2000;
    const max = Number.isFinite(a.max_color_temp_kelvin) ? a.max_color_temp_kelvin : 6500;
    return {color, temperature: temperature && min > 0 && max > min ? {
        min, max, kelvin: Math.min(max, Math.max(min, a.color_temp_kelvin ?? (min + max) / 2)),
    } : null};
}

export function colorTemperatureCommand(entity, kelvin) {
    const descriptor = lightCapabilities(entity).temperature;
    if (!descriptor || !Number.isFinite(kelvin))
        throw new Error('unsupported-color-temperature');
    return {domain: 'light', service: 'turn_on', target: {entity_id: entity.entity_id},
        service_data: {color_temp_kelvin: Math.round(Math.min(descriptor.max, Math.max(descriptor.min, kelvin)))}};
}

export function colorCommand(entity, rgb) {
    if (!lightCapabilities(entity).color || !Array.isArray(rgb) || rgb.length !== 3 || !rgb.every(Number.isFinite))
        throw new Error('unsupported-color');
    return {domain: 'light', service: 'turn_on', target: {entity_id: entity.entity_id},
        service_data: {rgb_color: rgb.map(value => Math.round(Math.min(255, Math.max(0, value))))}};
}

export function hexToRgb(text) {
    const match = /^#?([0-9a-f]{6})$/i.exec(text.trim());
    return match ? [0, 2, 4].map(index => Number.parseInt(match[1].slice(index, index + 2), 16)) : null;
}

export function rgbToHex(rgb) {
    return Array.isArray(rgb) && rgb.length === 3
        ? `#${rgb.map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('')}`
        : '';
}

// Keep only the presentation optimistic; the authoritative state map stays intact.
function commandPatch(command) {
    const a = {};
    let state;
    if (['turn_on', 'turn_off'].includes(command.service))
        state = command.service === 'turn_on' ? 'on' : 'off';
    const data = command.service_data ?? {};
    if (Number.isFinite(data.brightness_pct))
        a.brightness = Math.round(data.brightness_pct * 255 / 100);
    if (Number.isFinite(data.percentage)) {
        a.percentage = data.percentage;
        state = data.percentage ? 'on' : 'off';
    }
    if (Number.isFinite(data.position))
        a.current_position = data.position;
    if (Number.isFinite(data.temperature))
        a.temperature = data.temperature;
    if (Number.isFinite(data.color_temp_kelvin))
        a.color_temp_kelvin = data.color_temp_kelvin;
    if (Array.isArray(data.rgb_color))
        a.rgb_color = data.rgb_color;
    return {state, attributes: a};
}

export function previewCommand(entity, command) {
    if (!entity || !command)
        return entity;
    const patch = commandPatch(command);
    const attributes = {...entity.attributes, ...patch.attributes};
    if (command.service_data?.color_temp_kelvin !== undefined)
        attributes.color_mode = 'color_temp';
    else if (command.service_data?.rgb_color)
        attributes.color_mode = 'rgb';
    return {...entity, state: patch.state ?? entity.state, attributes};
}

export function commandConfirmed(entity, command) {
    if (!entity)
        return false;
    const patch = commandPatch(command);
    if (patch.state !== undefined && entity.state !== patch.state)
        return false;
    return Object.entries(patch.attributes).every(([key, value]) => {
        const actual = entity.attributes?.[key];
        if (Array.isArray(value))
            return Array.isArray(actual) && value.every((part, index) => Math.abs(part - actual[index]) <= 4);
        const tolerance = key === 'brightness' ? 2 : key === 'color_temp_kelvin' ? 30 : 0.1;
        return Number.isFinite(actual) && Math.abs(actual - value) <= tolerance;
    });
}

export function sliderFor(entity) {
    const attributes = entity?.attributes ?? {};
    const domain = domainOf(entity?.entity_id);
    if (domain === 'light' && attributes.supported_color_modes?.some(mode =>
        !['onoff', 'unknown'].includes(mode))) {
        return {kind: 'brightness', value: (attributes.brightness ?? 0) / 255};
    }
    if (domain === 'fan' && (Number(attributes.supported_features) & 1))
        return {kind: 'speed', value: (attributes.percentage ?? 0) / 100};
    if (domain === 'cover' && (Number(attributes.supported_features) & 4))
        return {kind: 'position', value: (attributes.current_position ?? 0) / 100};
    return null;
}

export function toggleCommand(entityId, enabled) {
    const domain = domainOf(entityId);
    if (!['light', 'switch', 'input_boolean', 'fan'].includes(domain))
        throw new Error('unsupported-toggle');
    return {domain, service: enabled ? 'turn_on' : 'turn_off', target: {entity_id: entityId}};
}

export function sliderCommand(entityId, kind, value) {
    if (!Number.isFinite(value))
        throw new Error('invalid-value');
    const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
    const target = {entity_id: entityId};
    if (kind === 'brightness' && domainOf(entityId) === 'light')
        return {domain: 'light', service: percent ? 'turn_on' : 'turn_off', target,
            service_data: percent ? {brightness_pct: percent} : {}};
    if (kind === 'speed' && domainOf(entityId) === 'fan')
        return {domain: 'fan', service: 'set_percentage', target, service_data: {percentage: percent}};
    if (kind === 'position' && domainOf(entityId) === 'cover')
        return {domain: 'cover', service: 'set_cover_position', target, service_data: {position: percent}};
    throw new Error('unsupported-slider');
}

export function temperatureCommand(entity, direction) {
    const a = entity.attributes ?? {};
    if (!Number.isFinite(a.temperature))
        throw new Error('unsupported-temperature');
    const step = Number.isFinite(a.target_temp_step) && a.target_temp_step > 0 ? a.target_temp_step : 0.5;
    const min = Number.isFinite(a.min_temp) ? a.min_temp : -100;
    const max = Number.isFinite(a.max_temp) ? a.max_temp : 100;
    const temperature = Math.round(Math.min(max, Math.max(min, a.temperature + direction * step)) * 100) / 100;
    return {domain: 'climate', service: 'set_temperature',
        target: {entity_id: entity.entity_id}, service_data: {temperature}};
}

// Home Assistant subscribe_entities uses abbreviated states and incremental diffs.
// Subscribe first instead of get_states + subscribe_events to avoid a startup race.
export function applyEntityDiff(states, diff) {
    for (const id of diff.r ?? [])
        states.delete(id);
    for (const [id, value] of Object.entries(diff.a ?? {})) {
        states.set(id, {entity_id: id, state: value.s, attributes: {...value.a}});
    }
    for (const [id, delta] of Object.entries(diff.c ?? {})) {
        const previous = states.get(id);
        if (!previous)
            continue;
        const plus = delta['+'] ?? {};
        const attributes = {...previous.attributes, ...plus.a};
        for (const key of delta['-']?.a ?? [])
            delete attributes[key];
        states.set(id, {...previous, state: plus.s ?? previous.state, attributes});
    }
    return states;
}
