// Daily aggregate records. Durations are seconds, dates use the local timezone.
const METRICS = ['sittingSeconds', 'standingSeconds', 'awaySeconds', 'keyStrokes', 'mouseClicks', 'mouseMovementSamples'];
const SCORE_METRICS = ['remindersHeeded', 'remindersMissed'];
const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : 0;
const pad = value => String(value).padStart(2, '0');
const dateKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    return year >= 2000 && dateKey(new Date(year, month - 1, day, 12)) === value;
}

export function periodStarts(today) {
    if (!validDate(today)) throw new Error('Invalid calendar date');
    const [year, month, day] = today.split('-').map(Number);
    const monday = new Date(year, month - 1, day, 12);
    monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
    return {today, week: dateKey(monday), month: `${today.slice(0, 7)}-01`};
}

export function validRecord(record) {
    const valid = name => Number.isFinite(record.metrics?.[name]) && record.metrics[name] >= 0;
    return record?.schemaVersion === 1 && validDate(record.date) && METRICS.every(valid) &&
        SCORE_METRICS.every(name => record.metrics[name] === undefined || valid(name));
}

export function dailyRecord(state) {
    if (!validDate(state?.date)) throw new Error('Invalid record date');
    return {schemaVersion: 1, date: state.date,
        metrics: {sittingSeconds: nonnegative(state.todaySitting), standingSeconds: nonnegative(state.todayStanding),
            awaySeconds: nonnegative(state.todayAway), keyStrokes: nonnegative(state.keys),
            mouseClicks: nonnegative(state.clicks), mouseMovementSamples: nonnegative(state.moves),
            remindersHeeded: nonnegative(state.heeded), remindersMissed: nonnegative(state.missed)},
        reminders: {seated: nonnegative(state.seated), standingRun: nonnegative(state.standingRun),
            standComplete: state.standComplete === true, input: nonnegative(state.input),
            lastInputWallMs: nonnegative(state.lastInputWallMs)}};
}

export function modelState(record) {
    if (!validRecord(record)) return null;
    return {...record.reminders, todaySitting: record.metrics.sittingSeconds,
        todayStanding: record.metrics.standingSeconds, todayAway: record.metrics.awaySeconds,
        keys: record.metrics.keyStrokes, clicks: record.metrics.mouseClicks, moves: record.metrics.mouseMovementSamples,
        heeded: record.metrics.remindersHeeded ?? 0, missed: record.metrics.remindersMissed ?? 0};
}

export class DailyHistory {
    constructor() {
        this.days = new Map();
    }

    set(record) {
        if (!validRecord(record)) throw new Error('Invalid daily history record');
        this.days.set(record.date, record);
    }

    totals(today) {
        const starts = periodStarts(today);
        const result = Object.fromEntries(['today', 'week', 'month'].map(period =>
            [period, Object.fromEntries(METRICS.map(name => [name, 0]))]));
        for (const [date, record] of this.days) {
            if (date > today) continue;
            for (const period of ['today', 'week', 'month']) {
                if (date < starts[period]) continue;
                for (const name of METRICS) result[period][name] += record.metrics[name];
            }
        }
        return result;
    }

    habitScore(today, count = 14) {
        const recent = [...this.days.values()]
            .filter(({date, metrics}) => date <= today && (metrics.sittingSeconds + metrics.standingSeconds +
                metrics.awaySeconds + metrics.keyStrokes + metrics.mouseClicks +
                (metrics.remindersHeeded ?? 0) + (metrics.remindersMissed ?? 0)) > 0)
            .sort((a, b) => b.date.localeCompare(a.date))
            .slice(0, count);
        const heeded = recent.reduce((sum, {metrics}) => sum + (metrics.remindersHeeded ?? 0), 0);
        const missed = recent.reduce((sum, {metrics}) => sum + (metrics.remindersMissed ?? 0), 0);
        return {days: recent.length, heeded, missed, score: heeded + missed ? heeded / (heeded + missed) : null};
    }
}

export function formatHours(seconds) {
    return `${(nonnegative(seconds) / 3600).toFixed(1)} h`;
}

export function formatCount(count) {
    return Math.round(nonnegative(count)).toLocaleString();
}

export function formatTimer(seconds) {
    const total = Math.ceil(nonnegative(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    return hours ? `${hours}:${pad(minutes)}:${pad(total % 60)}` : `${minutes}:${pad(total % 60)}`;
}
