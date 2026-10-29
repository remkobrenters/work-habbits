import test from 'node:test';
import assert from 'node:assert/strict';
import {DailyHistory, dailyRecord, modelState, periodStarts, validDate, validRecord,
    formatHours, formatCount, formatTimer} from '../extension/history.js';
import {WellnessModel} from '../extension/logic.js';
const record = (date, seconds = 100) => dailyRecord({date, todaySitting: seconds, todayStanding: 20, todayAway: 10,
    keys: 5, clicks: 3, moves: 1, seated: 100, standingRun: 500, input: 10, lastInputWallMs: 1000});

test('calendar periods handle Monday, year boundaries, DST and leap years in the desktop timezone', () => {
    assert.deepEqual(periodStarts('2026-11-01'), {today: '2026-11-01', week: '2026-10-26', month: '2026-11-01'});
    assert.equal(periodStarts('2027-01-01').week, '2026-12-28');
    assert.equal(periodStarts('2026-03-29').week, '2026-03-23');
    assert.equal(periodStarts('2026-10-25').week, '2026-10-19');
    assert.equal(periodStarts('2028-02-29').week, '2028-02-28');
    assert.equal(validDate('2026-02-29'), false);
    assert.equal(validDate('1999-01-01'), false);
    assert.equal(validDate(null), false);
    assert.throws(() => periodStarts('2026-02-30'));
});

test('daily snapshots replace previous counts, sum independent periods and exclude future dates', () => {
    const history = new DailyHistory();
    for (const day of ['2026-10-25', '2026-10-26', '2026-10-31', '2026-11-01', '2026-11-02']) history.set(record(day));
    history.set(record('2026-11-01', 200));
    history.set(record('2026-11-01', 200));
    const totals = history.totals('2026-11-01');
    assert.deepEqual([totals.today.sittingSeconds, totals.week.sittingSeconds, totals.month.sittingSeconds], [200, 400, 200]);
    assert.equal(totals.week.keyStrokes, 15);
    assert.equal(totals.today.awaySeconds, 10);
});

test('restart retains aggregates and incomplete standing progress without counting downtime', () => {
    const original = record('2026-10-28');
    const model = new WellnessModel(modelState(JSON.parse(JSON.stringify(original))));
    assert.deepEqual(dailyRecord(model.serialize(original.date)), original);
    assert.deepEqual(Object.keys(original), ['schemaVersion', 'date', 'metrics', 'reminders']);
    model.standingRun = 1199;
    const restored = new WellnessModel(modelState(dailyRecord(model.serialize(original.date))));
    restored.update({dt: 1, wallMs: 1000000, localActive: true, deskReady: true, position: 'standing', idleSeconds: 999});
    assert.equal(restored.standComplete, true);
    assert.equal(restored.seated, 0);
});

test('invalid dates, negative metrics, unsupported versions and corrupt records cannot enter history', () => {
    const good = record('2026-10-28');
    const history = new DailyHistory();
    for (const bad of [null, {...good, schemaVersion: 99}, {...good, date: '../file'},
        {...good, metrics: {...good.metrics, keyStrokes: -1}}, {...good, metrics: {}}]) {
        assert.equal(validRecord(bad), false);
        assert.equal(modelState(bad), null);
        assert.throws(() => history.set(bad));
    }
    assert.throws(() => dailyRecord({date: 'invalid'}));
    assert.equal(dailyRecord({date: good.date, keys: -1}).metrics.keyStrokes, 0);
});

test('display formats handle empty, fractional, negative and non-finite values', () => {
    assert.equal(formatHours(16200), '4.5 h');
    assert.equal(formatHours(NaN), '0.0 h');
    assert.equal(formatCount(12.4), '12');
    assert.equal(formatTimer(59.2), '1:00');
    assert.equal(formatTimer(4325), '1:12:05');
    assert.equal(formatTimer(-1), '0:00');
    assert.equal(formatTimer(Infinity), '0:00');
});

test('habit score graph uses the latest active days and accepts omitted optional outcomes', () => {
    const history = new DailyHistory();
    for (let day = 1; day <= 20; day++) history.set(dailyRecord({date: `2026-10-${String(day).padStart(2, '0')}`,
        heeded: day <= 6 ? 0 : 3, missed: day <= 6 ? 10 : 1}));
    history.set(dailyRecord({date: '2026-10-21'}));
    history.set(dailyRecord({date: '2026-10-30', heeded: 100}));
    assert.deepEqual(history.habitScore('2026-10-29'), {days: 14, heeded: 42, missed: 14, score: 0.75});
    const old = record('2026-10-29');
    delete old.metrics.remindersHeeded;
    delete old.metrics.remindersMissed;
    assert.equal(validRecord(old), true);
    assert.equal(new WellnessModel(modelState(old)).heeded, 0);
    const snapshot = dailyRecord({date: '2026-10-29', heeded: 3, missed: 1});
    const model = new WellnessModel(modelState(snapshot));
    assert.deepEqual([model.heeded, model.missed], [3, 1]);
    assert.equal(new DailyHistory().habitScore('2026-10-29').score, null);
});
