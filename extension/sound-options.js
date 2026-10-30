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

// Chimes when a reminder turns red, then once per repeat interval while the user is active for a red
// reminder. A pause keeps the episode: coming back waits for the interval and never repeats "once".
export class ChimeSchedule {
    constructor() {
        this._red = new Set();
        this._allowed = false;
        this._pending = false;
        this._chimed = false;
        this._last = -Infinity;
    }

    update({red, allowed, repeatSeconds, nowSeconds}) {
        const names = new Set(red.map(reminder => reminder.name));
        if (!names.size) this._pending = this._chimed = false;
        if (red.some(reminder => !this._red.has(reminder.name))) this._pending = true;
        if (allowed && !this._allowed && (!this._chimed || repeatSeconds > 0)) this._pending = true;
        this._red = names;
        this._allowed = allowed;
        if (!allowed || !red.some(reminder => reminder.active)) return false;
        if (!this._pending && (!repeatSeconds || nowSeconds - this._last < repeatSeconds)) return false;
        this._pending = false;
        this._chimed = true;
        this._last = nowSeconds;
        return true;
    }
}
