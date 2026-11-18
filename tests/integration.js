import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import {HomeAssistantClient, discoverEntities, validateUrl} from '../lib/client.js';
import {sliderCommand, toggleCommand} from '../lib/model.js';
import {startFixture, TEST_TOKEN, waitUntil} from './fixture.js';

function assert(value, message) {
    if (!value)
        throw new Error(message);
}

async function run() {
    const fixture = startFixture();
    const clients = [];
    try {
        assert(validateUrl('http://[::1]:8123/home/') === 'http://[::1]:8123/home', 'IPv6 reverse proxy URL');
        const entities = await discoverEntities(fixture.url, TEST_TOKEN, new Gio.Cancellable());
        assert(entities.length === 7, 'REST discovery returns real parsed entities');
        let rejected = false;
        try {
            await discoverEntities(fixture.url, 'wrong', new Gio.Cancellable());
        } catch (error) {
            rejected = error.code === 'auth';
        }
        assert(rejected, 'REST rejects invalid tokens');
        print('PASS REST discovery and authentication');

        let status;
        let updates = 0;
        const client = new HomeAssistantClient({
            url: fixture.url, token: TEST_TOKEN, entityIds: ['light.desk', 'sensor.room'],
            onStatus: value => { status = value; }, onStates: () => updates++,
        });
        clients.push(client);
        client.start();
        await waitUntil(() => status === 'connected' && updates > 0, 'initial snapshot');
        assert(client.states.size === 2, 'subscription filters entities');
        assert(client.states.get('light.desk').state === 'off', 'initial light state');
        await client.callService(toggleCommand('light.desk', true));
        await waitUntil(() => client.states.get('light.desk').state === 'on', 'push state after command');
        assert(fixture.calls[0].target.entity_id === 'light.desk', 'service targets exactly the chosen light');
        await client.callService(sliderCommand('light.desk', 'brightness', 0.8));
        assert(fixture.calls[1].service_data.brightness_pct === 80, 'native client sends brightness');
        fixture.change('sensor.room', '23', {});
        await waitUntil(() => client.states.get('sensor.room').state === '23', 'external state change');
        print('PASS WebSocket authentication, snapshot, filtering, service calls, push updates');

        fixture.acceptServices = false;
        rejected = false;
        try {
            await client.callService(toggleCommand('light.desk', false));
        } catch (error) {
            rejected = error.code === 'service';
        }
        assert(rejected, 'failed service rejects the command');
        assert(client.states.get('light.desk').state === 'on', 'failed action does not fake device state');
        fixture.acceptServices = true;
        print('PASS failed service preserves server state');

        const before = fixture.connectionCount;
        fixture.dropConnections();
        await waitUntil(() => status === 'connected' && fixture.connectionCount > before, 'automatic reconnect');
        await waitUntil(() => client.states.get('sensor.room')?.state === '23', 'fresh reconnect snapshot');
        print('PASS automatic reconnect and full resubscription');

        let badStatus;
        const bad = new HomeAssistantClient({url: fixture.url, token: 'wrong', onStatus: value => { badStatus = value; }});
        clients.push(bad);
        bad.start();
        await waitUntil(() => badStatus === 'auth-error', 'invalid WebSocket credentials');
        assert(bad._sources.size === 0, 'bad credentials do not trigger endless retries');
        print('PASS invalid token stops reconnect retries');

        const pending = client._request({type: 'intentionally_unanswered'}).then(() => false, error => error.code === 'offline');
        client.stop();
        assert(await pending, 'disable rejects pending network operations');
        assert(client._sources.size === 0 && client._pending.size === 0, 'disable removes all timers and requests');
        assert(client._token === null, 'disable releases token');
        print('PASS disable cleanup and pending request cancellation');
    } finally {
        for (const client of clients)
            client.stop();
        fixture.stop();
    }
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
run().catch(error => { logError(error); exitCode = 1; }).finally(() => loop.quit());
loop.run();
System.exit(exitCode);
