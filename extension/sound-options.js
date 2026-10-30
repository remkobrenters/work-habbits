// Bundled reminder sounds and how often one repeats while a reminder is red.
export const SOUND_EFFECTS = [
    {name: 'Notification 1', file: 'notification_1.mp3'},
    {name: 'Notification 2', file: 'notification_2.mp3'},
    {name: 'Notification 3', file: 'notification_3.mp3'},
];

export const SOUND_REPEATS = [
    {seconds: 0, name: 'Once'},
    {seconds: 15, name: 'Every 15 seconds'},
    {seconds: 30, name: 'Every 30 seconds'},
    {seconds: 60, name: 'Every minute'},
];

export function soundFile(effect, extensionPath) {
    const selected = SOUND_EFFECTS[effect - 1] ?? SOUND_EFFECTS[SOUND_EFFECTS.length - 1];
    return `${extensionPath}/sounds/${selected.file}`;
}

// gst-play-1.0 arguments; volume is a percentage applied as a soft volume.
export function playerArgs(player, uri, volume) {
    return [player, '--quiet', '--no-interactive', '--flags=audio+soft-volume', `--volume=${volume / 100}`, uri];
}

// Chimes when a reminder turns red, then once per repeat interval while the user is active for a red
// reminder. A pause keeps the episode: coming back waits for the interval and never repeats "once".
// Returns 'play', 'stop' when the sound should be silent, or null to let a playing sound finish.
export class ChimeSchedule {
    constructor() {
        this._red = new Set();
        this._allowed = false;
        this._pending = false;
        this._last = -Infinity;
    }

    update({red, allowed, repeatSeconds, nowSeconds}) {
        if (red.some(reminder => !this._red.has(reminder.name))) this._pending = true;
        if (allowed && !this._allowed && repeatSeconds > 0) this._pending = true;
        this._red = new Set(red.map(reminder => reminder.name));
        this._allowed = allowed;
        if (!allowed || !red.some(reminder => reminder.active)) return 'stop';
        if (!this._pending && (!repeatSeconds || nowSeconds - this._last < repeatSeconds)) return null;
        this._pending = false;
        this._last = nowSeconds;
        return 'play';
    }
}
