import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SourceTextModule, SyntheticModule} from 'node:vm';
import {WellnessModel, SETTINGS} from '../extension/logic.js';
import {DailyHistory} from '../extension/history.js';
import {ChimeSchedule} from '../extension/sound-options.js';

// GNOME actors and drawing are external I/O. Run the real extension UI methods
// against a small actor tree without changing the desktop or needing a display.
class Actor {
    static list_properties() { return process.env.WORK_HABBITS_TEST_ORIENTATION ? [{name: 'orientation'}] : []; }
    constructor(props = {}) { this._init(props); }
    _init(props = {}) {
        Object.assign(this, {children: [], layout_manager: {}, visible: true}, props);
    }
    connect(signal, callback) { (this.signals ??= {})[signal] = callback; }
    destroy() { this.destroyed = true; this.signals?.destroy?.(); }
    add_child(child) { this.children.push(child); }
    set_style(style) { this.style = style; }
    setToggleState(value) { this.state = value; }
    queue_repaint() { this._draw(); }
    get_surface_size() { return [200, this.style_class === 'wh-score' ? 18 : 12]; }
    get_theme_node() { return {get_foreground_color: () => process.env.WORK_HABBITS_TEST_ORIENTATION
        ? {get_red: () => 1, get_green: () => 1, get_blue: () => 1} : {red: 255, green: 255, blue: 255}}; }
    get_context() {
        this.drawnColors = [];
        return new Proxy({}, {get: (_target, method) => (...args) => {
            if (method === 'setSourceRGBA') this.drawnColors.push(args);
        }});
    }
}
class MenuItem extends Actor {
    constructor(text, props = {}) { super(props); this.label = new Actor({text}); }
}
class SetupDialog extends Actor {
    constructor() { super(); this.contentLayout = new Actor(); }
    setButtons(buttons) { this.buttons = buttons; }
    open() { this.opened = true; return true; }
    close() { this.destroy(); }
}
const notified = [];
const registered = new Set(['Meter', 'ScoreBar', 'ExampleExtensionMeter', 'ExampleExtensionScoreBar']);
const modules = new Map();
const dependencies = {
    'cairo': {LinearGradient: class { addColorStopRGBA() {} }},
    'gi://GObject': {registerClass: ({GTypeName}, Widget) => {
        assert.match(GTypeName, /^WorkHabbits/, 'Widget types belong to this extension');
        assert.equal(registered.has(GTypeName), false, `GType collision: ${GTypeName}`);
        registered.add(GTypeName);
        return Widget;
    }},
    'gi://Clutter': {ActorAlign: {END: 1, CENTER: 2, START: 3}, Orientation: {VERTICAL: 1}, GridLayout: class {
        constructor() { this.cells = []; }
        attach(...cell) { this.cells.push(cell); }
    }},
    'gi://St': {BoxLayout: Actor, Label: Actor, Icon: Actor, Widget: Actor, Button: Actor, DrawingArea: Actor},
    'gi://GLib': {get_user_name: () => 'tester', get_monotonic_time: () => 0,
        build_filenamev: parts => parts.join('/'),
        DateTime: {new_now_local: () => ({format: () => '2026-10-29'})},
        timeout_add: () => 1, Source: {remove() {}}, PRIORITY_DEFAULT: 0,
        find_program_in_path: () => null},
    'gi://Gio': {Subprocess: {new() { throw new Error('Unexpected subprocess'); }},
        SubprocessFlags: {STDOUT_PIPE: 1, STDERR_SILENCE: 2, STDOUT_SILENCE: 4}},
    'gi://Meta': {is_wayland_compositor: () => true},
    'resource:///org/gnome/shell/ui/main.js': {notify: (...args) => notified.push(args)},
    'resource:///org/gnome/shell/ui/dialog.js': {MessageDialogContent: Actor},
    'resource:///org/gnome/shell/ui/modalDialog.js': {ModalDialog: SetupDialog},
    'resource:///org/gnome/shell/misc/loginManager.js': {},
    'resource:///org/gnome/shell/ui/panelMenu.js': {},
    'resource:///org/gnome/shell/ui/popupMenu.js': {PopupMenuItem: MenuItem,
        PopupSeparatorMenuItem: MenuItem, PopupSwitchMenuItem: MenuItem},
    'resource:///org/gnome/shell/extensions/extension.js': {Extension: class {}},
};
function moduleAt(identifier) {
    if (modules.has(identifier)) return modules.get(identifier);
    let module;
    if (identifier in dependencies) {
        const value = dependencies[identifier];
        const exports = identifier.startsWith('resource:') ? value : {default: value};
        module = new SyntheticModule(Object.keys(exports), function () {
            for (const [name, item] of Object.entries(exports)) this.setExport(name, item);
        }, {identifier});
    } else {
        module = new SourceTextModule(readFileSync(new URL(identifier), 'utf8'), {identifier});
    }
    modules.set(identifier, module);
    return module;
}
const extension = moduleAt(new URL('../extension/extension.js', import.meta.url).href);
await extension.link((specifier, parent) => moduleAt(specifier in dependencies
    ? specifier : new URL(specifier, parent.identifier).href));
await extension.evaluate();

function buildApp({seated = SETTINGS.seatedDue, input = SETTINGS.inputDue} = {}) {
    const state = {icons: false, banners: true, stops: 0};
    const played = [];
    const app = new extension.namespace.default();
    const menu = {box: new Actor(), isOpen: true, items: [], addMenuItem(item) { this.items.push(item); }};
    app._settings = {get_string: () => 'manual',
        get_boolean: key => ({'panel-icons': state.icons, 'sound-enabled': true})[key] ?? false,
        get_uint: key => ({'sound-effect': 3, 'sound-repeat': 15, 'sound-volume': 70})[key]};
    app._indicator = {menu};
    app._postureIcon = 'standing-icon';
    app._chimes = new ChimeSchedule();
    app._sound = {play: (effect, volume) => played.push([effect, volume]), stop: () => state.stops++};
    app._notificationSettings = {get_boolean: key => key === 'show-banners' && state.banners};
    app._soundError = '';
    app._buildPanel(new Actor());
    app._buildMenu(menu);
    app._session = {Name: 'tester', Type: 'x11', Class: 'user', Remote: false};
    app._today = '2026-10-29';
    app._store = {history: new DailyHistory(), warnings: [], error: ''};
    app._deskReady = true;
    app._eventsAvailable = true;
    app._position = 'sitting';
    app._blinkId = null;
    app._model = new WellnessModel({seated, input,
        todaySitting: 3600, todayStanding: 1200, keys: 100, clicks: 20, heeded: 3, missed: 1, lastInputWallMs: 1000});
    app._model.update({dt: 0, wallMs: 1000, idleSeconds: 0, position: 'sitting', deskReady: true});
    return {app, state, played};
}

test('dashboard keeps colored charts, posture percentages and score while coexisting with unrelated extensions', () => {
    const {app, state, played} = buildApp();
    app._paint(true, 0, 'manual', true);
    assert.deepEqual(played, [], 'Orange is silent');
    assert.equal(app._historyItem.visible, false);
    assert.ok(app._metricRows.awaySeconds.every(actor => !actor.visible));
    const orange = '#f1ac43';
    assert.equal(app._postureCard.meter._level.color, orange);
    assert.equal(app._handsCard.meter._level.color, orange);
    assert.ok(app._postureCard.meter.drawnColors.length > 1, 'Progress bar paints its colored fill');
    assert.ok(app._postureCard.big.style.includes(orange), 'Posture figure stays colored');
    assert.ok(app._handsCard.big.style.includes(orange), 'Hands figure stays colored');
    const {posture, hands, shortHands} = app._panelItems;
    assert.equal(posture.name.text, 'Posture');
    assert.equal(posture.icon.gicon, 'standing-icon');
    assert.equal(hands.icon.icon_name, 'input-keyboard-symbolic');
    assert.equal(shortHands.name.text, 'Short hands');
    assert.equal(hands.name.text, 'Long hands');
    assert.equal(app._shortHandsCard.of.text, 'of 20m active input');
    assert.equal(posture.icon.visible, false, 'Icons are opt-in');
    assert.equal(posture.bar._level.color, orange);
    assert.equal(posture.bar._level.fraction, 1);
    assert.equal(posture.time.text, '2:00', 'Orange counts down the 2-minute warning');
    assert.equal(posture.gauge.blink, 'slow');
    state.icons = true;
    app._paint(true, 0, 'manual', true);
    assert.equal(posture.icon.visible, true);
    assert.ok(posture.icon.style.includes(orange), 'Icon follows the bar color');
    assert.equal(app._metricCells.standingSeconds.today.percentage.text, '25%');
    assert.equal(app._metricCells.sittingSeconds.today.value.text, '1.0 h');
    assert.equal(app._metricCells.keyStrokes.today.value.text, '100');
    assert.equal(app._scoreValue.text, '75%');
    assert.equal(app._scoreBar._score, 0.75);
    assert.ok(app._scoreBar.drawnColors.flat().every(Number.isFinite), 'Theme colors draw on both color APIs');
    assert.equal(app._deskButton.label, 'I am standing');
    app._desk = {height_cm: 112};
    app._position = 'standing';
    app._paint(true, 0, 'bluetooth', true);
    assert.match(app._indicator.accessible_name, /standing/);
    app._deskReady = false;
    app._paint(true, 0, 'bluetooth', true);
    assert.equal(posture.bar._level.color, '#9ca3af', 'Unavailable desk turns the posture bar gray');
    app._deskReady = true;
    app._position = 'sitting';
    app._store.error = 'disk full';
    app._paint(true, 0, 'manual', true);
    assert.equal(app._historyItem.visible, true);
    assert.match(app._historyItem.label.text, /save failed/);
    app._store.error = '';
    app._store.warnings = ['bad record'];
    app._paint(true, 0, 'manual', true);
    assert.match(app._historyItem.label.text, /Unreadable/);
    app._store.warnings = [];
    app._model.todayAway = 1200;
    app._renderMetrics();
    assert.equal(app._metricCells.standingSeconds.today.percentage.text, '25%');
    app._settings.get_string = () => 'disabled';
    app._renderMetrics();
    assert.ok(app._metricRows.awaySeconds.every(actor => actor.visible));
    assert.equal(app._metricCells.standingSeconds.today.percentage.text, '20%');
    assert.equal(app._model.todayAway, 1200, 'Hidden history remains intact');
    app._model.seated = SETTINGS.seatedLate;
    app._model.input = SETTINGS.inputLate;
    app._paint(true, 0, 'manual', true);
    assert.equal(app._postureCard.meter._level.color, '#f26a66');
    assert.equal(posture.bar._level.color, '#f26a66');
    assert.equal(posture.gauge.blink, 'fast');
    assert.equal(app._postureCard.hint.text, 'Too late: penalty in 5:00');
    assert.equal(app._handsCard.hint.text, 'Too late: penalty in 5:00');
    app._model.shortInput = SETTINGS.shortInputLate;
    app._paint(true, 0, 'manual', true);
    assert.equal(app._shortHandsCard.hint.text, 'Too late: penalty in 5:00');
    assert.equal(shortHands.gauge.blink, 'fast');
    assert.deepEqual(notified, [], 'Reminders never raise desktop banners');
    assert.deepEqual(played, [[3, 70], [3, 70]],
        'The short reminder chimes when it turns red while the long reminder is already red');
    app._paint(true, 0, 'manual', true);
    assert.deepEqual(played, [[3, 70], [3, 70]], 'No repeat before the interval');
    app._paint(false, 0, 'manual', false);
    assert.equal(posture.time.text, '—');
    assert.equal(hands.bar._level.color, '#9ca3af');
    assert.equal(app._postureCard.meter._level.color, '#9ca3af');
    assert.equal(app._handsCard.meter._level.color, '#9ca3af');
    assert.equal(app._deskButton.visible, false);
    assert.equal(app._pause, undefined, 'Tracking is configured in Settings');
});

test('Do Not Disturb mutes the red sound and a missing player is reported, not thrown', () => {
    const sound = moduleAt(new URL('../extension/sound.js', import.meta.url).href).namespace;
    const errors = [];
    new sound.Sound('/ext', message => errors.push(message)).play(3, 0);
    assert.deepEqual(errors, [], 'Volume 0 is silent and starts nothing');
    new sound.Sound('/ext', message => errors.push(message)).play(3, 70);
    assert.match(errors[0], /gstreamer1\.0-plugins-base-apps/);
    const {app, state, played} = buildApp({seated: SETTINGS.seatedLate});
    state.banners = false;
    app._paint(true, 0, 'manual', true);
    assert.deepEqual(played, [], 'Do Not Disturb (show-banners off) mutes the sound');
    assert.ok(state.stops > 0, 'A sound already playing is cut off');
    state.banners = true;
    app._paint(true, 0, 'manual', true);
    assert.deepEqual(played, [[3, 70]], 'Leaving Do Not Disturb while red plays at once');
    app._paint(true, SETTINGS.postureActiveWindow, 'manual', true);
    app._paint(true, 0, 'manual', true);
    assert.deepEqual(played, [[3, 70]], 'Coming back from idle does not restart the sound');
});

test('Wayland starts and stops the input reader with the same local-session gate as Xorg', () => {
    const app = new extension.namespace.default();
    let starts = 0;
    let stops = 0;
    app._nextReaderAttempt = 0;
    app._startReader = () => { starts++; app._reader = {force_exit: () => stops++}; };
    app._manageReader(true, 0);
    assert.equal(starts, 1);
    app._inputHeartbeat = 1;
    app._manageReader(true, 1000);
    assert.equal(starts, 1, 'Only one reader while tracking');
    app._manageReader(false, 1000);
    assert.equal(stops, 1, 'Lock, pause or leaving the local session stops collection');
    assert.equal(app._eventsAvailable, false);
    app._manageReader(true, 2000);
    assert.equal(starts, 2, 'Unlock or resume starts a fresh reader');
});

test('the helper uses evdev on Wayland and RECORD on Xorg, with the configured hand-break length', () => {
    const gio = dependencies['gi://Gio'];
    const glib = dependencies['gi://GLib'];
    const meta = dependencies['gi://Meta'];
    const launches = [];
    const reader = {get_stdout_pipe: () => ({}), wait_async() {}};
    Object.assign(gio, {Subprocess: {new: argv => { launches.push(argv); return reader; }},
        Cancellable: class { cancel() {} }, DataInputStream: class {}});
    glib.build_filenamev = parts => parts.join('/');
    try {
        for (const wayland of [true, false]) {
            meta.is_wayland_compositor = () => wayland;
            const app = new extension.namespace.default();
            app._appDir = '/test app';
            app._readInput = () => {};
            app._startReader();
            assert.equal(app._reader, reader);
            assert.deepEqual(launches.at(-1), [wayland ? '/usr/bin/python3' : '/test app/.venv/bin/python', '/test app/input_monitor.py',
                `--backend=${wayland ? 'evdev' : 'x11'}`, `--break-seconds=${SETTINGS.inputResetIdle}`]);
        }
    } finally {
        meta.is_wayland_compositor = () => true;
    }
});

function setupApp() {
    const {app, state} = buildApp();
    const getBoolean = app._settings.get_boolean;
    app._settings.get_boolean = key => key === 'tracking-enabled' || getBoolean(key);
    app._generation = {};
    app._appDir = '/test app';
    app._localSession = () => state.active;
    state.active = true;
    app._indicator.menu.close = () => { state.closed = true; };
    app._inputSetupNeeded = true;
    app._eventsAvailable = false;
    app._tick = () => { state.ticks = (state.ticks || 0) + 1; };
    return {app, state};
}

test('GNOME 50 without the removed compositor API starts input and renders its permission action', () => {
    const gio = dependencies['gi://Gio'];
    const meta = dependencies['gi://Meta'];
    const originalLaunch = gio.Subprocess.new;
    const originalCheck = meta.is_wayland_compositor;
    const launches = [];
    const reader = {get_stdout_pipe: () => ({}), wait_async() {}};
    delete meta.is_wayland_compositor;
    gio.Subprocess.new = argv => { launches.push(argv); return reader; };
    try {
        const {app} = setupApp();
        app._readInput = () => {};
        app._startReader();
        assert.equal(app._inputError ?? '', '', 'The missing API must not be mistaken for an unavailable helper');
        assert.equal(app._reader, reader);
        assert.equal(launches[0][0], '/usr/bin/python3');
        assert.ok(launches[0].includes('--backend=evdev'));
        app._paint(true, 0, 'manual', true);
        assert.equal(app._inputSetupButton.visible, true);
        app._offerInputSetup();
        assert.equal(app._inputSetupDialog.opened, true);
        app._inputSetupDialog.buttons.find(button => button.label === 'Enable').action();
        assert.equal(launches[1][0], '/usr/bin/pkexec');
    } finally {
        gio.Subprocess.new = originalLaunch;
        meta.is_wayland_compositor = originalCheck;
    }
});

test('failed startup reports its cause and stops a partially started input helper', () => {
    const gio = dependencies['gi://Gio'];
    const originalLaunch = gio.Subprocess.new;
    const originalStream = gio.DataInputStream;
    const originalError = console.error;
    let stopped = 0;
    const errors = [];
    gio.Subprocess.new = () => ({get_stdout_pipe: () => ({}), force_exit: () => stopped++});
    gio.DataInputStream = class { constructor() { throw new Error('Native stream unavailable'); } };
    console.error = message => errors.push(message);
    try {
        const {app} = setupApp();
        app._inputSetupStatus = 'Input access enabled; checking devices…';
        app._startReader();
        assert.equal(stopped, 1);
        assert.equal(app._reader, null);
        assert.equal(app._eventsAvailable, false);
        assert.match(app._inputError, /Native stream unavailable/);
        app._paint(true, 0, 'manual', true);
        assert.match(app._handsCard.hint.text, /Native stream unavailable/);
        assert.equal(errors.length, 1);
    } finally {
        gio.Subprocess.new = originalLaunch;
        gio.DataInputStream = originalStream;
        console.error = originalError;
    }
});

test('Wayland permission failures offer setup without ever starting authorization automatically', () => {
    const {app} = setupApp();
    const gio = dependencies['gi://Gio'];
    const original = gio.Subprocess.new;
    let launches = 0;
    gio.Subprocess.new = () => { launches++; };
    try {
        app._paint(true, 0, 'manual', true);
        assert.equal(app._inputSetupButton.visible, true);
        assert.equal(launches, 0, 'Detection only shows the action');
        app._offerInputSetup();
        const dialog = app._inputSetupDialog;
        assert.equal(dialog.opened, true);
        assert.match(dialog.contentLayout.children[0].description, /other programs.*raw input access/);
        dialog.buttons.find(button => button.label === 'Cancel').action();
        assert.equal(launches, 0, 'Cancelling the explanation makes no system changes');
        assert.equal(app._inputSetupDialog, null);
        app._paint(false, 0, 'manual', false);
        assert.equal(app._inputSetupButton.visible, false, 'No setup action while paused or locked');
        app._inputSetupNeeded = false;
        app._paint(true, 0, 'manual', true);
        assert.equal(app._inputSetupButton.visible, false, 'No authorization prompt for a disconnected device');
    } finally {
        gio.Subprocess.new = original;
    }
});

test('live helper permission status drives the setup action and successful summaries clear it', () => {
    const {app} = setupApp();
    const reader = {};
    app._reader = reader;
    let callback;
    let batch;
    const stream = {read_line_async: (_priority, _cancel, ready) => { callback = ready; },
        read_line_finish_utf8: () => [JSON.stringify(batch)]};
    app._readInput(reader, stream, {});
    for (const errorCode of ['input-unavailable', 'input-permission', '']) {
        batch = {ready: !errorCode, errorCode, heartbeat: Date.now() / 1000,
            keys: errorCode ? 0 : 1, clicks: 0, moves: 0, lastInputWallMs: Date.now()};
        callback(stream, {});
        app._paint(true, 0, 'manual', true);
        assert.equal(app._inputSetupButton.visible, errorCode === 'input-permission');
    }
    assert.equal(app._model.keys, 101, 'Input resumes through the existing model');
    assert.equal(app._inputSetupStatus, '');
});

test('explicit approval enables input and restarts tracking; cancellation never nags or retries authorization', () => {
    const gio = dependencies['gi://Gio'];
    const original = gio.Subprocess.new;
    const launches = [];
    try {
        for (const exitStatus of [0, 126, 127, 1]) {
            const {app, state} = setupApp();
            let finished;
            const process = {wait_async: (_cancel, callback) => { finished = callback; },
                wait_finish() {}, get_if_exited: () => true, get_exit_status: () => exitStatus};
            gio.Subprocess.new = argv => { launches.push(argv); return process; };
            app._offerInputSetup();
            app._inputSetupDialog.buttons.find(button => button.label === 'Enable').action();
            assert.equal(state.closed, true);
            assert.equal(app._inputSetupProcess, process);
            assert.deepEqual(launches.at(-1), ['/usr/bin/pkexec', '--disable-internal-agent', '/usr/bin/python3', '-I',
                '/test app/wayland_setup.py', '--enable']);
            app._authorizeInputSetup();
            assert.equal(launches.length, [0, 126, 127, 1].indexOf(exitStatus) + 1, 'No concurrent authorization');
            finished(process, {});
            assert.equal(app._inputSetupProcess, null);
            if (exitStatus === 0) {
                assert.equal(app._nextReaderAttempt, 0, 'Resume tracking immediately after ACLs are applied');
                assert.match(app._inputSetupStatus, /enabled/);
            } else {
                assert.match(app._inputSetupStatus, exitStatus === 1 ? /failed/ : /cancelled|not authorized/);
                app._paint(true, 0, 'manual', true);
                assert.equal(app._inputSetupButton.visible, true, 'Manual retry remains available');
                assert.equal(launches.length, [0, 126, 127, 1].indexOf(exitStatus) + 1);
            }
        }
    } finally {
        gio.Subprocess.new = original;
    }
});

test('setup cannot start while locked, after disabling tracking, or on Xorg', () => {
    const gio = dependencies['gi://Gio'];
    const meta = dependencies['gi://Meta'];
    const original = gio.Subprocess.new;
    gio.Subprocess.new = () => { throw new Error('Unexpected privileged setup'); };
    try {
        const {app, state} = setupApp();
        state.active = false;
        app._offerInputSetup();
        app._authorizeInputSetup();
        assert.equal(app._inputSetupDialog, undefined);
        state.active = true;
        app._settings.get_boolean = () => false;
        app._offerInputSetup();
        app._authorizeInputSetup();
        app._settings.get_boolean = () => true;
        meta.is_wayland_compositor = () => false;
        app._offerInputSetup();
        app._authorizeInputSetup();
        assert.equal(app._inputSetupDialog, undefined);
    } finally {
        gio.Subprocess.new = original;
        meta.is_wayland_compositor = () => true;
    }
});

test('a completed authorization cannot restart a disabled or re-enabled extension', () => {
    const {app, state} = setupApp();
    const gio = dependencies['gi://Gio'];
    const original = gio.Subprocess.new;
    let finished;
    const process = {wait_async: (_cancel, callback) => { finished = callback; },
        wait_finish() {}, get_if_exited: () => true, get_exit_status: () => 0};
    gio.Subprocess.new = () => process;
    try {
        app._authorizeInputSetup();
        const ticks = state.ticks;
        app._generation = {};
        finished(process, {});
        assert.equal(state.ticks, ticks);
    } finally {
        gio.Subprocess.new = original;
    }
});

test('disabling the extension closes its setup dialog and cancels pending authorization', () => {
    const gio = dependencies['gi://Gio'];
    const original = gio.Subprocess.new;
    let finished;
    let cancelled = 0;
    const process = {wait_async: (_cancel, callback) => { finished = callback; },
        wait_finish() {}, get_if_exited: () => true, get_exit_status: () => 0, force_exit: () => cancelled++};
    gio.Subprocess.new = () => process;
    try {
        for (const authorize of [false, true]) {
            const {app, state} = setupApp();
            app._save = () => {};
            app._indicator.destroy = () => {};
            app._offerInputSetup();
            const dialog = app._inputSetupDialog;
            if (authorize) dialog.buttons.find(button => button.label === 'Enable').action();
            const ticks = state.ticks;
            app.disable();
            assert.equal(dialog.destroyed, true);
            assert.equal(app._inputSetupDialog, null);
            assert.equal(app._inputSetupProcess, null);
            if (authorize) {
                assert.equal(cancelled, 1);
                finished(process, {});
                assert.equal(state.ticks, ticks);
            }
        }
    } finally {
        gio.Subprocess.new = original;
    }
});
