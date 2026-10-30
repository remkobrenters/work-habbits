import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {preferencesOf, preferencesProblem} from './logic.js';

export default class WorkHabbitsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'work-habbits', icon_name: 'preferences-system-symbolic'});
        window.add(page);
        const general = new Adw.PreferencesGroup({title: 'Tracking',
            description: 'Posture reminders on Xorg or Wayland. Keyboard/mouse counts require Xorg. Turning tracking off pauses input collection, posture timers, reminders and the Bluetooth helper. History is kept.'});
        page.add(general);
        for (const [key, title] of [['tracking-enabled', 'Enable tracking'], ['notifications-enabled', 'Show reminder notifications']]) {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            general.add(row);
        }
        const desk = new Adw.PreferencesGroup({title: 'Desk', description:
            'Bluetooth: TiMOTION TWD1 / Nordic UART only. Manual: mark sitting or standing yourself. ' +
            'Disabled: use the menu to mark movement breaks with a fixed desk.'});
        page.add(desk);
        const modes = ['manual', 'disabled', 'bluetooth'];
        const mode = new Adw.ComboRow({title: 'Desk movement',
            model: Gtk.StringList.new(['Manual', 'Disabled (fixed desk)', 'Bluetooth (TWD1)']),
            selected: modes.indexOf(settings.get_string('desk-mode'))});
        mode.connect('notify::selected', () => settings.set_string('desk-mode', modes[mode.selected]));
        desk.add(mode);
        const device = new Adw.EntryRow({title: 'Bluetooth device address', show_apply_button: true,
            text: settings.get_string('desk-device')});
        device.connect('apply', () => {
            const value = device.text.trim().toUpperCase();
            const problem = preferencesProblem({...preferencesOf(settings), 'desk-device': value});
            if (problem) window.add_toast(new Adw.Toast({title: problem}));
            else settings.set_string('desk-device', value);
        });
        desk.add(device);
        const groups = [
            [desk, [['desk-sit', 'Sitting height (cm)'], ['desk-stand', 'Standing height (cm)']]],
            [new Adw.PreferencesGroup({title: 'Posture reminders (minutes)'}), [
                ['seated-due', 'Stand or take a walk after'], ['seated-grace', 'Orange warning before red (stand up)'],
                ['stand-required', 'Standing / movement break length'], ['stand-grace', 'Orange warning before red (sit down)']]],
            [new Adw.PreferencesGroup({title: 'Hand reminders (minutes)'}), [
                ['input-due', 'Hand break after active input'], ['input-grace', 'Orange warning before red'],
                ['input-break', 'Continuous rest to reset the timer']]],
            [new Adw.PreferencesGroup({title: 'Snooze — leaving soon'}), [
                ['seated-snooze', 'Snooze standing reminders (minutes)'], ['stand-snooze', 'Snooze sitting reminders (minutes)'],
                ['input-snooze', 'Snooze hand reminders (minutes)'], ['snooze-away', 'Idle minutes to forgive snoozes'],
                ['snooze-penalty', 'Continued work penalty multiplier']]],
            [new Adw.PreferencesGroup({title: 'Habit score', description:
                'In red, a penalty counts halfway and at the end of this window; then the timer starts a new round.'}), [
                ['score-days', 'Active days in the score'], ['red-window', 'Red warning window']]],
        ];
        for (const [group, rows] of groups) {
            if (group !== desk) page.add(group);
            for (const [key, title] of rows) {
                const [min, max] = settings.settings_schema.get_key(key).get_range().recursiveUnpack()[1];
                const row = new Adw.SpinRow({title, digits: 0,
                    adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1, page_increment: 5,
                        value: settings.get_uint(key)})});
                row.connect('notify::value', () => {
                    const value = Math.round(row.value);
                    const problem = preferencesProblem({...preferencesOf(settings), [key]: value});
                    if (problem) {
                        row.value = settings.get_uint(key);
                        window.add_toast(new Adw.Toast({title: problem}));
                    } else settings.set_uint(key, value);
                });
                group.add(row);
            }
        }
        const reset = new Adw.PreferencesGroup();
        const button = new Gtk.Button({label: 'Reset to defaults', halign: Gtk.Align.START});
        button.connect('clicked', () => {
            for (const key of settings.settings_schema.list_keys()) settings.reset(key);
            window.close();
        });
        reset.add(button);
        page.add(reset);
        const project = new Adw.PreferencesGroup();
        project.add(new Gtk.Label({
            label: '<a href="https://github.com/remkobrenters/work-habbits">View repository</a>',
            use_markup: true,
            xalign: 0,
            halign: Gtk.Align.START,
        }));
        page.add(project);
    }
}
