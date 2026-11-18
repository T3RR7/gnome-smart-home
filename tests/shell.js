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
    const colorTestPath = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('color-picker-smoke.js').get_path();
    const colorTest = launcher.spawnv(['gjs', '-m', colorTestPath]);
    await new Promise((resolve, reject) => {
        colorTest.wait_check_async(null, (process, result) => {
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
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x + width / 2, y + height / 2);
        global.stage.context.get_backend().get_default_seat().warp_pointer(Math.round(x + width / 2), Math.round(y + height / 2));
        await pause(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        await pause(30);
        pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
        await waitUntil(() => fixture.calls.length > callsBeforeClick && !lamp._pending, 'pointer click on the native switch handle');
        assert(fixture.calls.length === callsBeforeClick + 1, 'one mouse click sends exactly one service command');
        assert(!lamp._toggle.state && fixture.states.get('light.desk').state === 'off', 'mouse click changes both native and server state');
        print('PASS real pointer click toggles the native switch once');

        assert(lamp._temperatureRow.visible && lamp._paletteRow.visible, 'color and tunable-white controls are shown');
        lamp._swatches.find(({hex}) => hex === '#007aff').button.emit('clicked', 1);
        await waitUntil(() => fixture.states.get('light.desk').attributes.rgb_color[2] === 255 && !lamp._pending, 'palette RGB command');
        assert(fixture.calls.at(-1).service_data.rgb_color.join(',') === '0,122,255', 'palette sends the chosen RGB values');
        lamp._temperatureSlider.value = 1;
        lamp._flushTemperature();
        await waitUntil(() => fixture.states.get('light.desk').attributes.color_temp_kelvin === 6500 && !lamp._pending, 'white-temperature command');
        assert(fixture.calls.at(-1).service_data.color_temp_kelvin === 6500, 'temperature slider sends kelvin within device bounds');
        print('PASS color palette and white-temperature slider send and display real state updates');
        const originalPicker = lamp._pickColor;
        lamp._pickColor = async () => [12, 133, 212];
        await lamp._chooseColor();
        assert(fixture.calls.at(-1).service_data.rgb_color.join(',') === '12,133,212', 'full color chooser result is sent to the chosen light');
        lamp._pickColor = originalPicker;
        const beforeNativePicker = fixture.calls.length;
        const nativePick = lamp._chooseColor();
        let pickerWindow;
        let pickerChecks = 0;
        await waitUntil(() => {
            if (++pickerChecks === 50)
                print(`Color picker windows: ${global.get_window_actors().map(actor => actor.meta_window.get_wm_class()).join(', ')}`);
            pickerWindow = global.get_window_actors().map(actor => actor.meta_window)
                .find(window => window.get_wm_class() === 'org.gnome.SmartHome.ColorPicker');
            return Boolean(pickerWindow);
        }, 'native color picker process on the nested display', 15000);
        if (GLib.getenv('GSH_CAPTURE_TEST_UI') === '1') {
            await waitUntil(() => {
                const rect = pickerWindow.get_frame_rect();
                return rect.width > 100 && rect.height > 100 && pickerWindow.get_compositor_private()?.mapped;
            }, 'native color picker first frame');
            await pause(100);
            await Scripting.waitLeisure();
            const rect = pickerWindow.get_frame_rect();
            const artifact = Gio.File.new_for_uri(import.meta.url).get_parent().get_child('artifacts/color-picker.png');
            const stream = artifact.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            const shooter = new Shell.Screenshot();
            await new Promise((resolve, reject) => shooter.screenshot_area(rect.x, rect.y, rect.width, rect.height, stream,
                (source, result) => {
                    try { source.screenshot_area_finish(result); resolve(); } catch (error) { reject(error); }
                }));
            stream.close(null);
        }
        pickerWindow.delete(Clutter.get_current_event_time());
        await nativePick;
        assert(fixture.calls.length === beforeNativePicker && instance._colorProcess === null,
            'cancelling the real picker sends no device command and cleans up its process');
        Main.panel.statusArea.quickSettings.menu.open();
        instance._toggle.menu.open();
        await Scripting.waitLeisure();
        const [paletteX] = lamp._paletteRow.get_transformed_position();
        const [paletteWidth] = lamp._paletteRow.get_transformed_size();
        const [pickerX] = lamp._colorPickerButton.get_transformed_position();
        const [pickerWidth] = lamp._colorPickerButton.get_transformed_size();
        assert(pickerX + pickerWidth <= paletteX + paletteWidth + 1,
            'the full-color button fits inside the palette row');
        print('PASS real native picker opens inside the nested GNOME, cancels without commands, and fits the palette row');

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
        instance._colorProcess?.force_exit();
        await credentials.clearToken(fixture.url);
        fixture.stop();
    }
}
