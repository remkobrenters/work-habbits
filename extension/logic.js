// Pure reminder logic. Durations are seconds; wall-clock values are milliseconds.
export const SETTINGS = {
    seatedDue: 7200, seatedLate: 7320, standRequired: 1200, standLate: 1320,
    inputDue: 1500, inputLate: 1560, inputResetIdle: 120,
    inputActiveWindow: 10, postureActiveWindow: 60, deskSitCm: 80, deskStandCm: 112,
    redWindow: 600, scoreDays: 14,
    seatedSnooze: 900, standSnooze: 900, inputSnooze: 600, snoozeAway: 900, snoozePenalty: 2,
};

export function preferencesOf(settings) {
    return Object.fromEntries(settings.settings_schema.list_keys().map(key =>
        [key, settings.get_value(key).deep_unpack()]));
}

export function configure(prefs) {
    Object.assign(SETTINGS, {
        seatedDue: prefs['seated-due'] * 60,
        seatedLate: (prefs['seated-due'] + prefs['seated-grace']) * 60,
        standRequired: prefs['stand-required'] * 60,
        standLate: (prefs['stand-required'] + prefs['stand-grace']) * 60,
        inputDue: prefs['input-due'] * 60,
        inputLate: (prefs['input-due'] + prefs['input-grace']) * 60,
        inputResetIdle: prefs['input-break'] * 60,
        deskSitCm: prefs['desk-sit'], deskStandCm: prefs['desk-stand'],
        redWindow: (prefs['red-window'] ?? 10) * 60, scoreDays: prefs['score-days'],
        seatedSnooze: (prefs['seated-snooze'] ?? 15) * 60, standSnooze: (prefs['stand-snooze'] ?? 15) * 60,
        inputSnooze: (prefs['input-snooze'] ?? 10) * 60, snoozeAway: (prefs['snooze-away'] ?? 15) * 60,
        snoozePenalty: prefs['snooze-penalty'] ?? 2,
    });
}

export function preferencesProblem(prefs) {
    if (prefs['desk-sit'] >= prefs['desk-stand'])
        return 'The sitting height must be below the standing height.';
    if (prefs['desk-device'] && !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(prefs['desk-device']))
        return 'Enter a Bluetooth address such as AA:BB:CC:DD:EE:FF.';
    return null;
}

export function isFreshHeartbeat(heartbeat, wallMs, limitSeconds = 20) {
    const age = wallMs / 1000 - heartbeat;
    return Number.isFinite(heartbeat) && age >= -2 && age <= limitSeconds;
}

export function isLocalDesktop(session, user) {
    return session?.Remote === false && session.Name === user &&
        ['x11', 'wayland'].includes(session.Type) && session.Class === 'user';
}

export function isLocalSession(session, mode, locked, user, parentMode = null) {
    return (mode === 'user' || parentMode === 'user') && mode !== 'unlock-dialog' &&
        !locked && session?.Active === true && isLocalDesktop(session, user);
}

export function deskState(mode, manualPosition, status, wallMs, cfg = SETTINGS) {
    if (mode === 'manual') return {ready: true, position: manualPosition === 'standing' ? 'standing' : 'sitting'};
    if (mode === 'disabled') return {ready: true, position: manualPosition === 'away' ? 'away' : 'sitting'};
    const ready = mode === 'bluetooth' && status?.connected === true &&
        isFreshHeartbeat(status.heartbeat, wallMs) && Number.isFinite(status.height_cm) &&
        status.height_cm >= 50 && status.height_cm <= 140;
    return {ready, position: ready
        ? status.height_cm * 2 < cfg.deskSitCm + cfg.deskStandCm ? 'sitting' : 'standing'
        : 'unknown'};
}

const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : 0;
const color = (value, due, late) => value >= late ? 'red' : value >= due ? 'orange' : 'green';
// Seconds spent in red: a penalty halfway through the window and another at its end.
const penalties = (elapsed, window) => elapsed >= window ? 2 : elapsed >= window / 2 ? 1 : 0;
const nextPenalty = (elapsed, window) => (elapsed < window / 2 ? window / 2 : window) - elapsed;

// Snoozable reminders: stand up, sit down again, rest the hands.
const REMINDERS = ['seated', 'stand', 'input'];

const VALUE = {seated: 'seated', stand: 'standingRun', input: 'input'};
const DUE = {seated: 'seatedDue', stand: 'standRequired', input: 'inputDue'};
const LATE = {seated: 'seatedLate', stand: 'standLate', input: 'inputLate'};
const BLINK = {orange: 'slow', red: 'fast'};
const GRAY = Object.freeze({color: 'gray', blink: null, fraction: 0, seconds: null});

function validSnooze(snooze) {
    return ['until', 'grace'].every(name => Number.isFinite(snooze?.[name]) && snooze[name] >= 0) &&
        ['active', 'forgiven'].includes(snooze.state);
}

export class WellnessModel {
    constructor(saved = null) {
        for (const key of ['seated', 'standingRun', 'input', 'todaySitting', 'todayStanding',
            'todayAway', 'keys', 'clicks', 'moves', 'lastInputWallMs'])
            this[key] = nonnegative(saved?.[key]);
        this.standComplete = saved?.standComplete === true;
        this.heeded = nonnegative(saved?.heeded);
        this.missed = nonnegative(saved?.missed);
        this._misses = Object.fromEntries(REMINDERS.map(name =>
            [name, penalties(this[VALUE[name]] - SETTINGS[LATE[name]], SETTINGS.redWindow)]));
        this.snoozes = {};
        for (const name of REMINDERS) {
            if (validSnooze(saved?.snoozes?.[name])) this.snoozes[name] = {...saved.snoozes[name]};
        }
        this.lastPosition = 'unknown';
        this.wallMs = 0;
    }

    onInputBatch(batch) {
        if (!['keys', 'clicks', 'moves'].every(name => Number.isSafeInteger(batch[name]) && batch[name] >= 0) ||
            !Number.isFinite(batch.lastInputWallMs) || batch.lastInputWallMs < 0)
            return;
        if (batch.hadBreak || (this.lastInputWallMs &&
            batch.lastInputWallMs - this.lastInputWallMs >= SETTINGS.inputResetIdle * 1000))
            this._restHands(SETTINGS);
        this.keys += batch.keys;
        this.clicks += batch.clicks;
        this.moves += batch.moves;
        this.lastInputWallMs = Math.max(this.lastInputWallMs, batch.lastInputWallMs);
    }

    handsIdle(idleSeconds) {
        return this.lastInputWallMs ? Math.max(idleSeconds, (this.wallMs - this.lastInputWallMs) / 1000) : Infinity;
    }

    _restHands(cfg) {
        if (this._roundColor('input', cfg) === 'orange') this.heeded++;
        this.input = 0;
        this._misses.input = 0;
        delete this.snoozes.input;
    }

    // Red charges a penalty halfway and at the end, then the round starts over. A snooze holds
    // the round; once it runs out, a fresh red window counts double unless the user left.
    _advance(name, dt, cfg) {
        const snooze = this.snoozes[name];
        const window = cfg.redWindow;
        if (!snooze) {
            const count = penalties(this[VALUE[name]] - cfg[LATE[name]], window);
            this.missed += Math.max(0, count - this._misses[name]);
            this._misses[name] = Math.max(count, this._misses[name]);
            if (count === 2) this._resetRound(name);
            return;
        }
        if (this._snoozeState(name) !== 'over') return;
        const before = penalties(snooze.grace, window);
        snooze.grace += dt;
        this.missed += (penalties(snooze.grace, window) - before) * (snooze.state === 'active' ? cfg.snoozePenalty : 1);
        if (snooze.grace >= window) this._resetRound(name);
    }

    _resetRound(name) {
        this[VALUE[name]] = 0;
        this._misses[name] = 0;
        delete this.snoozes[name];
    }

    // Leaving during a snooze or its red window cancels the double penalty.
    _forgive() {
        for (const snooze of Object.values(this.snoozes)) snooze.state = 'forgiven';
    }

    _due(name, cfg) {
        const due = this[VALUE[name]] >= cfg[DUE[name]];
        if (name === 'seated') return due && !['standing', 'away'].includes(this.lastPosition);
        return name === 'stand' ? due && this.standComplete : due;
    }

    // Due reminders not snoozed since their last break.
    snoozable(cfg = SETTINGS) {
        return REMINDERS.filter(name => !this.snoozes[name] && this._due(name, cfg));
    }

    // Leaving soon: penalties already charged in this round are taken back.
    snooze(wallMs, cfg = SETTINGS) {
        const names = this.snoozable(cfg);
        for (const name of names) {
            this.missed = Math.max(0, this.missed - this._misses[name]);
            this.snoozes[name] = {until: wallMs + cfg[`${name}Snooze`] * 1000, grace: 0, state: 'active'};
        }
        return names;
    }

    // A snooze is 'snoozed' until it runs out, then 'over' while its red window runs.
    // Standing is taking the stand, so a seated snooze cannot run out until you sit again.
    _snoozeState(name) {
        const snooze = this.snoozes[name];
        if (!snooze) return null;
        return this.wallMs < snooze.until || (name === 'seated' && ['standing', 'away'].includes(this.lastPosition))
            ? 'snoozed' : 'over';
    }

    snoozeStates() {
        return Object.fromEntries(Object.keys(this.snoozes).map(name => [name, this._snoozeState(name)]));
    }

    // Colour from the round's timer alone, and with a snooze holding it at orange or run out to red.
    _roundColor(name, cfg) {
        return color(this[VALUE[name]], cfg[DUE[name]], cfg[LATE[name]]);
    }

    _color(name, cfg) {
        return {snoozed: 'orange', over: 'red'}[this._snoozeState(name)] ?? this._roundColor(name, cfg);
    }

    _postureReminder() {
        return this.lastPosition === 'sitting' ? 'seated' : 'stand';
    }

    resetPosture() {
        this.seated = this.standingRun = 0;
        this.standComplete = false;
        this._misses.seated = this._misses.stand = 0;
        delete this.snoozes.seated;
        delete this.snoozes.stand;
    }

    update({dt, localActive, deskReady, position, idleSeconds, wallMs, inputAvailable, awayAllowed = false}, cfg = SETTINGS) {
        dt = nonnegative(Math.min(dt, 2)); // Never infer activity during suspend or downtime.
        this.wallMs = wallMs;
        const handsIdle = this.handsIdle(idleSeconds);
        if (!localActive || idleSeconds >= cfg.snoozeAway || (this.lastInputWallMs && handsIdle >= cfg.snoozeAway)) this._forgive();
        if (handsIdle >= cfg.inputResetIdle) this._restHands(cfg);
        // Input tracking is independent of Bluetooth availability.
        if (localActive && inputAvailable && handsIdle < cfg.inputActiveWindow) {
            this.input += dt;
            this._advance('input', dt, cfg);
        }
        this.lastPosition = deskReady ? position : 'unknown';
        if (!deskReady) return;
        if (position === 'sitting') {
            if (this.standComplete && this._roundColor('stand', cfg) === 'orange') this.heeded++;
            this.standingRun = 0;
            this.standComplete = false;
            this._misses.stand = 0;
            delete this.snoozes.stand;
            if (localActive && idleSeconds < cfg.postureActiveWindow) {
                this.seated += dt;
                this.todaySitting += dt;
                this._advance('seated', dt, cfg);
            }
            return;
        }
        // An explicitly marked walk can continue while the screen is locked.
        if (!localActive && !(awayAllowed && position === 'away')) return;
        if (!this.standComplete || idleSeconds < cfg.postureActiveWindow) this.standingRun += dt;
        if (!this.standComplete && this.standingRun >= cfg.standRequired) {
            if (this._roundColor('seated', cfg) !== 'red') this.heeded++;
            this.standComplete = true;
            this.seated = 0;
            this._misses.seated = 0;
            delete this.snoozes.seated;
        }
        if (localActive && idleSeconds < cfg.postureActiveWindow) {
            this._advance('stand', dt, cfg);
        }
        if (position === 'away') this.todayAway += dt;
        else if (idleSeconds < cfg.postureActiveWindow) this.todayStanding += dt;
    }

    deskColor(available, cfg = SETTINGS) {
        return available ? this._color(this._postureReminder(), cfg) : 'gray';
    }

    inputColor(available, idleSeconds, cfg = SETTINGS) {
        if (!available) return 'gray';
        return idleSeconds >= cfg.inputActiveWindow ? 'green' : this._color('input', cfg);
    }

    // Time until a snoozed reminder runs out, or until the next penalty of its red window.
    snoozeSeconds(name, cfg = SETTINGS) {
        const snooze = this.snoozes[name];
        return this._snoozeState(name) === 'snoozed' ? (snooze.until - this.wallMs) / 1000
            : nextPenalty(snooze.grace, cfg.redWindow);
    }

    // Per panel item: colour, blink, bar fill toward the change and seconds until the next state.
    gauges({desk, input, idleSeconds, handsIdle}, cfg = SETTINGS) {
        const gauge = (name, color, active) => {
            const value = this[VALUE[name]];
            const due = cfg[DUE[name]];
            const late = cfg[LATE[name]];
            const seconds = this.snoozes[name] ? this.snoozeSeconds(name, cfg)
                : color === 'green' ? due - value : color === 'orange' ? late - value
                    : nextPenalty(value - late, cfg.redWindow);
            const blink = active && this._snoozeState(name) !== 'snoozed' ? BLINK[color] ?? null : null;
            return {color, blink, fraction: color === 'green' ? Math.min(1, value / due) : 1, seconds};
        };
        const posture = !desk || this.lastPosition === 'unknown' ? GRAY
            : gauge(this._postureReminder(), this.deskColor(true, cfg), idleSeconds < cfg.postureActiveWindow);
        if (!input) return {posture, hands: GRAY};
        if (handsIdle < cfg.inputActiveWindow)
            return {posture, hands: gauge('input', this.inputColor(true, handsIdle, cfg), true)};
        // Resting hands stay green and count down to the reset.
        return {posture, hands: {...gauge('input', 'green', false),
            seconds: this.input > 0 ? Math.max(0, cfg.inputResetIdle - handsIdle) : cfg.inputDue}};
    }

    // Reminders whose round is red (a run-out snooze included), and whether the user is active for each.
    redReminders({active, idleSeconds, handsIdle}, cfg = SETTINGS) {
        const reminders = [];
        const posture = this._postureReminder();
        if (this.lastPosition !== 'unknown' && this._color(posture, cfg) === 'red')
            reminders.push({name: posture, active: active && idleSeconds < cfg.postureActiveWindow});
        if (this._color('input', cfg) === 'red')
            reminders.push({name: 'input', active: active && handsIdle < cfg.inputActiveWindow});
        return reminders;
    }

    serialize(date) {
        const state = {date, standComplete: this.standComplete, heeded: this.heeded, missed: this.missed};
        for (const key of ['seated', 'standingRun', 'input', 'todaySitting', 'todayStanding',
            'todayAway', 'keys', 'clicks', 'moves', 'lastInputWallMs']) state[key] = this[key];
        state.snoozes = Object.fromEntries(Object.entries(this.snoozes).map(([name, value]) => [name, {...value}]));
        return state;
    }
}
