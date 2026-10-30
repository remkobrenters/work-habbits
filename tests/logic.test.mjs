import test from 'node:test';
import assert from 'node:assert/strict';
import {SETTINGS, WellnessModel, deskState, isFreshHeartbeat, isLocalDesktop, isLocalSession,
    preferencesProblem, preferencesOf, configure} from '../extension/logic.js';

const now = 1_000_000;
const tick = (model, overrides = {}, cfg = SETTINGS) => model.update({dt: 1, wallMs: now, localActive: true,
    deskReady: true, position: 'sitting', idleSeconds: 0, inputAvailable: true, ...overrides}, cfg);
const batch = (overrides = {}) => ({keys: 1, clicks: 2, moves: 3, lastInputWallMs: now, ...overrides});
const W = () => SETTINGS.redWindow;

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

test('seated thresholds, partial stands, full stand and return to sitting form a complete flow', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedDue - 1});
    tick(model);
    assert.equal(model.deskColor(true), 'orange');
    model.seated = SETTINGS.seatedLate;
    assert.equal(model.deskColor(true), 'red');
    tick(model, {position: 'standing'});
    tick(model, {position: 'sitting', idleSeconds: 999});
    assert.equal(model.standingRun, 0);
    assert.equal(model.seated, SETTINGS.seatedLate);
    model.standingRun = SETTINGS.standRequired - 1;
    tick(model, {position: 'standing', idleSeconds: 999});
    assert.equal(model.standComplete, true);
    assert.equal(model.seated, 0);
    assert.equal(model.deskColor(true), 'orange');
    model.standingRun = SETTINGS.standLate;
    assert.equal(model.deskColor(true), 'red');
    tick(model, {position: 'sitting'});
    assert.equal(model.standComplete, false);
    assert.equal(model.standingRun, 0);
    assert.equal(model.deskColor(false), 'gray');
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
    tick(model, {wallMs: now + 119999, idleSeconds: 0});
    assert.equal(model.input, SETTINGS.inputLate);
    tick(model, {wallMs: now + 120000, idleSeconds: 0});
    assert.equal(model.input, 0);
    model.input = 100;
    model.onInputBatch(batch({lastInputWallMs: now + 120000, hadBreak: true}));
    assert.equal(model.input, 0);
    assert.equal(model.keys, 2);
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
    const prefs = {'seated-due': 60, 'seated-grace': 5, 'stand-required': 10, 'stand-grace': 5,
        'input-due': 20, 'input-grace': 1, 'input-break': 3, 'desk-sit': 75, 'desk-stand': 110,
        'red-window': 10, 'score-days': 14};
    const original = {...SETTINGS};
    configure(prefs);
    assert.deepEqual([SETTINGS.seatedDue, SETTINGS.standLate, SETTINGS.inputResetIdle, SETTINGS.deskSitCm], [3600, 900, 180, 75]);
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
    tick(timely, {position: 'standing', idleSeconds: 999});
    tick(timely, {position: 'sitting'});
    assert.equal(timely.heeded, 3);
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
    for (const overrides of [{localActive: false}, {idleSeconds: SETTINGS.snoozeAway},
        {localActive: false, deskReady: false}]) {
        const model = new WellnessModel({seated: SETTINGS.seatedLate + SETTINGS.redWindow / 2, missed: 1,
            lastInputWallMs: now});
        model.lastPosition = 'sitting';
        model.snooze(now);
        assert.equal(model.missed, 0, 'Snooze takes back the penalty already charged');
        tick(model, {wallMs: now + 3600000, ...overrides});
        assert.equal(model.missed, 0);
        assert.equal(model.snoozes.seated.state, 'forgiven');
    }
});

test('standing and hands snoozes use their configured duration and break clears them', () => {
    const standing = new WellnessModel({standingRun: SETTINGS.standRequired, standComplete: true});
    standing.lastPosition = 'standing';
    assert.deepEqual(standing.snooze(now), ['stand']);
    assert.equal(standing.snoozes.stand.until, now + SETTINGS.standSnooze * 1000);
    tick(standing);
    assert.equal(standing.snoozes.stand, undefined);
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
    model.seated = SETTINGS.seatedLate + W() / 2 - 1;
    tick(model);
    assert.equal(model.missed, 1);
    model.seated = SETTINGS.seatedLate + W() - 1;
    tick(model);
    assert.deepEqual([model.missed, model.seated, model.deskColor(true)], [2, 0, 'green']);
});

test('an ignored reminder never charges more than two per round', () => {
    const cfg = {...SETTINGS, seatedDue: 4, seatedLate: 6, redWindow: 4};
    const model = new WellnessModel();
    for (let i = 0; i < 20; i++) tick(model, {}, cfg);
    assert.deepEqual([model.missed, model.seated], [4, 0]);
});

test('hands and the sit-down reminder reset their own timer; a reset stand earns no point', () => {
    const hands = new WellnessModel({input: SETTINGS.inputLate + W() - 1, missed: 1, lastInputWallMs: now});
    tick(hands);
    assert.deepEqual([hands.missed, hands.input], [2, 0]);
    const stand = new WellnessModel({standingRun: SETTINGS.standLate + W() - 1, standComplete: true, missed: 1, heeded: 1});
    tick(stand, {position: 'standing'});
    assert.deepEqual([stand.missed, stand.standingRun, stand.standComplete, stand.deskColor(true)], [2, 0, true, 'green']);
    assert.deepEqual(stand.snoozable(), []);
    tick(stand, {position: 'sitting'});
    assert.equal(stand.heeded, 1, 'Sitting after a reset earns no point');
});

test('a change before red earns a point; in red before the first penalty it is neutral', () => {
    const early = new WellnessModel({seated: SETTINGS.seatedLate - 1, standingRun: SETTINGS.standRequired - 1});
    tick(early, {position: 'standing', idleSeconds: 999});
    assert.equal(early.heeded, 1);
    const red = new WellnessModel({seated: SETTINGS.seatedLate - 1});
    tick(red);
    red.standingRun = SETTINGS.standRequired - 1;
    tick(red, {position: 'standing', idleSeconds: 999});
    assert.deepEqual([red.heeded, red.missed], [0, 0]);
    const hands = new WellnessModel({input: SETTINGS.inputLate - 1, lastInputWallMs: now});
    tick(hands);
    tick(hands, {idleSeconds: SETTINGS.inputResetIdle});
    assert.deepEqual([hands.heeded, hands.missed, hands.input], [0, 0, 0]);
});

test('idle and locked time never advance the red window', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate + W() / 2 - 1});
    tick(model, {idleSeconds: SETTINGS.postureActiveWindow});
    tick(model, {localActive: false});
    assert.deepEqual([model.missed, model.seated], [0, SETTINGS.seatedLate + W() / 2 - 1]);
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
    const model = new WellnessModel({seated: SETTINGS.seatedLate + W() / 2, missed: 1});
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
    const model = new WellnessModel({seated: SETTINGS.seatedLate + W() + 5, missed: 3,
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
    const model = new WellnessModel({seated: 1800, input: 750, lastInputWallMs: now});
    tick(model, {dt: 0});
    const view = (overrides = {}) => model.gauges({desk: true, input: true, idleSeconds: 0, handsIdle: 0, ...overrides});
    assert.deepEqual(view().posture, {color: 'green', blink: null, fraction: 0.25, seconds: 5400});
    assert.deepEqual(view().hands, {color: 'green', blink: null, fraction: 0.5, seconds: 750});
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
    assert.deepEqual(view({handsIdle: 30}).hands, {color: 'green', blink: null, fraction: 1, seconds: 90});
    assert.deepEqual(view({desk: false, input: false}),
        {posture: {color: 'gray', blink: null, fraction: 0, seconds: null}, hands: {color: 'gray', blink: null, fraction: 0, seconds: null}});
    const standing = new WellnessModel({standingRun: 300});
    tick(standing, {position: 'standing', dt: 0});
    assert.deepEqual(standing.gauges({desk: true, input: false, idleSeconds: 0, handsIdle: 0}).posture,
        {color: 'green', blink: null, fraction: 0.25, seconds: 900});
});

test('red reminders follow the round, not idle pauses, and leave out snoozed ones', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate, input: SETTINGS.inputLate, lastInputWallMs: now});
    tick(model, {dt: 0});
    const red = (overrides = {}) => model.redReminders({active: true, idleSeconds: 0, handsIdle: 0, ...overrides});
    assert.deepEqual(red(), [{name: 'seated', active: true}, {name: 'input', active: true}]);
    assert.deepEqual(red({idleSeconds: SETTINGS.postureActiveWindow, handsIdle: 12}),
        [{name: 'seated', active: false}, {name: 'input', active: false}], 'A pause keeps the round red but inactive');
    assert.deepEqual(red({active: false}).map(reminder => reminder.active), [false, false]);
    model.snooze(now);
    assert.deepEqual(red().map(reminder => reminder.name), [], 'Snoozed reminders are silent');
    model.wallMs = now + SETTINGS.inputSnooze * 1000;
    assert.deepEqual(red().map(reminder => reminder.name), ['input'], 'A run-out snooze is red again');
});
