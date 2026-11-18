// SPDX-License-Identifier: MIT
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {startFixture, TEST_TOKEN, waitUntil} from './fixture.js';

export const METRICS = {};

function assert(value, message) {
    if (!value)
        throw new Error(message);
}

function pause(milliseconds) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function clickAt(pointer, x, y) {
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    global.stage.context.get_backend().get_default_seat().warp_pointer(Math.round(x), Math.round(y));
    await pause(30);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await pause(30);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
}

// A light bulb is a single foreground shape. Shell used to paint its fill and
// stroke on opposite sides of the menu background's brightness.
async function checkLampIcon(icon) {
    const [x, y] = icon.get_transformed_position();
    const [width, height] = icon.get_transformed_size();
    const output = Gio.MemoryOutputStream.new_resizable();
    const shooter = new Shell.Screenshot();
    await new Promise((resolve, reject) => shooter.screenshot_area(
        Math.floor(x), Math.floor(y), Math.floor(width), Math.floor(height), output,
        (source, result) => {
            try { source.screenshot_area_finish(result); resolve(); } catch (error) { reject(error); }
        }));
    output.close(null);
    const input = Gio.MemoryInputStream.new_from_bytes(output.steal_as_bytes());
    const picture = GdkPixbuf.Pixbuf.new_from_stream(input, null);
    const pixels = picture.get_pixels();
    const background = pixels[0];
    let lightest = background;
    let darkest = background;
    for (let row = 0; row < picture.height; row++) {
        for (let column = 0; column < picture.width; column++) {
            const red = pixels[row * picture.rowstride + column * picture.n_channels];
            lightest = Math.max(lightest, red);
            darkest = Math.min(darkest, red);
        }
    }
    assert(Math.max(lightest - background, background - darkest) > 32, 'lamp icon is visible');
    assert(lightest <= background + 4 || darkest >= background - 4, 'lamp icon renders without a contrasting stroke');
}

export async function run() {
    await Scripting.waitLeisure();
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.setenv('GSETTINGS_BACKEND', 'memory', true);
    launcher.setenv('GDK_BACKEND', 'wayland', true);
    launcher.setenv('WAYLAND_DISPLAY', 'gnome-shell-test-display', true);
    launcher.unsetenv('DISPLAY');
    const prefsTestPath = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('prefs-smoke.js').get_path();
    const prefsTest = launcher.spawnv(['gjs', '-m', prefsTestPath]);
    await new Promise((resolve, reject) => {
        prefsTest.wait_check_async(null, (process, result) => {
            try { process.wait_check_finish(result); resolve(); } catch (error) { reject(error); }
        });
    });
    const extension = Main.extensionManager.lookup('gnome-smart-home@local');
    assert(extension && !extension.error, `Extension load failed: ${extension?.error}`);
    const instance = extension.stateObj;
    assert(instance?._toggle, 'Quick Settings tile created');
    assert(instance._status === 'unconfigured', 'empty connection is handled');
    print('PASS extension loads and adds a native Quick Settings tile');

    const fixture = startFixture();
    const credentials = await import(GLib.filename_to_uri(`${extension.path}/lib/credentials.js`, null));
    try {
        await credentials.storeToken(fixture.url, TEST_TOKEN);
        assert(await credentials.lookupToken(fixture.url) === TEST_TOKEN, 'GNOME keyring round trip');
        const settings = instance._settings;
        settings.set_string('devices', JSON.stringify([...fixture.states.keys()].map(id => ({id, name: id === 'light.desk' ? 'My desk' : ''}))));
        settings.set_string('server-url', fixture.url);
        await waitUntil(() => instance._status === 'connected' && instance._states.size === 7, 'extension to connect');
        assert(instance._controls.length === 7, 'all configured devices rendered');
        const lamp = instance._controls.find(control => control.favorite.id === 'light.desk');
        assert(lamp._toggle.label.text === 'My desk', 'custom device name');
        assert(lamp._sliderRow.visible, 'brightness slider shown for capable light');
        await waitUntil(() => lamp._deviceIcon.gicon.to_string().includes('lightbulb-modern-symbolic'),
            'lights use the upstream GNOME light bulb');
        const sensor = instance._controls.find(control => control.favorite.id === 'sensor.room');
        await waitUntil(() => sensor._deviceIcon.gicon.to_string().includes('chip-symbolic'),
            'sensors have a distinct sensor icon');
        const cover = instance._controls.find(control => control.favorite.id === 'cover.blind');
        assert(cover._coverButtons.every(({button}) => button.visible), 'cover feature buttons');
        const climate = instance._controls.find(control => control.favorite.id === 'climate.room');
        assert(climate._buttonsRow.visible, 'thermostat controls');
        print('PASS keyring, connection, selected controls, capability checks, custom names');

        Main.overview.hide();
        Main.panel.statusArea.quickSettings.menu.open();
        instance._toggle.menu.open();
        await Scripting.waitLeisure();
        assert(instance._toggle.menu.isOpen, 'device menu opens');
        await checkLampIcon(lamp._deviceIcon);
        const [, rowY] = lamp._temperatureRow.get_transformed_position();
        const [, rowHeight] = lamp._temperatureRow.get_transformed_size();
        for (const child of [lamp._temperatureSlider, lamp._kelvin]) {
            const [, childY] = child.get_transformed_position();
            const [, childHeight] = child.get_transformed_size();
            assert(Math.abs(childY + childHeight / 2 - rowY - rowHeight / 2) <= 1.5,
                'temperature slider and label are centered inside the highlighted row');
        }
        lamp._toggle.toggle();
        await waitUntil(() => fixture.calls.length === 1 && lamp._toggle.state, 'native switch action');
        assert(fixture.calls[0].service === 'turn_on', 'switch sends explicit turn_on');
        fixture.change('light.desk', 'off', {brightness: 0});
        await waitUntil(() => !lamp._toggle.state, 'external state updates native switch');
        assert(fixture.calls.length === 1, 'programmatic switch update does not call services');
        print('PASS menu rendering, switch command, live updates without feedback loops');

        fixture.serviceDelayMs = 400;
        lamp._toggle.activate();
        assert(lamp._toggle.state, 'a user toggle must not immediately revert to the stale server state');
        assert(lamp._toggle._statusBin.child === lamp._toggle._switch,
            'pending request must keep the native switch in the row');
        await waitUntil(() => !lamp._pending && fixture.states.get('light.desk').state === 'on', 'delayed toggle confirmation');
        assert(lamp._toggle.state, 'confirmed switch stays on');
        fixture.serviceDelayMs = 0;
        print('PASS delayed device command keeps switch state and stable row layout');

        const pointer = global.stage.context.get_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const handle = lamp._toggle._switch._handle;
        const [x, y] = handle.get_transformed_position();
        const [width, height] = handle.get_transformed_size();
        if (GLib.getenv('GSH_CAPTURE_TEST_UI') === '1') {
            const artifactRoot = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('artifacts');
            GLib.mkdir_with_parents(artifactRoot.get_path(), 0o755);
            const stream = artifactRoot.get_child('ui-controls.png').replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            const shooter = new Shell.Screenshot();
            const [menuX, menuY] = instance._toggle.menu.actor.get_transformed_position();
            const [menuWidth, menuHeight] = instance._toggle.menu.actor.get_transformed_size();
            assert(menuY + menuHeight <= Main.layoutManager.primaryMonitor.height, 'expanded device menu fits the virtual monitor');
            await new Promise((resolve, reject) => shooter.screenshot_area(
                Math.floor(menuX), Math.floor(menuY), Math.floor(menuWidth), Math.floor(menuHeight), stream,
                (source, result) => {
                    try { source.screenshot_area_finish(result); resolve(); } catch (error) { reject(error); }
                }));
            stream.close(null);
        }
        const callsBeforeClick = fixture.calls.length;
        await clickAt(pointer, x + width / 2, y + height / 2);
        await waitUntil(() => fixture.calls.length > callsBeforeClick && !lamp._pending, 'pointer click on the native switch handle');
        assert(fixture.calls.length === callsBeforeClick + 1, 'one mouse click sends exactly one service command');
        assert(!lamp._toggle.state && fixture.states.get('light.desk').state === 'off', 'mouse click changes both native and server state');
        print('PASS real pointer click toggles the native switch once');

        assert(lamp._sliderRow.visible && lamp._temperatureRow.visible && !lamp._colorRow.visible,
            'brightness and temperature show above the initially collapsed color wheel');
        assert(lamp._temperatureSlider.width >= lamp._slider.width * 0.75,
            'temperature slider retains its width when the chevron is added');
        lamp._temperatureSlider.value = 1;
        lamp._flushTemperature();
        await waitUntil(() => fixture.states.get('light.desk').attributes.color_temp_kelvin === 6500 && !lamp._pending, 'white-temperature command');
        assert(fixture.calls.at(-1).service_data.color_temp_kelvin === 6500, 'temperature slider sends kelvin within device bounds');

        const beforeOpen = fixture.calls.length;
        const [arrowX, arrowY] = lamp._colorToggle.get_transformed_position();
        const [arrowWidth, arrowHeight] = lamp._colorToggle.get_transformed_size();
        await clickAt(pointer, arrowX + arrowWidth / 2, arrowY + arrowHeight / 2);
        await waitUntil(() => lamp._colorRow.mapped, 'color dropdown opens from the temperature row');
        await Scripting.waitLeisure();
        assert(instance._toggle.menu.isOpen && fixture.calls.length === beforeOpen, 'opening the dropdown keeps Quick Settings open and sends no command');
        const [pickerX, pickerY] = lamp._colorRow.get_transformed_position();
        const [, temperatureY] = lamp._temperatureRow.get_transformed_position();
        const [, brightnessY] = lamp._sliderRow.get_transformed_position();
        assert(brightnessY < temperatureY && temperatureY < pickerY, 'picker follows the unchanged brightness and temperature rows');
        const wheel = lamp._colorPicker._wheel;
        const [wheelX, wheelY] = wheel.get_transformed_position();
        const [wheelWidth, wheelHeight] = wheel.get_transformed_size();
        const [pickerWidth] = lamp._colorRow.get_transformed_size();
        assert(wheelX >= pickerX && wheelX + wheelWidth <= pickerX + pickerWidth + 1, 'wheel fits inside the dropdown');

        const {brightness} = fixture.states.get('light.desk').attributes;
        await clickAt(pointer, wheelX + wheelWidth * 0.78, wheelY + wheelHeight / 2);
        await waitUntil(() => fixture.calls.length === beforeOpen + 1 && !lamp._pending, 'wheel sends one RGB command');
        const data = fixture.calls.at(-1).service_data;
        const [red, green, blue] = data.rgb_color;
        assert(red === 255 && green > 80 && green < 135 && Math.abs(green - blue) < 8, 'wheel position selects a red hue with proportional saturation');
        assert(Object.keys(data).join(',') === 'rgb_color', 'selecting a color sends only RGB');
        assert(fixture.states.get('light.desk').attributes.brightness === brightness &&
            fixture.states.get('light.desk').attributes.color_temp_kelvin === 6500, 'RGB selection leaves brightness and kelvin untouched');

        const entry = lamp._colorPicker._entry;
        entry.text = 'invalid';
        entry.clutter_text.emit('activate');
        assert(entry.has_style_pseudo_class('error') && fixture.calls.length === beforeOpen + 1, 'invalid hex is marked without a device command');
        entry.text = '#0C85D4';
        entry.clutter_text.emit('activate');
        await waitUntil(() => fixture.calls.length === beforeOpen + 2 && !lamp._pending, 'hex color command');
        assert(fixture.calls.at(-1).service_data.rgb_color.join(',') === '12,133,212' &&
            entry.text === '#0c85d4' && lamp._colorPicker._hex === '#0c85d4', 'hex input keeps the exact selected RGB in the wheel');
        assert(instance._toggle.menu.isOpen, 'choosing a color keeps Quick Settings open');
        instance._toggle.menu.close();
        assert(!lamp._colorRow.visible && !lamp._colorToggle.checked, 'closing the menu collapses the color dropdown');
        instance._toggle.menu.open();
        await Scripting.waitLeisure();
        print('PASS inline color dropdown, pointer selection, exact hex input and unchanged sliders');

        fixture.change('light.desk', 'on', {supported_color_modes: ['rgb']});
        await waitUntil(() => !lamp._temperatureSlider.visible && lamp._colorToggle.reactive, 'RGB-only light has a color row');
        fixture.change('light.desk', 'on', {supported_color_modes: ['color_temp']});
        await waitUntil(() => lamp._temperatureSlider.visible && !lamp._colorToggle.reactive, 'white-only light has no color dropdown');
        fixture.change('light.desk', 'on', {supported_color_modes: ['color_temp', 'rgb']});
        await waitUntil(() => lamp._temperatureSlider.visible && lamp._colorToggle.reactive, 'restore tunable color light');

        fixture.serviceDelayMs = 200;
        const beforeQueue = fixture.calls.length;
        lamp._slider.value = 0.6;
        lamp._flushSlider();
        lamp._slider.value = 0.8;
        lamp._flushSlider();
        assert(Math.abs(lamp._slider.value - 0.8) < 0.01, 'latest slider choice remains visible while a request is pending');
        await waitUntil(() => !lamp._pending && fixture.calls.length === beforeQueue + 2 &&
            fixture.states.get('light.desk').attributes.brightness === 204, 'queued slider choice');
        fixture.serviceDelayMs = 0;
        fixture.acceptServices = false;
        lamp._toggle.activate();
        assert(!lamp._toggle.state, 'failed command starts with the requested switch state');
        await waitUntil(() => !lamp._pending, 'failed command response');
        assert(lamp._toggle.state && lamp._toggle._statusBin.child === lamp._toggle._switch,
            'failed action restores confirmed state without replacing the switch');
        fixture.acceptServices = true;
        print('PASS latest slider change is queued and failed commands restore confirmed state');

        settings.set_uint('tile-position', 1);
        const grid = instance._toggle.get_parent();
        const beforeTile = grid.get_children().slice(0, grid.get_children().indexOf(instance._toggle));
        assert(!beforeTile.some(child => child.visible && child instanceof QuickSettings.QuickSettingsItem), 'tile position setting moves Smart Home to the beginning');
        settings.set_string('tile-icon', 'starred-symbolic');
        await waitUntil(() => instance._toggle.gicon?.to_string().includes('starred-symbolic'),
            'stock symbolic tile icon is applied');
        settings.set_uint('tile-position', 0);

        settings.set_boolean('show-sliders', false);
        assert(!instance._controls[0]._slider, 'sliders can be hidden');
        settings.set_boolean('show-indicator', true);
        assert(instance._panelIcon.visible, 'panel icon setting');
        Main.panel.statusArea.quickSettings.menu.close();
        instance.disable();
        assert(instance._indicator === null && instance._client === null, 'disable removes UI and networking');
        instance.enable();
        await waitUntil(() => instance._status === 'connected', 're-enable');
        assert(instance._controls.length === 7, 'favorites survive re-enable');
        instance.disable();
        print('PASS appearance settings, disable cleanup and re-enable');
    } finally {
        await credentials.clearToken(fixture.url);
        fixture.stop();
    }
}
