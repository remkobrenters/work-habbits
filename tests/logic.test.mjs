import test from 'node:test';
import assert from 'node:assert/strict';
import {SETTINGS, WellnessModel, deskState, isFreshHeartbeat, isLocalDesktop, isLocalSession,
    preferencesProblem, preferencesOf, configure} from '../extension/logic.js';

const now = 1_000_000;
const tick = (model, overrides = {}, cfg = SETTINGS) => model.update({dt: 1, wallMs: now, localActive: true,
    deskReady: true, position: 'sitting', idleSeconds: 0, inputAvailable: true, ...overrides}, cfg);
const batch = (overrides = {}) => ({keys: 1, clicks: 2, moves: 3, lastInputWallMs: now, ...overrides});

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

test('countdown selects due reminders before future deadlines and counts hand rest down', () => {
    const model = new WellnessModel({seated: 7190, input: 1500, standingRun: 100, lastInputWallMs: now});
    tick(model, {idleSeconds: 11});
    assert.deepEqual(model.countdown({desk: true, input: true, idleSeconds: 11}),
        {icon: 'input', due: true, seconds: 109});
    assert.equal(model.countdown({desk: false, input: false, idleSeconds: 0}), null);
    tick(model, {position: 'standing'});
    assert.equal(model.countdown({desk: true, input: false}).seconds, 1199);
    model.standComplete = true;
    model.standingRun = 1200;
    assert.equal(model.countdown({desk: true, input: false}).seconds, 300);
    tick(model);
    model.seated = 7200;
    assert.equal(model.countdown({desk: true, input: false}).seconds, 1200);
});

test('configuration validates heights and device addresses and converts minutes to seconds', () => {
    assert.match(preferencesProblem({'desk-sit': 112, 'desk-stand': 80}), /sitting height/);
    assert.match(preferencesProblem({'desk-device': 'not a device'}), /Bluetooth address/);
    assert.equal(preferencesProblem({'desk-sit': 80, 'desk-stand': 112, 'desk-device': 'aa:bb:cc:dd:ee:ff'}), null);
    const prefs = {'seated-due': 60, 'seated-grace': 5, 'stand-required': 10, 'stand-grace': 5,
        'input-due': 20, 'input-grace': 1, 'input-break': 3, 'desk-sit': 75, 'desk-stand': 110,
        'seated-repeat': 30, 'stand-repeat': 15, 'input-repeat': 15, 'score-days': 14};
    const original = {...SETTINGS};
    configure(prefs);
    assert.deepEqual([SETTINGS.seatedDue, SETTINGS.standLate, SETTINGS.inputResetIdle, SETTINGS.deskSitCm], [3600, 900, 180, 75]);
    Object.assign(SETTINGS, original);
    assert.deepEqual(preferencesOf({settings_schema: {list_keys: () => ['desk-mode']},
        get_value: () => ({deep_unpack: () => 'manual'})}), {'desk-mode': 'manual'});
});

test('habit score rewards timely hand rest and full posture breaks, counts repeated misses without replay on restart', () => {
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
    assert.equal(late.missed, 2);
    const restored = new WellnessModel(late.serialize('2026-10-29'));
    tick(restored);
    assert.equal(restored.missed, 2);
    restored.seated = SETTINGS.seatedLate + SETTINGS.seatedRepeat - 1;
    tick(restored);
    assert.equal(restored.missed, 3);
    tick(restored, {idleSeconds: SETTINGS.inputResetIdle});
    assert.equal(restored.heeded, 0, 'Late hand rest clears the timer without earning a timely-break point');
    restored.resetPosture();
    assert.equal(restored.seated, 0);
    assert.equal(restored.standComplete, false);
    assert.equal(restored.missed, 3, 'Switching desk mode preserves earned daily score');
});

test('countdown urgency blinks near deadlines, becomes red after 30 active seconds and stops while paused', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedDue - 11, input: SETTINGS.inputDue - 10});
    model.lastPosition = 'sitting';
    assert.deepEqual(model.reminderUrgency({desk: true, input: true}), {desk: null, input: 'near'});
    model.seated++;
    assert.equal(model.reminderUrgency({desk: true}).desk, 'near');
    model.seated = SETTINGS.seatedDue + 30;
    assert.equal(model.reminderUrgency({desk: true}).desk, 'due');
    assert.deepEqual(model.reminderUrgency({desk: false, input: false}), {desk: null, input: null});
    model.lastPosition = 'away';
    model.standingRun = SETTINGS.standRequired;
    assert.equal(model.reminderUrgency({desk: true}).desk, 'near');
});

test('snoozes hold red misses, persist and charge once after active grace', async () => {
    const {dailyRecord, modelState} = await import('../extension/history.js');
    const cfg = {...SETTINGS, seatedSnooze: 2, seatedDue: 2, seatedLate: 4, seatedRepeat: 10};
    const model = new WellnessModel();
    tick(model, {dt: 2}, cfg);
    assert.deepEqual(model.snooze(now, cfg), ['seated']);
    assert.deepEqual(model.snooze(now, cfg), []);
    tick(model, {dt: 2, wallMs: now + 2000}, cfg);
    assert.equal(model.missed, 2);
    assert.equal(model.snoozes.seated.state, 'broken');
    assert.equal(model.snoozes.seated.charged, 2);
    const stored = dailyRecord(model.serialize('2026-10-29'));
    const restored = new WellnessModel(modelState(stored));
    assert.deepEqual(restored.snoozes, model.snoozes);
    tick(model, {wallMs: now + 3000}, cfg);
    assert.equal(model.missed, 2, 'Already charged held misses cannot replay');
});

test('locking, leaving and prolonged inactivity forgive snoozes without penalty', () => {
    for (const overrides of [{localActive: false}, {idleSeconds: SETTINGS.snoozeAway},
        {localActive: false, deskReady: false}]) {
        const model = new WellnessModel({seated: SETTINGS.seatedLate, missed: 1, lastInputWallMs: now});
        model.lastPosition = 'sitting';
        model.snooze(now);
        assert.equal(model.missed, 0, 'Snooze holds the existing red miss');
        tick(model, {wallMs: now + 3600000, ...overrides});
        assert.equal(model.missed, 0);
        assert.equal(model.snoozes.seated.state, 'forgiven');
        assert.equal(model.snoozes.seated.grace, 0);
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

test('snoozed countdown shows time left and suppresses blinking', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate, missed: 1, lastInputWallMs: now});
    model.lastPosition = 'sitting';
    model.snooze(now);
    model.wallMs = now;
    assert.equal(model.countdown({desk: true, input: false}).seconds, SETTINGS.seatedSnooze);
    assert.equal(model.reminderUrgency({desk: true, input: false}).desk, null);
    assert.equal(model.deskColor(true), 'orange');
});
