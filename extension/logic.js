// Pure reminder logic. Durations are seconds; wall-clock values are milliseconds.
export const SETTINGS = {
    seatedDue: 7200, seatedLate: 7500, standRequired: 1200, standLate: 1500,
    inputDue: 1500, inputLate: 1560, inputResetIdle: 120,
    inputActiveWindow: 10, postureActiveWindow: 60, deskSitCm: 80, deskStandCm: 112,
    seatedRepeat: 1800, standRepeat: 900, inputRepeat: 900, scoreDays: 14,
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
        seatedRepeat: prefs['seated-repeat'] * 60, standRepeat: prefs['stand-repeat'] * 60,
        inputRepeat: prefs['input-repeat'] * 60, scoreDays: prefs['score-days'],
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
const misses = (value, late, repeat) => value >= late ? 1 + Math.floor((value - late) / repeat) : 0;

// Snoozable reminders: stand up, sit down again, rest the hands.
const REMINDERS = ['seated', 'stand', 'input'];

// A reminder's grace between orange and red; also the grace after its snooze.
function grace(name, cfg) {
    return {seated: cfg.seatedLate - cfg.seatedDue, stand: cfg.standLate - cfg.standRequired,
        input: cfg.inputLate - cfg.inputDue}[name];
}

function validSnooze(snooze) {
    return ['until', 'held', 'grace', 'charged'].every(name =>
        Number.isFinite(snooze?.[name]) && snooze[name] >= 0) &&
        ['active', 'forgiven', 'broken'].includes(snooze.state);
}

export class WellnessModel {
    constructor(saved = null) {
        for (const key of ['seated', 'standingRun', 'input', 'todaySitting', 'todayStanding',
            'todayAway', 'keys', 'clicks', 'moves', 'lastInputWallMs'])
            this[key] = nonnegative(saved?.[key]);
        this.standComplete = saved?.standComplete === true;
        this.heeded = nonnegative(saved?.heeded);
        this.missed = nonnegative(saved?.missed);
        this._misses = {
            seated: misses(this.seated, SETTINGS.seatedLate, SETTINGS.seatedRepeat),
            stand: misses(this.standingRun, SETTINGS.standLate, SETTINGS.standRepeat),
            input: misses(this.input, SETTINGS.inputLate, SETTINGS.inputRepeat),
        };
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
        if (this.input >= cfg.inputDue && this._misses.input === 0) this.heeded++;
        this.input = 0;
        this._misses.input = 0;
        delete this.snoozes.input;
    }

    _countMisses(name, value, late, repeat) {
        const count = misses(value, late, repeat);
        const added = Math.max(0, count - this._misses[name]);
        if (this.snoozes[name]?.state === 'active') this.snoozes[name].held += added;
        else this.missed += added;
        this._misses[name] = Math.max(count, this._misses[name]);
    }

    // Working on past a snooze runs down the reminder's grace; then its held misses count double.
    _overrun(name, dt, cfg) {
        const snooze = this.snoozes[name];
        if (snooze?.state !== 'active' || this.wallMs < snooze.until) return;
        snooze.grace += dt;
        if (snooze.grace < grace(name, cfg)) return;
        snooze.charged = cfg.snoozePenalty * snooze.held;
        this.missed += snooze.charged;
        snooze.held = 0;
        snooze.state = 'broken';
    }

    // Stopping work during a snooze or its grace costs nothing.
    _forgive() {
        for (const snooze of Object.values(this.snoozes)) {
            if (snooze.state !== 'active') continue;
            snooze.held = 0;
            snooze.state = 'forgiven';
        }
    }

    _due(name, cfg) {
        if (name === 'seated') return this.seated >= cfg.seatedDue && !['standing', 'away'].includes(this.lastPosition);
        if (name === 'stand') return this.standComplete;
        return this.input >= cfg.inputDue;
    }

    // Due reminders not snoozed since their last break.
    snoozable(cfg = SETTINGS) {
        return REMINDERS.filter(name => !this.snoozes[name] && this._due(name, cfg));
    }

    // Leaving soon: misses wait, and a miss already counted for the reminder is taken back.
    snooze(wallMs, cfg = SETTINGS) {
        const names = this.snoozable(cfg);
        for (const name of names) {
            const held = this._misses[name];
            this.missed = Math.max(0, this.missed - held);
            this.snoozes[name] = {until: wallMs + cfg[`${name}Snooze`] * 1000, held, grace: 0, state: 'active',
                charged: 0};
        }
        return names;
    }

    // Per snoozed reminder: snoozed, over (its grace running), broken or forgiven.
    // Standing is taking the stand, so a stand snooze cannot run out until you sit again.
    snoozeStates() {
        const held = (name, until) => this.wallMs < until || (name === 'seated' && ['standing', 'away'].includes(this.lastPosition));
        return Object.fromEntries(Object.entries(this.snoozes).map(([name, {state, until}]) =>
            [name, state === 'active' ? (held(name, until) ? 'snoozed' : 'over') : state]));
    }

    // A snooze holds its reminder at orange; once it runs out, red.
    _snoozeColor(name) {
        const state = this.snoozeStates()[name];
        return state === 'snoozed' ? 'orange' : state === 'over' ? 'red' : null;
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
            this._countMisses('input', this.input, cfg.inputLate, cfg.inputRepeat);
            this._overrun('input', dt, cfg);
        }
        this.lastPosition = deskReady ? position : 'unknown';
        if (!deskReady) return;
        if (position === 'sitting') {
            if (this.standComplete && this._misses.stand === 0) this.heeded++;
            this.standingRun = 0;
            this.standComplete = false;
            this._misses.stand = 0;
            delete this.snoozes.stand;
            if (localActive && idleSeconds < cfg.postureActiveWindow) {
                this.seated += dt;
                this.todaySitting += dt;
                this._countMisses('seated', this.seated, cfg.seatedLate, cfg.seatedRepeat);
                this._overrun('seated', dt, cfg);
            }
            return;
        }
        // An explicitly marked walk can continue while the screen is locked.
        if (!localActive && !(awayAllowed && position === 'away')) return;
        if (!this.standComplete || idleSeconds < cfg.postureActiveWindow) this.standingRun += dt;
        if (!this.standComplete && this.standingRun >= cfg.standRequired) {
            if (this._misses.seated === 0) this.heeded++;
            this.standComplete = true;
            this.seated = 0;
            this._misses.seated = 0;
            delete this.snoozes.seated;
        }
        if (localActive && idleSeconds < cfg.postureActiveWindow) {
            this._countMisses('stand', this.standingRun, cfg.standLate, cfg.standRepeat);
            this._overrun('stand', dt, cfg);
        }
        if (position === 'away') this.todayAway += dt;
        else if (idleSeconds < cfg.postureActiveWindow) this.todayStanding += dt;
    }

    deskColor(available, cfg = SETTINGS) {
        if (!available) return 'gray';
        const snoozed = this._snoozeColor(this.lastPosition === 'sitting' ? 'seated' : 'stand');
        if (snoozed) return snoozed;
        return this.lastPosition === 'sitting' ? color(this.seated, cfg.seatedDue, cfg.seatedLate)
            : color(this.standingRun, cfg.standRequired, cfg.standLate);
    }

    inputColor(available, idleSeconds, cfg = SETTINGS) {
        if (!available) return 'gray';
        return idleSeconds >= cfg.inputActiveWindow ? 'green'
            : this._snoozeColor('input') ?? color(this.input, cfg.inputDue, cfg.inputLate);
    }

    reminderUrgency({desk, input}, cfg = SETTINGS) {
        const states = this.snoozeStates();
        desk &&= states[this.lastPosition === 'sitting' ? 'seated' : 'stand'] !== 'snoozed';
        input &&= states.input !== 'snoozed';
        const urgency = (value, due) => value >= due + 30 ? 'due' : value >= due - 10 ? 'near' : null;
        return {
            desk: desk ? this.lastPosition === 'sitting'
                ? urgency(this.seated, cfg.seatedDue) : urgency(this.standingRun, cfg.standRequired) : null,
            input: input ? urgency(this.input, cfg.inputDue) : null,
        };
    }

    countdown({desk, input, idleSeconds}, cfg = SETTINGS) {
        const choices = [];
        if (desk && this.lastPosition !== 'unknown') {
            const resting = this.lastPosition !== 'sitting';
            const value = resting ? this.standingRun : this.seated;
            const due = resting ? cfg.standRequired : cfg.seatedDue;
            choices.push({icon: 'desk', due: value >= due,
                seconds: resting ? Math.max(0, (this.standComplete ? cfg.standLate : due) - value)
                    : value >= due ? cfg.standRequired : due - value});
        }
        if (input) choices.push({icon: 'input', due: this.input >= cfg.inputDue,
            seconds: this.input >= cfg.inputDue ? Math.max(0, cfg.inputResetIdle - idleSeconds)
                : cfg.inputDue - this.input});
        for (const choice of choices) {
            const name = choice.icon === 'input' ? 'input' : this.lastPosition === 'sitting' ? 'seated' : 'stand';
            const snooze = this.snoozes[name];
            if (snooze?.state !== 'active') continue;
            choice.seconds = this.wallMs < snooze.until ? (snooze.until - this.wallMs) / 1000
                : Math.max(0, grace(name, cfg) - snooze.grace);
            choice.due = true;
        }
        choices.sort((a, b) => b.due - a.due || a.seconds - b.seconds);
        return choices[0] ?? null;
    }

    serialize(date) {
        const state = {date, standComplete: this.standComplete, heeded: this.heeded, missed: this.missed};
        for (const key of ['seated', 'standingRun', 'input', 'todaySitting', 'todayStanding',
            'todayAway', 'keys', 'clicks', 'moves', 'lastInputWallMs']) state[key] = this[key];
        state.snoozes = Object.fromEntries(Object.entries(this.snoozes).map(([name, value]) => [name, {...value}]));
        return state;
    }
}
