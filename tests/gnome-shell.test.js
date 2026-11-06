// Run only with scripts/check_gnome_shell.py: it supplies private state and a
// generated-input helper. No real input devices or administrator dialogs are used.
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

export const METRICS = {};

function check(condition, message) {
    if (!condition) throw new Error(message);
}

export async function run() {
    const result = GLib.getenv('WORK_HABBITS_TEST_RESULT');
    const ready = GLib.getenv('WORK_HABBITS_TEST_INPUT_STATE');
    check(result && ready, 'Use the isolated GNOME test launcher');
    await Scripting.sleep(1000);
    const extension = Main.extensionManager.lookup('work-habbits@local');
    check(extension?.stateObj, 'The extension must load in the real Shell');
    const app = extension.stateObj;
    let active = true;
    app._session = {Name: GLib.get_user_name(), Type: 'wayland', Class: 'user', Remote: false, Active: true};
    app._localSession = () => active;
    app._settings.set_boolean('sound-enabled', false);
    app._nextReaderAttempt = 0;
    app._tick();
    await Scripting.sleep(1500);
    app._tick();
    check(app._reader, `Input helper must start: ${app._inputError}`);
    check(app._inputSetupButton.visible, 'Missing permission must show the setup action');
    app._offerInputSetup();
    check(app._inputSetupDialog, 'The native permission explanation must open');
    app._inputSetupDialog.close();
    check(!app._inputSetupProcess, 'Closing the explanation must not request root authorization');

    GLib.file_set_contents(ready, 'ready');
    await Scripting.sleep(1500);
    app._tick();
    check(app._eventsAvailable && app._model.keys > 0, `Generated input must reach the model: ${app._inputError}`);
    check(!app._inputSetupButton.visible, 'Successful input must hide the setup action');

    // Exercise the same status-file path as the Bluetooth helper, using private
    // generated data. No Bluetooth connection or desk movement is requested.
    const device = '00:00:00:00:00:01';
    app._settings.set_string('desk-device', device);
    app._settings.set_string('desk-mode', 'bluetooth');
    GLib.mkdir_with_parents(app._runtimeDir, 0o700);
    GLib.file_set_contents(`${app._runtimeDir}/desk.json`, JSON.stringify({
        device, connected: true, heartbeat: Date.now() / 1000, height_cm: 112,
    }));
    app._tick();
    check(app._deskReady && app._position === 'standing', 'Fresh Bluetooth status must update posture');
    check(app._height.text === 'Desk: 112 cm', 'Bluetooth height must reach the native menu');
    check(app._deskButton.visible && app._deskButton.label.startsWith('Lower desk'),
        'A connected standing desk must expose its control');

    app._settings.set_string('desk-mode', 'manual');
    app._tick();
    app._deskAction();
    check(app._position === 'standing', 'Manual posture selection must still work');

    active = false;
    app._tick();
    check(!app._reader && !app._eventsAvailable, 'An inactive session must stop the reader');
    active = true;
    app._nextReaderAttempt = 0;
    app._tick();
    await Scripting.sleep(500);
    check(app._eventsAvailable, 'Returning to the local session must resume input');
    app._settings.set_boolean('tracking-enabled', false);
    app._tick();
    check(!app._reader && !app._eventsAvailable, 'Pausing tracking must stop collection');
    GLib.file_set_contents(result, JSON.stringify({passed: true, generatedKeys: app._model.keys}));
    app.disable();
}
