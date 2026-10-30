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
    connect() {}
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
        DateTime: {new_now_local: () => ({format: () => '2026-10-29'})},
        timeout_add: () => 1, Source: {remove() {}}, PRIORITY_DEFAULT: 0,
        find_program_in_path: () => null},
    'gi://Gio': {},
    'gi://Meta': {is_wayland_compositor: () => true},
    'resource:///org/gnome/shell/ui/main.js': {notify: (...args) => notified.push(args)},
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
    const {posture, hands} = app._panelItems;
    assert.equal(posture.name.text, 'Posture');
    assert.equal(posture.icon.gicon, 'standing-icon');
    assert.equal(hands.icon.icon_name, 'input-keyboard-symbolic');
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
    assert.deepEqual(notified, [], 'Reminders never raise desktop banners');
    assert.deepEqual(played, [[3, 70]], 'Red plays the chosen sound at the chosen volume once on entry');
    app._paint(true, 0, 'manual', true);
    assert.deepEqual(played, [[3, 70]], 'No repeat before the interval');
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

test('Wayland never launches the X11 input helper', () => {
    const app = new extension.namespace.default();
    app._startReader = () => { throw new Error('Wayland must not launch an X11 recorder'); };
    app._manageReader(true, 0);
    assert.match(app._inputError, /Xorg/);
});
