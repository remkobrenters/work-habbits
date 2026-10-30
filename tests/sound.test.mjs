import test from 'node:test';
import assert from 'node:assert/strict';
import {ChimeSchedule, SOUND_EFFECTS, SOUND_REPEATS, playerArgs, soundFile} from '../extension/sound-options.js';

// Each step: [seconds, red reminders as {name: active}, allowed, repeat seconds].
const run = (schedule, steps) => steps.map(([nowSeconds, red, allowed = true, repeatSeconds = 15]) =>
    schedule.update({red: Object.entries(red).map(([name, active]) => ({name, active})), allowed, repeatSeconds,
        nowSeconds}) === 'play');
const typing = {input: true};
const paused = {input: false};

test('chimes on entering red, then every interval, and again at once after leaving red', () => {
    assert.deepEqual(run(new ChimeSchedule(), [[0, {}], [1, typing], [2, typing], [15, typing], [16, typing], [30, typing],
        [32, {}], [33, typing]]), [false, true, false, false, true, false, false, true]);
});

test('a typing pause in red does not restart the sound: once stays once and intervals hold', () => {
    const burst = (start, repeat) => [[start, typing, true, repeat], [start + 12, paused, true, repeat],
        [start + 20, typing, true, repeat]];
    assert.deepEqual(run(new ChimeSchedule(), [...burst(0, 0), ...burst(30, 0), ...burst(60, 0)]),
        [true, false, false, false, false, false, false, false, false]);
    assert.deepEqual(run(new ChimeSchedule(), [...burst(0, 60), ...burst(30, 60), ...burst(60, 60)]),
        [true, false, false, false, false, false, true, false, false]);
});

test('once means only on entering red; another reminder turning red chimes at once', () => {
    assert.deepEqual(run(new ChimeSchedule(), [[0, typing, true, 0], [100, typing, true, 0],
        [101, {input: true, seated: true}, true, 0]]), [true, false, true]);
});

test('muted while not allowed or while nobody is active; turning sound back on chimes at once', () => {
    assert.deepEqual(run(new ChimeSchedule(), [[0, typing, false], [20, typing, false], [21, typing, true], [22, typing, false],
        [23, paused, true]]), [false, false, true, false, false]);
});

test('silence is explicit: stop when muted or nobody is active, otherwise let a playing sound finish', () => {
    const schedule = new ChimeSchedule();
    const step = (red, allowed = true) => schedule.update({red: Object.entries(red).map(([name, active]) => ({name, active})),
        allowed, repeatSeconds: 15, nowSeconds: 0});
    assert.deepEqual([step(typing), step(typing), step(paused), step(typing, false), step({})],
        ['play', null, 'stop', 'stop', 'stop']);
});

test('sound choices and files', () => {
    assert.deepEqual(SOUND_EFFECTS.map(sound => sound.name), ['Notification 1', 'Notification 2', 'Notification 3']);
    assert.deepEqual(SOUND_REPEATS.map(option => option.seconds), [0, 15, 30, 60]);
    assert.equal(soundFile(1, '/ext'), '/ext/sounds/notification_1.mp3');
    assert.equal(soundFile(9, '/ext'), '/ext/sounds/notification_3.mp3');
});

test('the player gets the configured volume as a soft volume', () => {
    assert.deepEqual(playerArgs('/usr/bin/gst-play-1.0', 'file:///ext/sounds/notification_3.mp3', 70),
        ['/usr/bin/gst-play-1.0', '--quiet', '--no-interactive', '--flags=audio+soft-volume', '--volume=0.7',
            'file:///ext/sounds/notification_3.mp3']);
    assert.equal(playerArgs('gst-play-1.0', 'file:///x.mp3', 100)[4], '--volume=1');
});
