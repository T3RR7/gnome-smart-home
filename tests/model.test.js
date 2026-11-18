// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    applyEntityDiff, entityName, isAvailable, isOn, normalizeUrl, parseDevices,
    sliderCommand, sliderFor, temperatureCommand, toggleCommand, websocketUrl,
    colorCommand, colorTemperatureCommand, commandConfirmed, lightCapabilities,
    hexToRgb, previewCommand, rgbToHex,
    iconFor,
} from '../lib/model.js';

test('server URLs support HTTPS, IPv6 and reverse-proxy subpaths', () => {
    assert.equal(normalizeUrl(' https://ha.example/home/ '), 'https://ha.example/home');
    assert.equal(websocketUrl('https://[::1]:8123/ha/'), 'wss://[::1]:8123/ha/api/websocket');
    assert.equal(websocketUrl('http://homeassistant.local:8123'), 'ws://homeassistant.local:8123/api/websocket');
    for (const url of ['ftp://host', 'https://user:secret@host', 'https://host?key=secret', 'https://host/#view', '', 'http://a\\b', 'http://a b'])
        assert.throws(() => normalizeUrl(url));
});

test('favorite configuration preserves order, removes duplicates and rejects unsupported controls', () => {
    assert.deepEqual(parseDevices(JSON.stringify([
        {id: 'switch.kettle', name: ' Kettle '}, {id: 'light.desk'},
        {id: 'switch.kettle', name: 'Duplicate'}, {id: 'lock.door'},
        {id: 'light.bad/value'}, null, {id: 42},
    ])), [{id: 'switch.kettle', name: 'Kettle'}, {id: 'light.desk', name: ''}]);
    for (const invalid of ['null', '{broken', '{}'])
        assert.deepEqual(parseDevices(invalid), []);
});

test('unknown and missing states are unavailable, real false states remain available', () => {
    assert.equal(isAvailable(null), false);
    assert.equal(isAvailable({state: 'unavailable'}), false);
    assert.equal(isAvailable({state: 'unknown'}), false);
    assert.equal(isAvailable({state: 'off'}), true);
    assert.equal(isAvailable({state: '0'}), true);
    assert.equal(isOn({entity_id: 'cover.blind', state: 'opening'}), true);
    assert.equal(isOn({entity_id: 'climate.room', state: 'heat'}), true);
    assert.equal(isOn({entity_id: 'climate.room', state: 'off'}), false);
});

test('custom names override Home Assistant names with useful offline fallback', () => {
    assert.equal(entityName({attributes: {friendly_name: 'HA lamp'}}, {id: 'light.desk', name: 'Desk'}), 'Desk');
    assert.equal(entityName({attributes: {friendly_name: 'HA lamp'}}, {id: 'light.desk', name: ''}), 'HA lamp');
    assert.equal(entityName(null, {id: 'light.desk'}), 'light.desk');
});

test('entity snapshot and deltas merge attributes and remove stale ones', () => {
    const states = new Map();
    applyEntityDiff(states, {a: {
        'light.desk': {s: 'off', a: {friendly_name: 'Desk', brightness: 80, old: true}},
        'sensor.room': {s: '20', a: {unit_of_measurement: '°C'}},
    }});
    applyEntityDiff(states, {c: {'light.desk': {'+': {s: 'on', a: {brightness: 128}}, '-': {a: ['old']}}}, r: ['sensor.room']});
    assert.deepEqual(states.get('light.desk'), {
        entity_id: 'light.desk', state: 'on', attributes: {friendly_name: 'Desk', brightness: 128},
    });
    assert.equal(states.has('sensor.room'), false);
    applyEntityDiff(states, {c: {'light.desk': {'+': {a: {brightness: 0}}}, 'sensor.missing': {'+': {s: '5'}}}});
    assert.equal(states.get('light.desk').state, 'on');
    assert.equal(states.get('light.desk').attributes.brightness, 0);
    assert.equal(states.has('sensor.missing'), false);
});

test('entity replacement drops previous attributes and handles removals', () => {
    const states = new Map([['light.desk', {state: 'on', attributes: {old: true}}]]);
    applyEntityDiff(states, {a: {'light.desk': {s: 'off', a: {friendly_name: 'New'}}}});
    assert.deepEqual(states.get('light.desk').attributes, {friendly_name: 'New'});
    applyEntityDiff(states, {r: ['light.desk']});
    assert.equal(states.size, 0);
});

test('toggle commands use explicit turn_on/off and target only the selected entity', () => {
    assert.deepEqual(toggleCommand('switch.kettle', true), {
        domain: 'switch', service: 'turn_on', target: {entity_id: 'switch.kettle'},
    });
    assert.equal(toggleCommand('light.desk', false).service, 'turn_off');
    assert.throws(() => toggleCommand('lock.front', true));
});

test('sliders appear only when the integration advertises the matching capability', () => {
    assert.equal(sliderFor({entity_id: 'light.simple', attributes: {supported_color_modes: ['onoff']}}), null);
    assert.deepEqual(sliderFor({entity_id: 'light.desk', attributes: {supported_color_modes: ['brightness'], brightness: 255}}), {kind: 'brightness', value: 1});
    assert.deepEqual(sliderFor({entity_id: 'fan.desk', attributes: {supported_features: 1, percentage: 60}}), {kind: 'speed', value: 0.6});
    assert.deepEqual(sliderFor({entity_id: 'cover.blind', attributes: {supported_features: 4, current_position: 40}}), {kind: 'position', value: 0.4});
    assert.equal(sliderFor({entity_id: 'cover.simple', attributes: {supported_features: 3}}), null);
});

test('slider payloads clamp values, turn lights off at zero and reject nonfinite input', () => {
    assert.deepEqual(sliderCommand('light.desk', 'brightness', 0.54).service_data, {brightness_pct: 54});
    assert.equal(sliderCommand('light.desk', 'brightness', 0).service, 'turn_off');
    assert.deepEqual(sliderCommand('cover.blind', 'position', 2).service_data, {position: 100});
    assert.deepEqual(sliderCommand('fan.desk', 'speed', -1).service_data, {percentage: 0});
    assert.throws(() => sliderCommand('light.desk', 'brightness', NaN));
    assert.throws(() => sliderCommand('switch.kettle', 'brightness', 0.5));
});

test('thermostat respects advertised step, min/max, and does not enable an HVAC mode', () => {
    const entity = {entity_id: 'climate.room', attributes: {temperature: 24, target_temp_step: 1, min_temp: 16, max_temp: 24}};
    assert.deepEqual(temperatureCommand(entity, 1), {
        domain: 'climate', service: 'set_temperature', target: {entity_id: 'climate.room'}, service_data: {temperature: 24},
    });
    assert.equal(temperatureCommand(entity, -1).service_data.temperature, 23);
    assert.throws(() => temperatureCommand({entity_id: 'climate.range', attributes: {target_temp_low: 18, target_temp_high: 22}}, 1));
});

test('symbolic icon choices survive favorite parsing and reordering', () => {
    const devices = parseDevices('[{"id":"light.desk","name":"Desk","icon":"night-light-symbolic"},{"id":"switch.kettle","icon":"file:///tmp/custom-symbolic.svg"}]');
    assert.equal(devices[0].icon, 'night-light-symbolic');
    assert.equal(devices[1].icon, 'file:///tmp/custom-symbolic.svg');
});

test('light color capabilities distinguish dimming, tunable white, RGB, and RGBWW', () => {
    const light = modes => ({entity_id: 'light.desk', attributes: {supported_color_modes: modes, min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6000}});
    assert.deepEqual(lightCapabilities(light(['brightness'])), {color: false, temperature: null});
    assert.equal(lightCapabilities(light(['color_temp'])).color, false);
    assert.equal(lightCapabilities(light(['color_temp'])).temperature.min, 2200);
    assert.equal(lightCapabilities(light(['xy'])).temperature, null);
    assert.equal(lightCapabilities(light(['hs'])).color, true);
    assert.equal(lightCapabilities(light(['rgbww'])).temperature.max, 6000);
    assert.equal(lightCapabilities(light(['rgbw'])).temperature, null);
});

test('white temperature uses supported kelvin limits and RGB uses the modern service payload', () => {
    const entity = {entity_id: 'light.desk', attributes: {supported_color_modes: ['rgb', 'color_temp'], min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6000}};
    assert.deepEqual(colorTemperatureCommand(entity, 10000), {domain: 'light', service: 'turn_on', target: {entity_id: 'light.desk'}, service_data: {color_temp_kelvin: 6000}});
    assert.equal(colorTemperatureCommand(entity, 1000).service_data.color_temp_kelvin, 2200);
    assert.deepEqual(colorCommand(entity, [255, 0, 128]).service_data, {rgb_color: [255, 0, 128]});
    assert.throws(() => colorCommand({entity_id: 'switch.kettle'}, [255, 0, 0]));
    assert.throws(() => colorTemperatureCommand(entity, NaN));
    assert.deepEqual(hexToRgb('#12AbFF'), [18, 171, 255]);
    assert.equal(hexToRgb('#xyz123'), null);
    assert.equal(rgbToHex([18, 171, 255]), '#12abff');
});

test('pending commands affect the presentation without changing authoritative state', () => {
    const entity = {entity_id: 'light.desk', state: 'off', attributes: {brightness: 128}};
    const command = toggleCommand('light.desk', true);
    assert.equal(previewCommand(entity, command).state, 'on');
    assert.equal(entity.state, 'off');
    assert.equal(commandConfirmed(entity, command), false);
    assert.equal(commandConfirmed({...entity, state: 'on'}, command), true);
    const brightness = sliderCommand('light.desk', 'brightness', 0.8);
    assert.equal(previewCommand(entity, brightness).attributes.brightness, 204);
    assert.equal(commandConfirmed({...entity, state: 'on', attributes: {brightness: 205}}, brightness), true);
});

test('device types use distinct and relevant upstream GNOME icons', () => {
    assert.equal(iconFor('light.desk'), 'lightbulb-modern-symbolic');
    assert.equal(iconFor('switch.kettle'), 'switch-left-symbolic');
    assert.equal(iconFor({entity_id: 'switch.kettle', attributes: {device_class: 'outlet'}}), 'plug-symbolic');
    assert.equal(iconFor('sensor.temperature'), 'chip-symbolic');
    assert.equal(iconFor('binary_sensor.door'), 'chip-symbolic');
    assert.notEqual(iconFor('sensor.temperature'), iconFor('light.desk'));
});
