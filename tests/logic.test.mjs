import test from 'node:test';
import assert from 'node:assert/strict';
import {SETTINGS, WellnessModel, deskState, isFreshHeartbeat, isLocalDesktop, isLocalSession, isWayland,
    preferencesProblem, preferencesOf, configure} from '../extension/logic.js';
import {dailyRecord, modelState} from '../extension/history.js';

const now = 1_000_000;
const tick = (model, overrides = {}, cfg = SETTINGS) => model.update({dt: 1, wallMs: now, localActive: true,
    deskReady: true, position: 'sitting', idleSeconds: 0, inputAvailable: true, ...overrides}, cfg);
const batch = (overrides = {}) => ({keys: 1, clicks: 2, moves: 3, lastInputWallMs: now, ...overrides});
const postureView = model => model.gauges({desk: true, input: false, idleSeconds: 0, handsIdle: 0}).posture;

test('compositor detection supports Xorg and Wayland before GNOME 50 and its removed API', () => {
    assert.equal(isWayland({is_wayland_compositor: () => false}), false);
    assert.equal(isWayland({is_wayland_compositor: () => true}), true);
    assert.equal(isWayland({}), true);
});

test('all desk modes are explicit, unavailable Bluetooth never appears healthy', () => {
    assert.deepEqual(deskState('manual', 'standing', null, now), {ready: true, position: 'standing'});
    assert.deepEqual(deskState('manual', 'away', null, now), {ready: true, position: 'sitting'});
    assert.deepEqual(deskState('disabled', 'away', null, now), {ready: true, position: 'away'});
    assert.deepEqual(deskState('disabled', 'standing', null, now), {ready: true, position: 'sitting'});
    const status = {connected: true, heartbeat: now / 1000, height_cm: 95};
    assert.equal(deskState('bluetooth', '', status, now).position, 'sitting');
    assert.equal(deskState('bluetooth', '', {...status, height_cm: 96}, now).position, 'standing');
    for (const change of [{connected: false}, {heartbeat: 1}, {height_cm: 999}, {height_cm: null}])
        assert.equal(deskState('bluetooth', '', {...status, ...change}, now).ready, false);
    assert.equal(deskState('bluetooth', '', null, now).ready, false);
    assert.equal(deskState('unknown', '', status, now).ready, false);
    assert.equal(isFreshHeartbeat(now / 1000 + 3, now), false);
    assert.equal(isFreshHeartbeat(undefined, now), false);
});

test('session checks accept local Xorg/Wayland and reject locks, SSH, other users and inactive logins', () => {
    const session = {Remote: false, Name: 'tester', Type: 'x11', Class: 'user', Active: true};
    assert.equal(isLocalSession(session, 'ubuntu', false, 'tester', 'user'), true);
    for (const changed of [{Remote: true}, {Name: 'other'}, {Type: 'tty'}, {Class: 'greeter'}, {Active: false}])
        assert.equal(isLocalSession({...session, ...changed}, 'user', false, 'tester'), false);
    assert.equal(isLocalSession({...session, Type: 'wayland'}, 'user', false, 'tester'), true);
    assert.equal(isLocalSession(session, 'user', true, 'tester'), false);
    assert.equal(isLocalSession(session, 'unlock-dialog', false, 'tester', 'user'), false);
    assert.equal(isLocalDesktop(null, 'tester'), false);
});

test('sitting before the standing minimum resumes the previous seated timer', () => {
    const model = new WellnessModel({seated: 6000});
    for (let second = 0; second < 600; second++) tick(model, {position: 'standing', wallMs: now + second * 1000});

    assert.deepEqual(postureView(model), {color: 'green', blink: null, fraction: 0.5, seconds: 600});
    tick(model, {wallMs: now + 600_000});
    assert.deepEqual([model.seated, model.standingRun, model.standComplete, model.heeded, model.missed],
        [6001, 0, false, 0, 0]);
});

for (const position of ['standing', 'away']) {
    test(`an early ${position} break earns one point at the minimum and can continue without a deadline`, () => {
        const model = new WellnessModel({seated: 6000, standingRun: 1199});
        tick(model, {position});
        assert.deepEqual([model.seated, model.standComplete, model.heeded, model.missed], [0, true, 1, 0]);
        assert.deepEqual(postureView(model), {color: 'green', blink: null, fraction: 1, seconds: null});

        for (let second = 1; second <= 1200; second++) tick(model, {position, wallMs: now + second * 1000});
        assert.equal(model.standingRun, 2400);
        assert.deepEqual(postureView(model), {color: 'green', blink: null, fraction: 1, seconds: null});
        assert.deepEqual(model.redReminders({active: true, input: false, idleSeconds: 0, handsIdle: Infinity}), []);
        assert.deepEqual(model.snoozable(), []);

        tick(model, {wallMs: now + 1_201_000});
        assert.deepEqual([model.seated, model.standingRun, model.standComplete, model.heeded, model.missed],
            [1, 0, false, 1, 0]);
    });
}

test('restoring a completed stand ignores an old sit-down snooze and preserves its recorded score', () => {
    const saved = {standComplete: true, heeded: 3, missed: 1,
        snoozes: {stand: {until: now - 1000, grace: 599, state: 'active'}}};
    const record = dailyRecord({...saved, date: '2026-10-30'});
    const model = new WellnessModel(modelState(record));
    tick(model, {position: 'standing'});

    assert.deepEqual(postureView(model), {color: 'green', blink: null, fraction: 1, seconds: null});
    assert.deepEqual(model.snoozes, {});
    assert.deepEqual([model.heeded, model.missed], [3, 1]);
});

test('disconnect, idle, lock and suspend pause posture without erasing standing progress', () => {
    const model = new WellnessModel({standingRun: 300});
    tick(model, {deskReady: false, position: 'standing'});
    tick(model, {localActive: false, position: 'standing'});
    assert.equal(model.standingRun, 300);
    tick(model, {position: 'standing', dt: 3600});
    assert.equal(model.standingRun, 302);
    tick(model, {idleSeconds: 60});
    assert.equal(model.todaySitting, 0);
    tick(model, {dt: -1});
    assert.equal(model.seated, 0);
});

for (const {position, timer, saved} of [
    {position: 'sitting', timer: 'seated', saved: {seated: SETTINGS.seatedDue}},
    {position: 'standing', timer: 'standingRun', saved: {standingRun: SETTINGS.standRequired, standComplete: true}},
]) {
    test(`15 minutes of desktop idle start a fresh ${position} session in the same posture`, () => {
        const model = new WellnessModel({...saved, todaySitting: 1200, todayStanding: 600, heeded: 3});
        tick(model, {position, dt: 0});
        assert.deepEqual(model.snooze(now), position === 'sitting' ? ['seated'] : []);

        tick(model, {position, wallMs: now + 899999, idleSeconds: 899.999});
        assert.equal(model[timer], saved[timer] + (position === 'standing' ? 1 : 0));
        tick(model, {position, wallMs: now + 900000, idleSeconds: 900});
        tick(model, {position, wallMs: now + 960000, idleSeconds: 960});
        assert.deepEqual([model.seated, model.standingRun, model.standComplete, model.lastPosition],
            [0, 0, false, position]);
        assert.deepEqual(model.snoozes, {});
        assert.deepEqual([model.todaySitting, model.todayStanding, model.heeded, model.missed], [1200, 600, 3, 0]);

        tick(model, {position, wallMs: now + 961000});
        assert.equal(model[timer], 1);
    });
}

test('returning between ticks starts fresh even after desktop idle has cleared', () => {
    const model = new WellnessModel({seated: 1800});
    tick(model, {dt: 0});
    tick(model, {wallMs: now + 899500, idleSeconds: 899.5});
    tick(model, {wallMs: now + 900500, idleSeconds: 0.25, position: 'standing'});
    assert.deepEqual([model.seated, model.standingRun, model.lastPosition], [0, 1, 'standing']);
});

test('unlocking after 15 minutes starts a fresh round even if the lock screen saw input', () => {
    const model = new WellnessModel({standingRun: SETTINGS.standRequired, standComplete: true});
    tick(model, {position: 'standing', dt: 0});
    tick(model, {position: 'standing', localActive: false, wallMs: now + 1000});
    tick(model, {position: 'standing', localActive: false, wallMs: now + 899000});
    assert.equal(model.standComplete, true);
    tick(model, {position: 'sitting', wallMs: now + 900000});
    assert.deepEqual([model.seated, model.standingRun, model.heeded], [1, 0, 0]);
});

test('returning from a break starts fresh when GNOME unloaded the extension while locked', () => {
    const model = new WellnessModel({standingRun: 600});
    tick(model, {position: 'standing', dt: 0});
    const restored = new WellnessModel(modelState(dailyRecord(model.serialize('2026-10-30'))));
    tick(restored, {position: 'standing', wallMs: now + 900000});
    assert.deepEqual([restored.standingRun, restored.todayStanding], [1, 1]);
});

test('fixed-desk walks are explicit and can finish while locked; remote or paused sessions cannot add time', () => {
    const model = new WellnessModel({seated: 7200, standingRun: 1199});
    tick(model, {position: 'away', localActive: false, awayAllowed: true, idleSeconds: 999});
    assert.equal(model.standComplete, true);
    assert.equal(model.seated, 0);
    assert.equal(model.todayAway, 1);
    tick(model, {position: 'away', localActive: false});
    tick(model, {position: 'away', deskReady: false, localActive: false, awayAllowed: true});
    assert.equal(model.todayAway, 1);
});

test('input counts and hand timer continue when Bluetooth is disconnected and reset after real rest', () => {
    const model = new WellnessModel({input: SETTINGS.inputDue - 1});
    model.onInputBatch(batch());
    tick(model, {deskReady: false});
    assert.deepEqual([model.keys, model.clicks, model.moves, model.input], [1, 2, 3, SETTINGS.inputDue]);
    assert.equal(model.inputColor(true, 0), 'orange');
    model.input = SETTINGS.inputLate;
    assert.equal(model.inputColor(true, 0), 'red');
    assert.equal(model.inputColor(false, 0), 'gray');
    assert.equal(model.inputColor(true, 10), 'green');
    tick(model, {wallMs: now + SETTINGS.inputResetIdle * 1000 - 1, idleSeconds: 0});
    assert.equal(model.input, SETTINGS.inputLate);
    tick(model, {wallMs: now + SETTINGS.inputResetIdle * 1000, idleSeconds: 0});
    assert.equal(model.input, 0);
    model.input = 100;
    model.onInputBatch(batch({lastInputWallMs: now + SETTINGS.inputResetIdle * 1000, hadBreak: true}));
    assert.equal(model.input, 0);
    assert.equal(model.keys, 2);
});

test('short rests complete only short breaks; two idle minutes complete both kinds', () => {
    const model = new WellnessModel({input: SETTINGS.inputDue, shortInput: SETTINGS.shortInputDue,
        lastInputWallMs: now});
    tick(model, {dt: 0});
    assert.deepEqual(model.snoozable(), ['input'], 'Short reminders cannot be snoozed');
    const shortOnly = new WellnessModel({shortInput: SETTINGS.shortInputDue, lastInputWallMs: now});
    tick(shortOnly, {dt: 0});
    assert.deepEqual(shortOnly.snoozable(), []);
    assert.deepEqual(shortOnly.snooze(now), []);
    tick(model, {dt: 0, wallMs: now + 19999, idleSeconds: 19.999});
    assert.equal(model.shortInput, SETTINGS.shortInputDue);
    tick(model, {dt: 0, wallMs: now + 20000, idleSeconds: 20});
    assert.deepEqual([model.shortInput, model.input, model.heeded], [0, SETTINGS.inputDue, 1]);
    model.shortInput = SETTINGS.shortInputDue;
    tick(model, {dt: 0, wallMs: now + 120000, idleSeconds: 120});
    assert.deepEqual([model.shortInput, model.input, model.heeded], [0, 0, 3]);
});

for (const {name, input, shortInput, heeded} of [
    {name: 'before a break is due', input: 1800, shortInput: 900, heeded: 0},
    {name: 'when breaks are due', input: 3600, shortInput: 1200, heeded: 2},
    {name: 'when breaks are overdue', input: 3660, shortInput: 1260, heeded: 0},
]) {
    test(`two minutes without input reset both timers ${name}`, () => {
        const model = new WellnessModel({input, shortInput, keys: 42, lastInputWallMs: now});
        tick(model, {dt: 0, wallMs: now + 119999});
        assert.equal(model.input, input, 'Less than two minutes preserves the long timer');
        tick(model, {dt: 0, wallMs: now + 120000});
        assert.deepEqual([model.input, model.shortInput, model.heeded, model.keys], [0, 0, heeded, 42]);
        tick(model, {dt: 0, wallMs: now + 121000});
        assert.equal(model.heeded, heeded, 'Continuing to rest cannot score the same break twice');
    });

    test(`an input batch after a two-minute gap resets both timers ${name}`, () => {
        const model = new WellnessModel({input, shortInput, lastInputWallMs: now});
        model.onInputBatch(batch({lastInputWallMs: now + 119999}));
        assert.equal(model.input, input);
        model.onInputBatch(batch({lastInputWallMs: now + 239999}));
        assert.deepEqual([model.input, model.shortInput, model.heeded, model.keys], [0, 0, heeded, 2]);
    });
}

test('an ignored short hand reminder scores two misses and starts a new short round', () => {
    const cfg = {...SETTINGS, shortInputDue: 2, shortInputLate: 4, redWindow: 4};
    const model = new WellnessModel({lastInputWallMs: now});
    for (let i = 0; i < 8; i++) tick(model, {}, cfg);
    assert.equal(model.missed, 2);
    assert.equal(model.shortInput, 0);
    assert.equal(model.input, 8, 'Long hand progress continues independently');
});

test('short reminder continues through a long reminder snooze and a 20 second input gap', () => {
    const model = new WellnessModel({input: SETTINGS.inputDue, shortInput: SETTINGS.shortInputDue,
        lastInputWallMs: now});
    tick(model, {dt: 0});
    assert.deepEqual(model.snooze(now), ['input']);
    assert.equal(model._color('shortInput', SETTINGS), 'orange');
    model.onInputBatch(batch({lastInputWallMs: now + 20000}));
    assert.deepEqual([model.shortInput, model.input, model.snoozes.input?.state], [0, SETTINGS.inputDue, 'active']);
});

test('motion-only batches are retained before the first key; malformed counters are ignored', () => {
    const model = new WellnessModel();
    model.onInputBatch(batch({keys: 0, clicks: 0, lastInputWallMs: 0}));
    assert.equal(model.moves, 3);
    tick(model);
    assert.equal(model.input, 0);
    for (const change of [{keys: -1}, {moves: 1.5}, {lastInputWallMs: NaN}]) model.onInputBatch(batch(change));
    assert.equal(model.keys, 0);
    model.onInputBatch(batch());
    tick(model, {localActive: false});
    tick(model, {inputAvailable: false});
    assert.equal(model.input, 0);
});

test('configuration validates heights and device addresses and converts minutes to seconds', () => {
    assert.match(preferencesProblem({'desk-sit': 112, 'desk-stand': 80}), /sitting height/);
    assert.match(preferencesProblem({'desk-device': 'not a device'}), /Bluetooth address/);
    assert.equal(preferencesProblem({'desk-sit': 80, 'desk-stand': 112, 'desk-device': 'aa:bb:cc:dd:ee:ff'}), null);
    const prefs = {'seated-due': 60, 'seated-grace': 5, 'stand-required': 10,
        'input-due': 20, 'input-grace': 1, 'input-break': 3, 'desk-sit': 75, 'desk-stand': 110,
        'red-window': 10, 'score-days': 14};
    const original = {...SETTINGS};
    configure(prefs);
    assert.deepEqual([SETTINGS.seatedDue, SETTINGS.standRequired, SETTINGS.inputResetIdle, SETTINGS.deskSitCm], [3600, 600, 120, 75]);
    Object.assign(SETTINGS, original);
    assert.deepEqual(preferencesOf({settings_schema: {list_keys: () => ['desk-mode']},
        get_value: () => ({deep_unpack: () => 'manual'})}), {'desk-mode': 'manual'});
});

test('habit score rewards timely hand rest and full posture breaks, counts penalties without replay on restart', () => {
    const timely = new WellnessModel({seated: SETTINGS.seatedDue - 1, input: SETTINGS.inputDue - 1, lastInputWallMs: now});
    tick(timely);
    timely.onInputBatch(batch({lastInputWallMs: now + 120000, hadBreak: true}));
    assert.equal(timely.heeded, 1);
    timely.standingRun = SETTINGS.standRequired - 1;
    tick(timely, {position: 'standing', idleSeconds: 60});
    tick(timely, {position: 'sitting'});
    assert.equal(timely.heeded, 2);
    assert.equal(timely.missed, 0);

    const late = new WellnessModel({seated: SETTINGS.seatedLate - 1, input: SETTINGS.inputLate - 1, lastInputWallMs: now});
    tick(late);
    assert.equal(late.missed, 0, 'Entering red is a warning, not yet a penalty');
    const restored = new WellnessModel(late.serialize('2026-10-29'));
    tick(restored);
    assert.equal(restored.missed, 0);
    restored.seated = SETTINGS.seatedLate + SETTINGS.redWindow / 2 - 1;
    tick(restored);
    assert.equal(restored.missed, 1);
    tick(restored, {idleSeconds: SETTINGS.inputResetIdle});
    assert.equal(restored.heeded, 0, 'Late hand rest clears the timer without earning a timely-break point');
    restored.resetPosture();
    assert.equal(restored.seated, 0);
    assert.equal(restored.standComplete, false);
    assert.equal(restored.missed, 1, 'Switching desk mode preserves earned daily score');
});

test('locking, leaving and prolonged inactivity forgive snoozes without penalty', () => {
    const cfg = {...SETTINGS, snoozeAway: 600};
    for (const overrides of [{localActive: false}, {idleSeconds: cfg.snoozeAway},
        {localActive: false, deskReady: false}]) {
        const model = new WellnessModel({seated: SETTINGS.seatedLate + SETTINGS.redWindow / 2, missed: 1,
            lastInputWallMs: now});
        model.lastPosition = 'sitting';
        model.snooze(now);
        assert.equal(model.missed, 0, 'Snooze takes back the penalty already charged');
        tick(model, {wallMs: now + 600000, ...overrides}, cfg);
        assert.equal(model.missed, 0);
        assert.equal(model.snoozes.seated.state, 'forgiven');
    }
});

test('the long hand reminder snoozes for its configured duration and clears after rest', () => {
    const hands = new WellnessModel({input: SETTINGS.inputDue, lastInputWallMs: now});
    assert.deepEqual(hands.snooze(now), ['input']);
    assert.equal(hands.snoozes.input.until, now + SETTINGS.inputSnooze * 1000);
    tick(hands, {idleSeconds: SETTINGS.inputResetIdle});
    assert.equal(hands.snoozes.input, undefined);
    assert.equal(hands.missed, 0);
});

test('entering red warns without a penalty; halfway and the end each charge one, then the round resets', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate - 1});
    tick(model);
    assert.deepEqual([model.deskColor(true), model.missed], ['red', 0]);
    model.seated = SETTINGS.seatedLate + SETTINGS.redWindow / 2 - 1;
    tick(model);
    assert.equal(model.missed, 1);
    model.seated = SETTINGS.seatedLate + SETTINGS.redWindow - 1;
    tick(model);
    assert.deepEqual([model.missed, model.seated, model.deskColor(true)], [2, 0, 'green']);
});

test('an ignored reminder never charges more than two per round', () => {
    const cfg = {...SETTINGS, seatedDue: 4, seatedLate: 6, redWindow: 4};
    const model = new WellnessModel();
    for (let i = 0; i < 20; i++) tick(model, {}, cfg);
    assert.deepEqual([model.missed, model.seated], [4, 0]);
});

test('the long hand reminder resets its own timer after the red window', () => {
    const hands = new WellnessModel({input: SETTINGS.inputLate + SETTINGS.redWindow - 1, missed: 1, lastInputWallMs: now});
    tick(hands);
    assert.deepEqual([hands.missed, hands.input], [2, 0]);
});

test('a change before red earns a point; in red before the first penalty it is neutral', () => {
    const early = new WellnessModel({seated: SETTINGS.seatedLate - 1, standingRun: SETTINGS.standRequired - 1});
    tick(early, {position: 'standing', idleSeconds: 60});
    assert.equal(early.heeded, 1);
    const red = new WellnessModel({seated: SETTINGS.seatedLate - 1});
    tick(red);
    red.standingRun = SETTINGS.standRequired - 1;
    tick(red, {position: 'standing', idleSeconds: 60});
    assert.deepEqual([red.heeded, red.missed], [0, 0]);
    const hands = new WellnessModel({input: SETTINGS.inputLate - 1, lastInputWallMs: now});
    tick(hands);
    tick(hands, {idleSeconds: SETTINGS.inputResetIdle});
    assert.deepEqual([hands.heeded, hands.missed, hands.input], [0, 0, 0]);
});

test('idle and locked time never advance the red window', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate + SETTINGS.redWindow / 2 - 1});
    tick(model, {idleSeconds: SETTINGS.postureActiveWindow});
    tick(model, {localActive: false});
    assert.deepEqual([model.missed, model.seated], [0, SETTINGS.seatedLate + SETTINGS.redWindow / 2 - 1]);
});

test('a snooze takes back penalties, holds the round, then gives a doubled red window', async () => {
    const {dailyRecord, modelState} = await import('../extension/history.js');
    const cfg = {...SETTINGS, seatedSnooze: 2, seatedDue: 2, seatedLate: 4, redWindow: 4};
    const model = new WellnessModel();
    tick(model, {dt: 2}, cfg);
    assert.deepEqual(model.snooze(now, cfg), ['seated']);
    assert.deepEqual(model.snooze(now, cfg), []);
    model.seated = 100;
    tick(model, {dt: 1, wallMs: now + 1000}, cfg);
    assert.deepEqual([model.missed, model.deskColor(true, cfg)], [0, 'orange'], 'Snoozed: no penalty, no reset');
    tick(model, {dt: 2, wallMs: now + 2000}, cfg);
    assert.equal(model.missed, 2, 'Halfway penalty counts double');
    const restored = new WellnessModel(modelState(dailyRecord(model.serialize('2026-10-30'))));
    assert.deepEqual(restored.snoozes, model.snoozes);
    tick(model, {dt: 2, wallMs: now + 4000}, cfg);
    assert.deepEqual([model.missed, model.seated, model.snoozes.seated], [4, 0, undefined]);
});

test('a snooze already holding a penalty takes it back', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate + SETTINGS.redWindow / 2, missed: 1});
    model.lastPosition = 'sitting';
    model.snooze(now);
    assert.equal(model.missed, 0);
});

test('a short lock forgives a snooze but it runs to its end; then penalties count once', () => {
    const cfg = {...SETTINGS, seatedSnooze: 10, seatedDue: 2, seatedLate: 4, redWindow: 4};
    const model = new WellnessModel();
    tick(model, {dt: 2}, cfg);
    model.snooze(now, cfg);
    tick(model, {localActive: false, wallMs: now + 1000}, cfg);
    assert.equal(model.snoozes.seated.state, 'forgiven');
    assert.equal(model.snoozeStates().seated, 'snoozed');
    tick(model, {dt: 2, wallMs: now + 10000}, cfg);
    tick(model, {dt: 2, wallMs: now + 12000}, cfg);
    assert.deepEqual([model.missed, model.seated], [2, 0]);
});

test('upgrading never replays penalties: old broken snoozes are dropped, past-window timers reset', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate + SETTINGS.redWindow + 5, missed: 3,
        snoozes: {seated: {until: 1, held: 0, grace: 0, state: 'broken', charged: 2}}});
    assert.deepEqual(model.snoozes, {});
    tick(model);
    assert.deepEqual([model.missed, model.seated], [3, 0]);
});

test('shrinking the red window mid-round charges at most two, then resets', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate + 60});
    tick(model, {}, {...SETTINGS, redWindow: 60});
    assert.deepEqual([model.missed, model.seated], [2, 0]);
});

test('gauges fill toward the change, count down to the next state and blink only when due and active', () => {
    const model = new WellnessModel({seated: 1800, input: SETTINGS.inputDue / 2, lastInputWallMs: now});
    tick(model, {dt: 0});
    const view = (overrides = {}) => model.gauges({desk: true, input: true, idleSeconds: 0, handsIdle: 0, ...overrides});
    assert.deepEqual(view().posture, {color: 'green', blink: null, fraction: 0.25, seconds: 5400});
    assert.deepEqual(view().hands, {color: 'green', blink: null, fraction: 0.5, seconds: SETTINGS.inputDue / 2});
    model.seated = SETTINGS.seatedDue + 30;
    assert.deepEqual(view().posture, {color: 'orange', blink: 'slow', fraction: 1, seconds: 90});
    model.seated = SETTINGS.seatedLate + 60;
    assert.deepEqual(view().posture, {color: 'red', blink: 'fast', fraction: 1, seconds: SETTINGS.redWindow / 2 - 60});
    model.seated = SETTINGS.seatedLate + SETTINGS.redWindow / 2 + 10;
    assert.equal(view().posture.seconds, SETTINGS.redWindow / 2 - 10);
    assert.equal(view({idleSeconds: SETTINGS.postureActiveWindow}).posture.blink, null);
    model.snooze(now);
    assert.deepEqual(view().posture, {color: 'orange', blink: null, fraction: 1, seconds: SETTINGS.seatedSnooze});
    model.wallMs = now + SETTINGS.seatedSnooze * 1000;
    assert.deepEqual(view().posture, {color: 'red', blink: 'fast', fraction: 1, seconds: SETTINGS.redWindow / 2});
    model.input = SETTINGS.inputDue;
    assert.deepEqual(view({handsIdle: 30}).hands, {color: 'green', blink: null, fraction: 1,
        seconds: SETTINGS.inputResetIdle - 30});
    assert.deepEqual(view({desk: false, input: false}),
        {posture: {color: 'gray', blink: null, fraction: 0, seconds: null},
            hands: {color: 'gray', blink: null, fraction: 0, seconds: null},
            shortHands: {color: 'gray', blink: null, fraction: 0, seconds: null}});
    const standing = new WellnessModel({standingRun: 300});
    tick(standing, {position: 'standing', dt: 0});
    assert.deepEqual(postureView(standing), {color: 'green', blink: null, fraction: 0.25, seconds: 900});
});

test('red reminders follow the round, not idle pauses, and leave out snoozed ones', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate, input: SETTINGS.inputLate, lastInputWallMs: now});
    tick(model, {dt: 0});
    const red = (overrides = {}) => model.redReminders({active: true, input: true, idleSeconds: 0, handsIdle: 0, ...overrides});
    assert.deepEqual(red(), [{name: 'seated', active: true}, {name: 'input', active: true}]);
    assert.deepEqual(red({input: false}).map(reminder => reminder.active), [true, false],
        'No hand sound while input counts are unavailable and the hand timer is frozen');
    assert.deepEqual(red({idleSeconds: SETTINGS.postureActiveWindow, handsIdle: 12}),
        [{name: 'seated', active: false}, {name: 'input', active: false}], 'A pause keeps the round red but inactive');
    assert.deepEqual(red({active: false}).map(reminder => reminder.active), [false, false]);
    model.snooze(now);
    assert.deepEqual(red().map(reminder => reminder.name), [], 'Snoozed reminders are silent');
    model.wallMs = now + SETTINGS.inputSnooze * 1000;
    assert.deepEqual(red().map(reminder => reminder.name), ['input'], 'A run-out snooze is red again');
});
