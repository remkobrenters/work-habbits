import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SETTINGS, configure, preferencesOf, preferencesProblem, deskState} from '../extension/logic.js';

const root = GLib.dir_make_tmp('work-habbits-settings-XXXXXX');
const file = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent()
    .get_child('extension/schemas/org.gnome.shell.extensions.work-habbits.gschema.xml');
try {
    file.copy(Gio.File.new_for_path(`${root}/${file.get_basename()}`), Gio.FileCopyFlags.NONE, null, null);
    Gio.Subprocess.new(['glib-compile-schemas', '--strict', root], Gio.SubprocessFlags.NONE).wait_check(null);
    GLib.setenv('GSETTINGS_BACKEND', 'memory', true);
    const source = Gio.SettingsSchemaSource.new_from_directory(root, Gio.SettingsSchemaSource.get_default(), false);
    const settings = new Gio.Settings({settings_schema: source.lookup('org.gnome.shell.extensions.work-habbits', false)});
    const assert = (value, message) => { if (!value) throw new Error(message); };
    assert(settings.get_string('desk-mode') === 'manual', 'New installations never connect to a desk');
    assert(settings.get_string('desk-device') === '', 'No personal device is distributed');
    assert(preferencesProblem(preferencesOf(settings)) === null, 'Defaults are internally consistent');
    assert(settings.get_uint('red-window') === 10 && settings.get_uint('seated-grace') === 2, 'Bounded red window defaults');
    assert(!settings.settings_schema.has_key('seated-repeat'), 'Unbounded miss intervals are gone');
    const original = {...SETTINGS};
    configure(preferencesOf(settings));
    assert(JSON.stringify(SETTINGS) === JSON.stringify(original), 'Schema and logic defaults agree');
    settings.set_string('desk-mode', 'manual');
    settings.set_string('manual-position', 'standing');
    assert(deskState(settings.get_string('desk-mode'), settings.get_string('manual-position'), null, 0).position === 'standing',
        'Manual posture comes from the shared settings');
    settings.set_uint('input-break', 3);
    configure(preferencesOf(settings));
    assert(SETTINGS.inputResetIdle === 180, 'Settings affect the real reminder model');
    print('ok: real schema defaults, safe desk mode, manual posture and configurable reminders');
} finally {
    for (const name of [file.get_basename(), 'gschemas.compiled'])
        Gio.File.new_for_path(`${root}/${name}`).delete(null);
    Gio.File.new_for_path(root).delete(null);
}
