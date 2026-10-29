// Run with: gjs -m tests/storage.test.js
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {HistoryStore} from '../extension/storage.js';
import {dailyRecord} from '../extension/history.js';

function assert(value, message) {
    if (!value) throw new Error(message);
}
function read(path) {
    return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
}
function record(date, keys = 10) {
    return dailyRecord({date, todaySitting: 3600, todayStanding: 1200, keys, clicks: 3});
}
function remove(file) {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) === Gio.FileType.DIRECTORY) {
        const entries = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let entry;
        while ((entry = entries.next_file(null))) remove(file.get_child(entry.get_name()));
        entries.close(null);
    }
    file.delete(null);
}
const root = GLib.dir_make_tmp('work-habbits-tests-XXXXXX');
try {
    const state = `${root}/state`;
    const store = new HistoryStore(state);
    assert(store.save(record('2026-10-25')), 'Save first day');
    assert(store.save(record('2026-10-26')), 'Save next day');
    assert(store.save(record('2026-10-26', 25)), 'Checkpoint replaces snapshot');
    const restored = new HistoryStore(state);
    assert(restored.history.days.size === 2, 'Restart keeps old days');
    assert(restored.history.totals('2026-10-26').month.keyStrokes === 35, 'No double counting on disk');
    const file = Gio.File.new_for_path(`${state}/days/2026-10-26.json`);
    assert((file.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode') & 0o777) === 0o600,
        'Daily records are owner-only');
    assert(read(`${state}/days/2026-10-26.json`).includes('\n  "metrics": {'), 'Records are readable pretty JSON');
    print('ok: daily persistence, restart, replacement, private readable files');

    const corrupt = `${state}/days/2026-10-26.json`;
    GLib.file_set_contents(corrupt, '{broken json');
    const protectedStore = new HistoryStore(state);
    assert(protectedStore.warnings.length === 1, 'Corruption is reported');
    assert(!protectedStore.save(record('2026-10-26', 999)), 'Refuse overwriting unreadable records');
    assert(read(corrupt) === '{broken json', 'Corrupt original remains available for recovery');
    protectedStore.save(record('2026-10-27'));
    assert(Gio.File.new_for_path(`${state}/days/2026-10-27.json`).query_exists(null), 'Other dates still save');
    print('ok: corruption remains visible and originals are not overwritten');

    const blocked = `${root}/blocked`;
    GLib.file_set_contents(blocked, 'not a directory');
    const retrying = new HistoryStore(blocked);
    assert(!retrying.save(record('2026-10-25')), 'Failed save is reported');
    Gio.File.new_for_path(blocked).delete(null);
    assert(retrying.save(record('2026-10-26')), 'Next checkpoint retries the previous day');
    assert(new HistoryStore(blocked).history.days.size === 2, 'Retry retains both sides of midnight');
    print('ok: failed writes survive day rollover and retry without duplication');
} finally {
    remove(Gio.File.new_for_path(root));
}
