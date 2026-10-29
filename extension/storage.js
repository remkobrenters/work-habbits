import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {DailyHistory, validRecord} from './history.js';

function readJSON(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        return ok ? JSON.parse(new TextDecoder().decode(contents)) : null;
    } catch (_error) {
        return null;
    }
}

export class HistoryStore {
    constructor(stateDir) {
        this.directory = GLib.build_filenamev([stateDir, 'days']);
        this.history = new DailyHistory();
        this.warnings = [];
        this.blockedDates = new Set();
        this.readFailed = false;
        this.error = '';
        this.pending = new Map();
        const directory = Gio.File.new_for_path(this.directory);
        if (directory.query_exists(null)) {
            let entries = null;
            try {
                entries = directory.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let entry;
                while ((entry = entries.next_file(null))) {
                    const name = entry.get_name();
                    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) continue;
                    const record = readJSON(GLib.build_filenamev([this.directory, name]));
                    if (validRecord(record) && `${record.date}.json` === name) {
                        this.history.set(record);
                    } else {
                        this.blockedDates.add(name.slice(0, 10));
                        this.warnings.push(name);
                    }
                }
            } catch (error) {
                // Fail closed if existing records could not be inspected.
                this.readFailed = true;
                this.warnings.push(error.message);
            } finally {
                entries?.close(null);
            }
        }
        if (this.warnings.length)
            console.error(`work-habbits: unreadable history preserved: ${this.warnings.join(', ')}`);
    }

    save(record) {
        this.history.set(record);
        this.pending.set(record.date, record);
        if (this.readFailed) return false;
        this.error = '';
        for (const [date, pending] of this.pending) {
            // Unsupported/corrupt files are kept untouched for manual recovery.
            if (this.blockedDates.has(date)) continue;
            try {
                GLib.mkdir_with_parents(this.directory, 0o700);
                Gio.File.new_for_path(GLib.build_filenamev([this.directory, `${date}.json`]))
                    .replace_contents(new TextEncoder().encode(`${JSON.stringify(pending, null, 2)}\n`),
                        null, false, Gio.FileCreateFlags.PRIVATE, null);
                this.pending.delete(date);
            } catch (error) {
                this.error = error.message;
                console.error(`work-habbits: could not save ${date}: ${error.message}`);
                // Keep the full snapshot and retry, including after day rollover.
            }
        }
        return this.pending.size === 0;
    }
}
