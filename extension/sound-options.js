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

// Chimes when a reminder turns red while sound is allowed, then once per repeat interval.
export class ChimeSchedule {
    constructor() {
        this._armed = false;
        this._last = -Infinity;
    }

    update({red, allowed, repeatSeconds, nowSeconds}) {
        const armed = red && allowed;
        const due = armed && (!this._armed || (repeatSeconds > 0 && nowSeconds - this._last >= repeatSeconds));
        this._armed = armed;
        if (due) this._last = nowSeconds;
        return due;
    }
}
