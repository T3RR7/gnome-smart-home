// SPDX-License-Identifier: MIT
// An in-process mock: tests never discover or command real household devices.
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

export const TEST_TOKEN = 'gnome-smart-home-test-token';

export function startFixture({onCall = () => {}} = {}) {
    const states = new Map([
        ['light.desk', {entity_id: 'light.desk', state: 'off', attributes: {friendly_name: 'Desk lamp', brightness: 128,
            supported_color_modes: ['color_temp', 'rgb'], color_mode: 'color_temp',
            min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6500, color_temp_kelvin: 3000, rgb_color: [255, 180, 90]}}],
        ['switch.kettle', {entity_id: 'switch.kettle', state: 'off', attributes: {friendly_name: 'Kettle'}}],
        ['fan.desk', {entity_id: 'fan.desk', state: 'on', attributes: {friendly_name: 'Fan', supported_features: 1, percentage: 50}}],
        ['cover.blind', {entity_id: 'cover.blind', state: 'open', attributes: {friendly_name: 'Blinds', supported_features: 15, current_position: 75}}],
        ['climate.room', {entity_id: 'climate.room', state: 'heat', attributes: {friendly_name: 'Room', temperature: 22, current_temperature: 21, temperature_unit: '°C', target_temp_step: 0.5, min_temp: 10, max_temp: 30, supported_features: 1}}],
        ['sensor.room', {entity_id: 'sensor.room', state: '21', attributes: {friendly_name: 'Temperature', unit_of_measurement: '°C'}}],
        ['scene.evening', {entity_id: 'scene.evening', state: '2026-11-18T00:00:00', attributes: {friendly_name: 'Evening'}}],
    ]);
    const sockets = new Set();
    const subscriptions = new Map();
    const calls = [];
    const server = new Soup.Server();
    let acceptServices = true;
    let serviceDelayMs = 0;
    const timers = new Set();
    let connectionCount = 0;
    function send(socket, message) {
        if (socket.state === Soup.WebsocketState.OPEN)
            socket.send_text(JSON.stringify(message));
    }
    function change(id, state, attributes = {}) {
        const entity = states.get(id);
        entity.state = state;
        Object.assign(entity.attributes, attributes);
        for (const socket of sockets) {
            const subscription = subscriptions.get(socket);
            if (subscription && (!subscription.ids || subscription.ids.includes(id)))
                send(socket, {type: 'event', id: subscription.id, event: {c: {[id]: {'+': {s: state, a: attributes}}}}});
        }
    }
    server.add_handler('/api/states', (_server, message) => {
        if (message.get_request_headers().get_one('Authorization') !== `Bearer ${TEST_TOKEN}`) {
            message.set_status(401, null);
            return;
        }
        message.set_status(200, null);
        message.set_response('application/json', Soup.MemoryUse.COPY,
            new TextEncoder().encode(JSON.stringify([...states.values()])));
    });
    server.add_websocket_handler('/api/websocket', null, null, (_server, _message, _path, socket) => {
        sockets.add(socket);
        connectionCount++;
        socket.connect('closed', () => { sockets.delete(socket); subscriptions.delete(socket); });
        socket.connect('message', (_socket, _type, bytes) => {
            const message = JSON.parse(new TextDecoder().decode(bytes.get_data()));
            if (message.type === 'auth') {
                if (message.access_token !== TEST_TOKEN)
                    send(socket, {type: 'auth_invalid', message: 'Invalid token'});
                else
                    send(socket, {type: 'auth_ok', ha_version: '2026.11.0'});
            } else if (message.type === 'subscribe_entities') {
                subscriptions.set(socket, {id: message.id, ids: message.entity_ids});
                send(socket, {id: message.id, type: 'result', success: true, result: null});
                const a = {};
                for (const entity of states.values()) {
                    if (!message.entity_ids || message.entity_ids.includes(entity.entity_id))
                        a[entity.entity_id] = {s: entity.state, a: entity.attributes};
                }
                send(socket, {id: message.id, type: 'event', event: {a}});
            } else if (message.type === 'call_service') {
                calls.push(message);
                onCall(message);
                const respond = () => {
                    if (acceptServices) {
                        const id = message.target.entity_id;
                        const entity = states.get(id);
                        const attributes = {};
                        const data = message.service_data ?? {};
                        let state = entity?.state;
                        if (message.service === 'turn_on')
                            state = 'on';
                        if (message.service === 'turn_off')
                            state = 'off';
                        if (Number.isFinite(data.brightness_pct))
                            attributes.brightness = Math.round(data.brightness_pct * 255 / 100);
                        if (Number.isFinite(data.color_temp_kelvin)) {
                            attributes.color_temp_kelvin = data.color_temp_kelvin;
                            attributes.color_mode = 'color_temp';
                        }
                        if (Array.isArray(data.rgb_color)) {
                            attributes.rgb_color = data.rgb_color;
                            attributes.color_mode = 'rgb';
                        }
                        if (message.service === 'set_percentage') {
                            attributes.percentage = data.percentage;
                            state = data.percentage > 0 ? 'on' : 'off';
                        }
                        if (message.service === 'open_cover' || message.service === 'close_cover') {
                            attributes.current_position = message.service === 'open_cover' ? 100 : 0;
                            state = attributes.current_position ? 'open' : 'closed';
                        }
                        if (message.service === 'set_cover_position') {
                            attributes.current_position = data.position;
                            state = data.position ? 'open' : 'closed';
                        }
                        if (message.service === 'set_temperature')
                            attributes.temperature = data.temperature;
                        if (message.domain === 'scene')
                            state = new Date().toISOString();
                        if (entity)
                            change(id, state, attributes);
                    }
                    send(socket, {id: message.id, type: 'result', success: acceptServices,
                        ...(acceptServices ? {result: {context: {id: 'test'}}} : {error: {code: 'service_not_found', message: 'Test rejection'}})});
                };
                if (serviceDelayMs) {
                    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, serviceDelayMs, () => {
                        timers.delete(timer);
                        respond();
                        return GLib.SOURCE_REMOVE;
                    });
                    timers.add(timer);
                } else {
                    respond();
                }
            } else if (message.type === 'ping') {
                send(socket, {id: message.id, type: 'pong'});
            }
        });
        send(socket, {type: 'auth_required', ha_version: '2026.11.0'});
    });
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    const url = server.get_uris()[0].to_string().replace(/\/$/, '');
    return {
        url, calls, states, change,
        get connectionCount() { return connectionCount; },
        set acceptServices(value) { acceptServices = value; },
        set serviceDelayMs(value) { serviceDelayMs = value; },
        dropConnections() {
            for (const socket of sockets)
                socket.close(Soup.WebsocketCloseCode.GOING_AWAY, 'Test reconnect');
        },
        stop() {
            for (const timer of timers)
                GLib.Source.remove(timer);
            timers.clear();
            for (const socket of sockets)
                socket.close(Soup.WebsocketCloseCode.NORMAL, null);
            server.disconnect();
        },
    };
}

export function waitUntil(condition, message = 'condition', timeout = 6000) {
    const start = GLib.get_monotonic_time();
    return new Promise((resolve, reject) => {
        const check = () => {
            if (condition()) {
                resolve();
                return GLib.SOURCE_REMOVE;
            }
            if ((GLib.get_monotonic_time() - start) / 1000 > timeout) {
                reject(new Error(`Timed out waiting for ${message}`));
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        };
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, check);
    });
}
