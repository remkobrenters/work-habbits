import test from 'node:test';
import assert from 'node:assert/strict';
import {ChimeSchedule, SOUND_EFFECTS, SOUND_REPEATS, soundFile} from '../extension/sound-options.js';

const run = (schedule, steps) => steps.map(([nowSeconds, red, allowed = true, repeatSeconds = 15]) =>
    schedule.update({red, allowed, repeatSeconds, nowSeconds}));

test('chimes on entering red, then every interval, and again at once after leaving red', () => {
    assert.deepEqual(run(new ChimeSchedule(), [[0, false], [1, true], [2, true], [15, true], [16, true], [30, true],
        [32, false], [33, true]]), [false, true, false, false, true, false, false, true]);
});

test('once means only on entering red', () => {
    assert.deepEqual(run(new ChimeSchedule(), [[0, true, true, 0], [100, true, true, 0]]), [true, false]);
});

test('muted while not allowed; becoming allowed in red chimes at once', () => {
    assert.deepEqual(run(new ChimeSchedule(), [[0, true, false], [20, true, false], [21, true, true], [22, true, false]]),
        [false, false, true, false]);
});

test('sound choices and files', () => {
    assert.deepEqual(SOUND_EFFECTS.map(sound => sound.name), ['Notification 1', 'Notification 2', 'Notification 3']);
    assert.deepEqual(SOUND_REPEATS.map(option => option.seconds), [0, 15, 30, 60]);
    assert.equal(soundFile(1, '/ext'), '/ext/sounds/notification_1.mp3');
    assert.equal(soundFile(9, '/ext'), '/ext/sounds/notification_3.mp3');
});
