import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {playerArgs, soundFile} from './sound-options.js';

// Plays a bundled reminder sound with gst-play-1.0. Problems are reported, never thrown.
export class Sound {
    constructor(extensionPath, onError) {
        this._extensionPath = extensionPath;
        this._onError = onError;
        this._process = null;
        this._timer = null;
    }

    // Volume is a percentage; 0 is silent and starts nothing.
    play(effect, volume) {
        if (!volume) return;
        try {
            const player = GLib.find_program_in_path('gst-play-1.0');
            if (!player) throw new Error('Reminder sounds need gstreamer1.0-plugins-base-apps.');
            const path = soundFile(effect, this._extensionPath);
            if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR))
                throw new Error('Reminder sound file is missing; run ./install.sh again.');
            this.stop();
            const process = Gio.Subprocess.new(playerArgs(player, Gio.File.new_for_path(path).get_uri(), volume),
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._process = process;
            this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 15, () => {
                this._timer = null;
                this.stop();
                return GLib.SOURCE_REMOVE;
            });
            process.wait_check_async(null, (source, result) => {
                let failed = false;
                try {
                    source.wait_check_finish(result);
                } catch {
                    failed = true;
                }
                // A sound stopped on purpose is not a failure.
                if (this._process !== source) return;
                this._process = null;
                this.stop();
                if (failed) this._onError('Could not play the reminder sound. Check the output device.');
            });
        } catch (error) {
            this._onError(error.message);
        }
    }

    stop() {
        if (this._timer) GLib.Source.remove(this._timer);
        this._timer = null;
        this._process?.force_exit();
        this._process = null;
    }
}
