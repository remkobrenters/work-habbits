import Cairo from 'cairo';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {SETTINGS, WellnessModel, isFreshHeartbeat, isLocalDesktop, isLocalSession,
    configure, deskState, preferencesOf} from './logic.js';
import {dailyRecord, modelState, formatHours, formatCount, formatTimer} from './history.js';
import {HistoryStore} from './storage.js';
import {Sound} from './sound.js';
import {ChimeSchedule} from './sound-options.js';

const COLORS = {green: '#40cb82', orange: '#f1ac43', red: '#f26a66', gray: '#9ca3af'};
const PERIODS = ['today', 'week', 'month'];
const PERIOD_TITLES = ['Today', 'This week', 'This month'];
const END = Clutter.ActorAlign.END;
const MUTED = 190;
// GNOME 48 introduced orientation; older supported shells use vertical.
const vertical = St.BoxLayout.list_properties().some(property => property.name === 'orientation')
    ? {orientation: Clutter.Orientation.VERTICAL} : {vertical: true};
const localDate = () => GLib.DateTime.new_now_local().format('%Y-%m-%d');

function readJSON(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    } catch {
        return null;
    }
}


function label(text = '', {style_class = '', muted = false, x_expand = false, x_align = null} = {}) {
    const actor = new St.Label({text, style_class, x_expand, y_align: Clutter.ActorAlign.CENTER});
    if (muted) actor.opacity = MUTED;
    if (x_align !== null) actor.x_align = x_align;
    return actor;
}

// A section of the popup, optionally with a heading. Sections are plain actors,
// not menu items: inactive menu items are drawn in the theme's faded text colour.
function section(parent, heading = null) {
    const box = new St.BoxLayout({...vertical, x_expand: true, style_class: 'wh-section'});
    if (heading) box.add_child(label(heading, {style_class: 'wh-heading'}));
    parent.add_child(box);
    return box;
}

function rule(parent) {
    parent.add_child(new St.Widget({style_class: 'wh-rule', x_expand: true}));
}

function grid(box, homogeneous = true) {
    const layout = new Clutter.GridLayout({column_spacing: 10, row_spacing: 7, column_homogeneous: homogeneous});
    box.add_child(new St.Widget({layout_manager: layout, x_expand: true}));
    return layout;
}

function periodHeader(layout, row = 0) {
    PERIOD_TITLES.forEach((title, column) =>
        layout.attach(label(title, {muted: true, x_expand: true, x_align: END}), column + 1, row, 1, 1));
}

function rgb(hex) {
    const value = parseInt(hex.slice(1), 16);
    return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}

function pill(cr, x, y, width, height) {
    const radius = height / 2;
    cr.newSubPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, Math.PI / 2);
    cr.arc(x + radius, y + radius, radius, Math.PI / 2, Math.PI * 1.5);
    cr.closePath();
}

// A budget bar: fill coloured by state, optional tick at the warning threshold.
// An unlit level draws only the track, for blinking.
const Meter = GObject.registerClass({GTypeName: 'WorkHabbitsMeter'},
class Meter extends St.DrawingArea {
    _init({style_class = 'wh-meter', thickness = 0.5, x_expand = true} = {}) {
        super._init({style_class, x_expand, y_align: Clutter.ActorAlign.CENTER});
        this._thickness = thickness;
        this._level = {fraction: 0, color: COLORS.gray, tick: null, lit: true};
        this.connect('repaint', () => this._draw());
    }

    setLevel(level) {
        this._level = {tick: null, lit: true, ...level};
        this.queue_repaint();
    }

    _draw() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const {fraction, color, tick, lit} = this._level;
        const bar = height * this._thickness;
        const top = (height - bar) / 2;
        pill(cr, 0, top, width, bar);
        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.22);
        cr.fill();
        const filled = Math.max(0, Math.min(1, fraction || 0)) * width;
        if (filled > 0 && lit) {
            pill(cr, 0, top, Math.max(bar, filled), bar);
            cr.setSourceRGBA(...rgb(color), 1);
            cr.fill();
        }
        if (tick !== null) {
            cr.rectangle(Math.round(tick * width) - bar / 6, 0, bar / 3, height);
            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.85);
            cr.fill();
        }
        cr.$dispose();
    }
});

const SCORE_STOPS = [[0, COLORS.red], [0.5, COLORS.orange], [1, COLORS.green]];

// The habit score: a red-to-green scale with a ball at the current score.
const ScoreBar = GObject.registerClass({GTypeName: 'WorkHabbitsScoreBar'},
class ScoreBar extends St.DrawingArea {
    _init() {
        super._init({style_class: 'wh-score', x_expand: true});
        this._score = null;
        this.connect('repaint', () => this._draw());
    }

    setScore(score) {
        this._score = score;
        this.queue_repaint();
    }

    _draw() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const ball = height;
        const bar = height / 3;
        const gradient = new Cairo.LinearGradient(ball / 2, 0, width - ball / 2, 0);
        const alpha = this._score === null ? 0.35 : 1;
        for (const [offset, color] of SCORE_STOPS)
            gradient.addColorStopRGBA(offset, ...rgb(color), alpha);
        pill(cr, 0, (height - bar) / 2, width, bar);
        cr.setSource(gradient);
        cr.fill();
        if (this._score !== null) {
            const score = Math.max(0, Math.min(1, this._score));
            const [low, high] = score <= 0.5 ? [SCORE_STOPS[0], SCORE_STOPS[1]] : [SCORE_STOPS[1], SCORE_STOPS[2]];
            const t = (score - low[0]) / (high[0] - low[0]);
            const fill = rgb(low[1]).map((value, index) => value + (rgb(high[1])[index] - value) * t);
            const ink = this.get_theme_node().get_foreground_color();
            const x = ball / 2 + score * (width - ball);
            const stroke = ball / 6;
            cr.arc(x, height / 2, (ball - stroke) / 2, 0, Math.PI * 2);
            cr.setSourceRGBA(...fill, 1);
            cr.fillPreserve();
            cr.setLineWidth(stroke);
            const strokeColor = ['red', 'green', 'blue'].map(channel =>
                typeof ink[`get_${channel}`] === 'function' ? ink[`get_${channel}`]() : ink[channel] / 255);
            cr.setSourceRGBA(...strokeColor, 1);
            cr.stroke();
        }
        cr.$dispose();
    }
});

export default class WorkHabbitsExtension extends Extension {
    enable() {
        this._generation = {};
        this._settings = this.getSettings();
        configure(preferencesOf(this._settings));
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            configure(preferencesOf(this._settings));
            if (['tracking-enabled', 'desk-mode', 'desk-device'].includes(key)) {
                this._socketCancel?.cancel();
                this._socketCancel = new Gio.Cancellable();
            }
            if (key === 'input-break' || key === 'tracking-enabled') this._stopReader();
            if (key.startsWith('sound-')) this._soundError = '';
            if (key === 'input-break') this._nextReaderAttempt = 0;
            if (key === 'desk-mode') {
                this._settings.set_string('manual-position', 'sitting');
                this._model.resetPosture();
            }
        });
        this._appDir = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'work-habbits']);
        this._runtimeDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'work-habbits']);
        this._today = localDate();
        this._store = new HistoryStore(GLib.build_filenamev([GLib.get_user_state_dir(), 'work-habbits']));
        this._model = new WellnessModel(modelState(this._store.history.days.get(this._today)));
        this._session = null;
        this._desk = null;
        this._lastTick = GLib.get_monotonic_time() / 1e6;
        this._lastSave = this._lastTick;
        this._reader = null;
        this._inputCancel = null;
        this._inputHeartbeat = 0;
        this._eventsAvailable = false;
        this._inputError = '';
        this._nextReaderAttempt = 0;
        this._socketCancel = new Gio.Cancellable();
        this._sound = new Sound(this.path, message => {
            this._soundError = message;
        });
        this._soundError = '';
        this._chimes = new ChimeSchedule();
        // GNOME's Do Not Disturb turns banners off; it mutes reminder sounds too.
        this._notificationSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});

        this._postureIcon = new Gio.FileIcon({file: this.dir.get_child('icons').get_child('standing-symbolic.svg')});
        this._indicator = new PanelMenu.Button(0.0, 'work-habbits', false);
        const box = new St.BoxLayout({style_class: 'wh-panel'});
        this._blinkId = null;
        this._buildPanel(box);
        this._indicator.add_child(box);
        this._buildMenu(this._indicator.menu);
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._renderMetrics();
        });
        Main.panel.addToStatusArea('work-habbits', this._indicator);
        const generation = this._generation;
        LoginManager.getLoginManager().getCurrentSessionProxy().then(session => {
            if (this._generation === generation) this._session = session;
        }).catch(error => console.error(`work-habbits: session check failed: ${error.message}`));
        this._tick();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Top bar: per item an optional icon, the label over its progress bar, and the time.
    _buildPanel(box) {
        const item = (title, icon) => {
            const actor = new St.BoxLayout({style_class: 'wh-gauge', y_align: Clutter.ActorAlign.CENTER});
            const identity = new St.BoxLayout({...vertical, style_class: 'wh-gauge-identity', y_align: Clutter.ActorAlign.CENTER});
            const name = label(title, {style_class: 'wh-gauge-name'});
            const bar = new Meter({style_class: 'wh-panel-meter', thickness: 1, x_expand: false});
            const time = label('', {style_class: 'wh-gauge-time wh-num', muted: true});
            time.y_align = Clutter.ActorAlign.START;
            identity.add_child(name);
            identity.add_child(bar);
            for (const child of [icon, identity, time]) actor.add_child(child);
            box.add_child(actor);
            return {icon, name, bar, time, gauge: null, blinkStarted: 0, painted: null};
        };
        this._panelItems = {
            posture: item('Posture', new St.Icon({gicon: this._postureIcon, style_class: 'system-status-icon'})),
            hands: item('Hands', new St.Icon({icon_name: 'input-keyboard-symbolic', style_class: 'system-status-icon'})),
        };
    }

    // Orange blinks slowly, red fast; the label and time stay steady.
    _paintGauges(gauges) {
        const icons = this._settings.get_boolean('panel-icons');
        const now = GLib.get_monotonic_time() / 1e6;
        for (const [name, item] of Object.entries(this._panelItems)) {
            const gauge = gauges[name];
            if (gauge.blink !== item.gauge?.blink) item.blinkStarted = now;
            item.gauge = gauge;
            item.icon.visible = icons;
            item.time.text = gauge.seconds === null ? '—' : formatTimer(gauge.seconds);
        }
        const blinking = Object.values(gauges).some(gauge => gauge.blink);
        if (blinking && !this._blinkId) {
            this._blinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._paintBlink();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!blinking && this._blinkId) {
            GLib.Source.remove(this._blinkId);
            this._blinkId = null;
        }
        this._paintBlink();
    }

    _buildMenu(menu) {
        const popup = new St.BoxLayout({...vertical, style_class: 'wh-popup'});
        menu.box.add_child(popup);
        const score = section(popup);
        const scoreHeader = new St.BoxLayout({x_expand: true});
        scoreHeader.add_child(label('Habit score', {style_class: 'wh-heading', x_expand: true}));
        this._scoreValue = label('—', {style_class: 'wh-heading wh-num'});
        scoreHeader.add_child(this._scoreValue);
        score.add_child(scoreHeader);
        this._scoreBar = new ScoreBar();
        score.add_child(this._scoreBar);
        this._scoreCaption = label('', {muted: true});
        score.add_child(this._scoreCaption);
        rule(popup);

        const cards = new St.BoxLayout({style_class: 'wh-cards', x_expand: true});
        cards.layout_manager.homogeneous = true;
        const reminders = section(popup);
        reminders.add_child(cards);
        const card = title => {
            const body = new St.BoxLayout({...vertical, x_expand: true, style_class: 'wh-card'});
            body.add_child(label(title, {style_class: 'wh-heading'}));
            const figure = new St.BoxLayout({style_class: 'wh-figure'});
            const big = label('—', {style_class: 'wh-big'});
            big.y_align = END;
            const of = label('', {muted: true});
            of.y_align = END;
            figure.add_child(big);
            figure.add_child(of);
            body.add_child(figure);
            const meter = new Meter();
            body.add_child(meter);
            const hint = label('');
            hint.clutter_text?.set_line_wrap(true);
            body.add_child(hint);
            cards.add_child(body);
            return {body, big, of, meter, hint};
        };
        this._postureCard = card('Posture');
        this._height = label('Desk height: —', {style_class: 'wh-num'});
        this._postureCard.body.add_child(this._height);
        this._deskButton = new St.Button({style_class: 'button wh-desk-button', x_align: Clutter.ActorAlign.START});
        this._deskButton.connect('clicked', () => this._deskAction());
        this._postureCard.body.add_child(this._deskButton);
        this._handsCard = card('Hands');
        this._snoozeButton = new St.Button({label: 'Snooze — leaving soon', style_class: 'button wh-desk-button'});
        this._snoozeButton.connect('clicked', () => {
            if (!this._localSession() || !this._settings.get_boolean('tracking-enabled')) return;
            this._model.snooze(Date.now());
            this._save();
            this._tick();
        });
        reminders.add_child(this._snoozeButton);
        this._snoozeHint = label('', {muted: true});
        this._snoozeHint.clutter_text?.set_line_wrap(true);
        reminders.add_child(this._snoozeHint);

        rule(popup);

        const activity = grid(section(popup, 'Desk and input'));
        periodHeader(activity);
        this._metricCells = {};
        const rows = [['standingSeconds', 'Standing'], ['sittingSeconds', 'Sitting'],
            ['awaySeconds', 'Movement breaks'], ['keyStrokes', 'Keystrokes'], ['mouseClicks', 'Clicks']];
        this._metricRows = {};
        rows.forEach(([metric, title], index) => {
            const titleActor = label(title);
            this._metricRows[metric] = [titleActor];
            activity.attach(titleActor, 0, index + 1, 1, 1);
            this._metricCells[metric] = {};
            PERIODS.forEach((period, column) => {
                const cell = new St.BoxLayout({style_class: 'wh-cell', x_expand: true, x_align: END});
                const value = label('—', {style_class: 'wh-num'});
                cell.add_child(value);
                const percentage = metric.endsWith('Seconds')
                    ? label('', {style_class: 'wh-num wh-small', muted: true}) : null;
                if (percentage) cell.add_child(percentage);
                this._metricCells[metric][period] = {value, percentage};
                this._metricRows[metric].push(cell);
                activity.attach(cell, column + 1, index + 1, 1, 1);
            });
        });
        rule(popup);

        const settings = new St.Button({style_class: 'icon-button flat wh-settings', accessible_name: 'Settings',
            x_align: END, child: new St.Icon({icon_name: 'emblem-system-symbolic'})});
        settings.connect('clicked', () => {
            menu.close();
            this.openPreferences();
        });
        popup.add_child(settings);
        const statusItem = () => {
            const item = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
            item.visible = false;
            menu.addMenuItem(item);
            return item;
        };
        this._historyItem = statusItem();
        this._soundItem = statusItem();
    }

    _paintBlink() {
        const now = GLib.get_monotonic_time() / 1e6;
        for (const item of Object.values(this._panelItems)) {
            const {blink, fraction} = item.gauge;
            const color = COLORS[item.gauge.color];
            const lit = !blink || Math.floor((now - item.blinkStarted) / (blink === 'slow' ? 1 : 0.5)) % 2 === 0;
            const painted = `${fraction}|${color}|${lit}`;
            if (painted === item.painted) continue;
            item.painted = painted;
            item.bar.setLevel({fraction, color, lit});
            item.icon.set_style(`color: ${color};`);
            item.icon.opacity = lit ? 255 : 60;
        }
    }

    _localSession() {
        return isLocalSession(this._session, Main.sessionMode.currentMode, Main.sessionMode.isLocked,
            GLib.get_user_name(), Main.sessionMode.parentMode);
    }

    _startReader() {
        this._nextReaderAttempt = Date.now() + 15000;
        try {
            const reader = Gio.Subprocess.new([
                GLib.build_filenamev([this._appDir, '.venv', 'bin', 'python']),
                GLib.build_filenamev([this._appDir, 'input_monitor.py']),
                `--break-seconds=${SETTINGS.inputResetIdle}`,
            ], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._reader = reader;
            this._inputCancel = new Gio.Cancellable();
            const stream = new Gio.DataInputStream({base_stream: reader.get_stdout_pipe()});
            this._readInput(reader, stream, this._inputCancel);
            reader.wait_async(null, (process, result) => {
                try {
                    process.wait_finish(result);
                } catch {
                    // Termination is expected when tracking pauses.
                }
                if (this._reader === reader) {
                    this._stopReader(false);
                    this._inputError ||= 'Input reader stopped; check installation';
                }
            });
        } catch (error) {
            this._inputError = 'Input reader unavailable; run ./install.sh again';
            console.error(`work-habbits: ${error.message}`);
        }
    }

    _readInput(reader, stream, cancel) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancel, (source, result) => {
            try {
                const [line] = source.read_line_finish_utf8(result);
                if (this._reader !== reader) return;
                if (line === null) {
                    this._stopReader();
                    return;
                }
                const batch = JSON.parse(line);
                this._eventsAvailable = batch.ready === true && isFreshHeartbeat(batch.heartbeat, Date.now(), 5);
                this._inputHeartbeat = batch.heartbeat;
                this._inputError = batch.error || '';
                if (this._eventsAvailable && this._localSession() && this._settings.get_boolean('tracking-enabled')) {
                    this._rollDay(localDate());
                    this._model.onInputBatch(batch);
                }
                this._readInput(reader, stream, cancel);
            } catch (error) {
                if (this._reader === reader) {
                    this._inputError = 'Input reader failed; retrying';
                    this._stopReader();
                    console.error(`work-habbits: ${error.message}`);
                }
            } finally {
                if (this._reader !== reader) source.close(null);
            }
        });
    }

    _stopReader(terminate = true) {
        const reader = this._reader;
        this._reader = null;
        this._inputCancel?.cancel();
        this._inputCancel = null;
        if (terminate) reader?.force_exit();
        this._eventsAvailable = false;
        this._inputHeartbeat = 0;
    }

    _manageReader(allowed, wallMs) {
        if (!allowed) {
            this._stopReader();
            return;
        }
        if (Meta.is_wayland_compositor()) {
            this._inputError = 'Input counts require an Xorg session';
            return;
        }
        if (this._reader && !isFreshHeartbeat(this._inputHeartbeat, wallMs, 5) && wallMs >= this._nextReaderAttempt)
            this._stopReader();
        if (!this._reader && wallMs >= this._nextReaderAttempt) this._startReader();
    }

    _tick() {
        const mono = GLib.get_monotonic_time() / 1e6;
        const wallMs = Date.now();
        const dt = mono - this._lastTick;
        this._lastTick = mono;
        this._rollDay(localDate());
        const mode = this._settings.get_string('desk-mode');
        this._desk = mode === 'bluetooth' ? readJSON(`${this._runtimeDir}/desk.json`) : null;
        // Ignore a previous device's status while the service switches connections.
        if (this._desk?.device !== this._settings.get_string('desk-device').toUpperCase()) this._desk = null;
        const {ready, position} = deskState(mode, this._settings.get_string('manual-position'), this._desk, wallMs);
        this._position = position;
        this._deskReady = ready;
        const enabled = this._settings.get_boolean('tracking-enabled');
        const localActive = enabled && this._localSession();
        let idleSeconds = Infinity;
        try {
            idleSeconds = global.backend.get_core_idle_monitor().get_idletime() / 1000;
        } catch {
            // Unknown idle status must not accumulate activity.
        }
        this._manageReader(localActive, wallMs);
        this._eventsAvailable &&= isFreshHeartbeat(this._inputHeartbeat, wallMs, 5);
        this._model.update({dt, wallMs, localActive, idleSeconds, deskReady: enabled && ready, position,
            awayAllowed: enabled && isLocalDesktop(this._session, GLib.get_user_name()) && this._session.Active === true,
            inputAvailable: this._eventsAvailable});
        this._paint(localActive, idleSeconds, mode, enabled);
        if (mono - this._lastSave >= 30) {
            this._save();
            this._lastSave = mono;
        }
    }

    _paint(active, idleSeconds, mode, enabled) {
        this._indicator.visible = isLocalDesktop(this._session, GLib.get_user_name());
        const model = this._model;
        const handsIdle = model.handsIdle(idleSeconds);
        const deskAvailable = active && this._deskReady;
        const inputAvailable = active && this._eventsAvailable;
        const gauges = model.gauges({desk: deskAvailable, input: inputAvailable, idleSeconds, handsIdle});
        const deskColor = gauges.posture.color;
        const inputColor = gauges.hands.color;
        this._paintGauges(gauges);
        const red = model.redReminders({active, input: inputAvailable, idleSeconds, handsIdle});
        const allowed = this._settings.get_boolean('sound-enabled') && this._notificationSettings.get_boolean('show-banners');
        const chime = this._chimes.update({red, allowed, repeatSeconds: this._settings.get_uint('sound-repeat'),
            nowSeconds: GLib.get_monotonic_time() / 1e6});
        if (chime === 'play')
            this._sound.play(this._settings.get_uint('sound-effect'), this._settings.get_uint('sound-volume'));
        else if (chime === 'stop')
            this._sound.stop();
        const tooLate = (gauge, name) => gauge.color === 'red' && !model.snoozes[name]
            ? `Too late: penalty in ${formatTimer(gauge.seconds)}` : '';
        const resting = ['standing', 'away'].includes(this._position);
        const reason = !enabled ? 'Tracking paused' : !active ? 'Waiting for an active, unlocked local desktop'
            : !this._deskReady ? this._desk?.error || 'Bluetooth desk unavailable; input tracking continues' : '';
        const breakName = mode === 'disabled' ? 'movement break' : 'standing';
        const posture = this._postureCard;
        const elapsed = resting ? model.standingRun : model.seated;
        const due = resting ? SETTINGS.standRequired : SETTINGS.seatedDue;
        const late = resting ? SETTINGS.standLate : SETTINGS.seatedLate;
        posture.big.text = `${Math.floor(elapsed / 60)}m`;
        posture.big.set_style(`color: ${COLORS[deskColor]};`);
        posture.of.text = `of ${Math.floor(due / 60)}m ${resting ? breakName : 'seated'}`;
        posture.meter.setLevel({fraction: elapsed / late, color: COLORS[deskColor], tick: due / late});
        posture.hint.text = reason || tooLate(gauges.posture, resting ? 'stand' : 'seated') || (resting
            ? model.standComplete ? 'Break complete; return to sitting' : `${formatTimer(due - elapsed)} to go`
            : model.seated >= due ? `Time for ${mode === 'disabled' ? 'a movement break' : 'a stand'}`
                : `Next break in ${formatTimer(due - elapsed)}`);
        if (!reason && !resting && idleSeconds >= SETTINGS.postureActiveWindow)
            posture.hint.text = 'Paused; no recent activity';
        this._height.text = mode === 'bluetooth' ? `Desk: ${this._deskReady ? `${this._desk.height_cm} cm` : 'unavailable'}`
            : mode === 'manual' ? 'Desk: manual posture selection' : 'Desk movement disabled';
        this._deskButton.visible = active && (mode !== 'bluetooth' || this._deskReady);
        this._deskButton.label = mode === 'bluetooth'
            ? Number.isFinite(this._desk?.moving_to) ? 'Stop the desk'
                : resting ? `Lower desk to ${SETTINGS.deskSitCm} cm` : `Raise desk to ${SETTINGS.deskStandCm} cm`
            : mode === 'manual' ? resting ? 'I am sitting' : 'I am standing'
                : resting ? 'Back at desk' : 'Start movement break';
        const hands = this._handsCard;
        hands.big.text = `${Math.floor(model.input / 60)}m`;
        hands.big.set_style(`color: ${COLORS[inputColor]};`);
        hands.of.text = `of ${Math.floor(SETTINGS.inputDue / 60)}m typing`;
        hands.meter.setLevel({fraction: model.input / SETTINGS.inputLate, color: COLORS[inputColor],
            tick: SETTINGS.inputDue / SETTINGS.inputLate});
        hands.hint.text = !active ? 'Tracking paused' : !this._eventsAvailable
            ? this._inputError || 'Waiting for input reader' : tooLate(gauges.hands, 'input')
                || (model.input === 0 ? 'Rested; timer reset' : handsIdle >= SETTINGS.inputActiveWindow
                    ? `Resets in ${formatTimer(SETTINGS.inputResetIdle - handsIdle)}`
                    : `Rest for ${Math.floor(SETTINGS.inputResetIdle / 60)}m to reset`);
        if (this._indicator.menu.isOpen) this._renderMetrics();
        this._indicator.accessible_name = `work-habbits: ${this._deskReady ? this._position : 'posture unknown'}, posture ${deskColor}, hands ${inputColor}`;
        const status = (item, text) => {
            item.visible = Boolean(text);
            item.label.text = text;
        };
        status(this._historyItem, this._store.error ? 'History save failed; will retry'
            : this._store.warnings.length ? 'Unreadable history preserved; see logs' : '');
        status(this._soundItem, this._soundError);
        this._snoozeButton.visible = active && model.snoozable().length > 0;
        const names = {seated: 'Stand', stand: 'Sit', input: 'Hands'};
        const states = model.snoozeStates();
        this._snoozeHint.text = Object.entries(states).map(([name, state]) => {
            const time = formatTimer(model.snoozeSeconds(name));
            const doubled = model.snoozes[name].state === 'active' ? `, counts ×${SETTINGS.snoozePenalty}` : '';
            return `${names[name]}: ${state === 'snoozed' ? `snoozed ${time}` : `penalty in ${time}${doubled}`}`;
        }).join('\n');
        this._snoozeHint.visible = Boolean(this._snoozeHint.text);
    }

    _renderMetrics() {
        this._store.history.set(this._record());
        const totals = this._store.history.totals(this._today);
        const showMovement = this._settings.get_string('desk-mode') === 'disabled';
        for (const actor of this._metricRows.awaySeconds) actor.visible = showMovement;
        for (const period of PERIODS) {
            const metrics = totals[period];
            const postureTotal = metrics.sittingSeconds + metrics.standingSeconds + (showMovement ? metrics.awaySeconds : 0);
            for (const [metric, cells] of Object.entries(this._metricCells)) {
                const cell = cells[period];
                cell.value.text = metric.endsWith('Seconds') ? formatHours(metrics[metric]) : formatCount(metrics[metric]);
                if (cell.percentage)
                    cell.percentage.text = `${postureTotal ? Math.round(100 * metrics[metric] / postureTotal) : 0}%`;
            }
        }
        const habit = this._store.history.habitScore(this._today, SETTINGS.scoreDays);
        this._scoreValue.text = habit.score === null ? '—' : `${Math.round(100 * habit.score)}%`;
        this._scoreBar.setScore(habit.score);
        this._scoreCaption.text = habit.score === null ? 'Standing and hand breaks you take will score here'
            : `Last ${habit.days} active days: ${habit.heeded} reminders heeded, ${habit.missed} missed`;
    }

    _deskAction() {
        if (!this._localSession() || !this._settings.get_boolean('tracking-enabled')) return;
        const mode = this._settings.get_string('desk-mode');
        if (mode !== 'bluetooth') {
            this._settings.set_string('manual-position', this._position === 'sitting'
                ? mode === 'manual' ? 'standing' : 'away' : 'sitting');
            this._tick();
            this._save();
            return;
        }
        if (!this._deskReady) return;
        const request = Number.isFinite(this._desk?.moving_to) ? {stop: true}
            : {move_to: this._position === 'sitting' ? SETTINGS.deskStandCm : SETTINGS.deskSitCm};
        const client = new Gio.SocketClient({timeout: 3});
        const cancel = this._socketCancel;
        client.connect_async(Gio.UnixSocketAddress.new(`${this._runtimeDir}/desk.sock`), cancel, (source, result) => {
            let connection;
            try {
                connection = source.connect_finish(result);
                const bytes = new GLib.Bytes(new TextEncoder().encode(`${JSON.stringify(request)}\n`));
                connection.get_output_stream().write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, cancel, (stream, written) => {
                    try {
                        stream.write_bytes_finish(written);
                    } catch (error) {
                        if (!cancel.is_cancelled()) Main.notify('work-habbits', `Desk command failed: ${error.message}`);
                    } finally {
                        connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
                    }
                });
            } catch (error) {
                if (!cancel.is_cancelled()) Main.notify('work-habbits', `Desk unavailable: ${error.message}`);
                connection?.close_async(GLib.PRIORITY_DEFAULT, null, null);
            }
        });
    }

    _record() {
        return dailyRecord(this._model.serialize(this._today));
    }

    _rollDay(today) {
        if (today === this._today) return;
        this._save();
        this._today = today;
        this._model = new WellnessModel(modelState(this._store.history.days.get(today)));
    }

    _save() {
        if (this._model && isLocalDesktop(this._session, GLib.get_user_name())) this._store.save(this._record());
    }

    disable() {
        this._generation = null;
        if (this._timerId) GLib.Source.remove(this._timerId);
        this._timerId = null;
        if (this._blinkId) GLib.Source.remove(this._blinkId);
        this._blinkId = null;
        this._socketCancel?.cancel();
        this._socketCancel = null;
        this._stopReader();
        this._sound?.stop();
        this._sound = null;
        this._chimes = null;
        this._notificationSettings = null;
        this._save();
        if (this._settingsChangedId) this._settings.disconnect(this._settingsChangedId);
        this._settingsChangedId = null;
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._model = null;
        this._session = null;
    }
}
