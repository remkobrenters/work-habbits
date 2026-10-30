# Top-bar progress bars and sound reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the top-bar countdown with Posture/Hands progress bars, bound the red phase to two penalties and a reset, play a configurable repeating sound in red instead of desktop banners, and refresh the README previews.

**Architecture:** All reminder rules stay in the pure `extension/logic.js` (`WellnessModel`), which gains a bounded red window and a `gauges()` read-out for the panel. A new pure `extension/sound-options.js` decides when to chime. A thin `extension/sound.js` spawns `gst-play-1.0`, copying ai-monitor's approach. `extension/extension.js` only paints and wires these together.

**Tech Stack:** GJS ES modules (GNOME Shell 46–50: St, Clutter, Gio, GLib, Cairo), GSettings, Adwaita prefs, Node `node:test` with mocked GNOME modules, GJS settings tests, Python unittest for the installer.

**Spec:** `docs/superpowers/specs/2026-10-30-panel-bars-and-sound-reminders-design.md`. Read it before each task; this plan argues from it.

## Global Constraints

- **Supported shells:** GNOME Shell 46–50. Vertical boxes use the existing `vertical` helper in `extension.js`, never `vertical: true` or `orientation` directly.
- **Dependencies:** no new npm or pip packages. The only new system program is `gst-play-1.0` (apt `gstreamer1.0-plugins-base-apps`).
- **Colors:** use the existing `COLORS` values: green `#40cb82`, orange `#f1ac43`, red `#f26a66`, gray `#9ca3af`.
- **Defaults:**

  | Key | Default |
  |---|---|
  | `seated-grace` | 2 |
  | `stand-grace` | 2 |
  | `input-grace` | 1 |
  | `red-window` | 10 (range 2–60) |
  | `panel-icons` | false |
  | `sound-enabled` | true |
  | `sound-effect` | 3 (range 1–3) |
  | `sound-repeat` | 15 (range 0–60, UI offers 0/15/30/60) |
  | `snooze-penalty` | 2 (unchanged) |

- **Removed keys:** `notifications-enabled`, `seated-repeat`, `stand-repeat`, `input-repeat`.
- **Red window:** penalty 1 at `late + redWindow / 2`, penalty 2 at `late + redWindow`, then reset. At most 2 misses per round, or 4 after a snooze that ran out while working.
- **Active time only:** idle, locked or paused time never advances orange, red, penalties or chimes.
- **GType names:** must start with `WorkHabbits`. `tests/dashboard.test.mjs` asserts this.
- **Code style:** 4-space indent, single quotes, sparse one-line comments, the same terse style as `extension/logic.js`.
- **Commits:** follow this repo's style, a plain descriptive sentence with no ticket prefix (the repo has no tracker). Stage explicit paths only. Never commit `.superpowers/`.
- **Fast test commands** (no venv needed):
  - `node tests/logic.test.mjs`
  - `node --experimental-vm-modules tests/dashboard.test.mjs`
  - `node tests/sound.test.mjs` (from Task 6)
  - `gjs -m tests/settings.test.js`
  - `/usr/bin/python3 -m unittest discover -s tests -p 'test_*.py'`

## Review Focus

1. **Upgrade with an existing day record.** The record may hold old-style snoozes (`state: 'broken'`, `held`) or a timer already beyond the new `late + redWindow`. Loading it must not crash or charge the same penalty twice. Test in Task 1.
2. **Settings changed mid-round.** If shrinking `red-window` or the grace puts the timer beyond the new window end, the round charges at most 2 misses in total, then resets. Test in Task 1.
3. **Short lock during a snooze.** The snooze becomes `forgiven`, but it keeps running until its end. Afterwards, penalties count ×1, not ×2. Test in Task 1.
4. **Do Not Disturb or the sound switch toggled while red.** Turning either on silences the sound at once. Turning it off plays immediately, not after a full interval. Test in Task 6.
5. **`gst-play-1.0` or a sound file missing.** A visible message appears in the menu, and nothing throws on every tick. Test in Task 6.

---

### Task 0: Branch and spec

**Files:** none modified. Commits the existing spec and this plan.

- [ ] **Step 1:** `git checkout -b feature/panel-bars-and-sound-reminders`
- [ ] **Step 2:** Run the baseline tests, using the fast commands above. Expected: all pass (logic 15, dashboard 2, settings ok, installer 7).
- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-10-30-panel-bars-and-sound-reminders-design.md docs/superpowers/plans/2026-10-30-panel-bars-and-sound-reminders.md
git commit -m "Add design and plan for top-bar progress bars and sound reminders"
```

---

### Task 1: Bounded red window (two penalties, then a new round)

**Files:**
- Modify: `extension/logic.js`: `SETTINGS`, `configure`, `misses`, `validSnooze`, `WellnessModel`
- Modify: `extension/schemas/org.gnome.shell.extensions.work-habbits.gschema.xml`
- Modify: `extension/prefs.js` (rows in the `groups` array)
- Test: `tests/logic.test.mjs`, `tests/settings.test.js`

**Interfaces:**
- Produces:
  - `SETTINGS.redWindow` (seconds, default 600). `SETTINGS.seatedRepeat`, `standRepeat` and `inputRepeat` are removed.
  - Snooze record shape: `{until: ms, grace: s, state: 'active'|'forgiven', charged: n}`.
  - `snoozeStates()` returns `{[name]: 'snoozed'|'over'}`.
  - `_resetRound(name)` with `name` in `'seated'|'stand'|'input'`.

**Rules:**
- `SETTINGS` defaults change: `seatedLate: 7320`, `standLate: 1320`, `redWindow: 600`. Keep key order, with `redWindow` where the `*Repeat` keys were, so `JSON.stringify` comparisons in `settings.test.js` hold.
- `configure`: `redWindow: (prefs['red-window'] ?? 10) * 60`.
- Replace `misses()` with `penalties(value, late, window)`, which returns 0, 1 at `late + window / 2`, or 2 at `late + window`. The constructor's `_misses` uses it, so penalties already charged are never replayed after a restart.
- `validSnooze` accepts finite, non-negative `until`, `grace` and `charged`, and `state` in `['active', 'forgiven']`. Old records with `held` still pass; the extra field is ignored. A `'broken'` snooze is dropped on load.
- Replace `_countMisses` and `_overrun` with `_advance(name, dt, cfg)`, called where both are called today.
  - **No snooze for `name`:** charge `penalties(value) - _misses[name]` into `missed`. When `value >= late + redWindow`, call `_resetRound(name)`.
  - **Snooze present and `'snoozed'`:** charge nothing and never reset, even if the timer passes the window.
  - **Snooze present and `'over'`:** `grace += dt`. Charge `(penalties(grace, 0, W) - penalties(graceBefore, 0, W)) × (state === 'active' ? snoozePenalty : 1)` into `missed` and add it to `charged`. When `grace >= W`, call `_resetRound(name)`.
- `_resetRound`:
  - `seated` sets `seated = 0`.
  - `stand` sets `standingRun = 0` and keeps `standComplete`.
  - `input` sets `input = 0`.
  - All three set `_misses[name] = 0` and delete the snooze.
- `snooze()`: for each snoozable name, take back `_misses[name]` from `missed` (never below 0) and create a new record `{until: wallMs + cfg[`${name}Snooze`] * 1000, grace: 0, state: 'active', charged: 0}`.
- `_forgive()`: set `state = 'forgiven'` on active snoozes. It no longer touches `held`.
- `_snoozeColor`: `'snoozed'` gives `'orange'`, `'over'` gives `'red'`.
- `_due('stand')`: `this.standComplete && this.standingRun >= cfg.standRequired`.
- **Heeded points** (a point only before red):
  - Hand rest: `cfg.inputDue <= input < cfg.inputLate`.
  - Completing a stand: `this.seated < cfg.seatedLate`.
  - Sitting again: `standComplete && cfg.standRequired <= standingRun < cfg.standLate`.
- **Schema:**
  - `seated-grace` and `stand-grace` default to `2`.
  - Remove `seated-repeat`, `stand-repeat` and `input-repeat`.
  - Add `<key name="red-window" type="u"><range min="2" max="60"/><default>10</default><summary>Minutes in red: a penalty halfway, another at the end, then the timer resets</summary></key>`.
- **prefs.js rows:**
  - The grace rows are relabeled `Orange warning before red (stand up)` (`seated-grace`), `Orange warning before red (sit down)` (`stand-grace`) and `Orange warning before red` (`input-grace`).
  - The Habit score group becomes `[['score-days', 'Active days in the score'], ['red-window', 'Red warning window']]`.
  - Set that group's description to `In red, a penalty counts halfway and at the end of this window; then the timer starts a new round.`

- [ ] **Step 1: Write the failing tests.** Add these tests to `tests/logic.test.mjs`. In the configure test, replace `'seated-repeat': 30, 'stand-repeat': 15, 'input-repeat': 15` with `'red-window': 10`.

```js
const W = () => SETTINGS.redWindow;

test('entering red warns without a penalty; halfway and the end each charge one, then the round resets', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate - 1});
    tick(model);
    assert.deepEqual([model.deskColor(true), model.missed], ['red', 0]);
    model.seated = SETTINGS.seatedLate + W() / 2 - 1;
    tick(model);
    assert.equal(model.missed, 1);
    model.seated = SETTINGS.seatedLate + W() - 1;
    tick(model);
    assert.deepEqual([model.missed, model.seated, model.deskColor(true)], [2, 0, 'green']);
});

test('an ignored reminder never charges more than two per round', () => {
    const cfg = {...SETTINGS, seatedDue: 4, seatedLate: 6, redWindow: 4};
    const model = new WellnessModel();
    for (let i = 0; i < 20; i++) tick(model, {}, cfg);
    assert.deepEqual([model.missed, model.seated], [4, 0]);
});

test('hands and the sit-down reminder reset their own timer; a reset stand earns no point', () => {
    const hands = new WellnessModel({input: SETTINGS.inputLate + W() - 1, missed: 1, lastInputWallMs: now});
    tick(hands);
    assert.deepEqual([hands.missed, hands.input], [2, 0]);
    const stand = new WellnessModel({standingRun: SETTINGS.standLate + W() - 1, standComplete: true, missed: 1, heeded: 1});
    tick(stand, {position: 'standing'});
    assert.deepEqual([stand.missed, stand.standingRun, stand.standComplete, stand.deskColor(true)], [2, 0, true, 'green']);
    assert.deepEqual(stand.snoozable(), []);
    tick(stand, {position: 'sitting'});
    assert.equal(stand.heeded, 1, 'Sitting after a reset earns no point');
});

test('a change before red earns a point; in red before the first penalty it is neutral', () => {
    const early = new WellnessModel({seated: SETTINGS.seatedLate - 1, standingRun: SETTINGS.standRequired - 1});
    tick(early, {position: 'standing', idleSeconds: 999});
    assert.equal(early.heeded, 1);
    const red = new WellnessModel({seated: SETTINGS.seatedLate, standingRun: SETTINGS.standRequired - 1});
    tick(red, {position: 'standing', idleSeconds: 999});
    assert.deepEqual([red.heeded, red.missed], [0, 0]);
    const hands = new WellnessModel({input: SETTINGS.inputLate, lastInputWallMs: now});
    tick(hands, {idleSeconds: SETTINGS.inputResetIdle});
    assert.deepEqual([hands.heeded, hands.missed, hands.input], [0, 0, 0]);
});

test('idle and locked time never advance the red window', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate + W() / 2 - 1});
    tick(model, {idleSeconds: SETTINGS.postureActiveWindow});
    tick(model, {localActive: false});
    assert.deepEqual([model.missed, model.seated], [0, SETTINGS.seatedLate + W() / 2 - 1]);
});

test('a snooze takes back penalties, holds the round, then gives a doubled red window', async () => {
    const {dailyRecord, modelState} = await import('../extension/history.js');
    const cfg = {...SETTINGS, seatedSnooze: 2, seatedDue: 2, seatedLate: 4, redWindow: 4};
    const model = new WellnessModel();
    tick(model, {dt: 2}, cfg);
    assert.deepEqual(model.snooze(now, cfg), ['seated']);
    assert.deepEqual(model.snooze(now, cfg), []);
    model.seated = 100;
    tick(model, {dt: 1, wallMs: now + 1000}, cfg);
    assert.deepEqual([model.missed, model.deskColor(true, cfg)], [0, 'orange'], 'Snoozed: no penalty, no reset');
    tick(model, {dt: 2, wallMs: now + 2000}, cfg);
    assert.equal(model.missed, 2, 'Halfway penalty counts double');
    const restored = new WellnessModel(modelState(dailyRecord(model.serialize('2026-10-30'))));
    assert.deepEqual(restored.snoozes, model.snoozes);
    tick(model, {dt: 2, wallMs: now + 4000}, cfg);
    assert.deepEqual([model.missed, model.seated, model.snoozes.seated], [4, 0, undefined]);
});

test('a snooze already holding a penalty takes it back', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate + W() / 2, missed: 1});
    model.lastPosition = 'sitting';
    model.snooze(now);
    assert.equal(model.missed, 0);
});

test('a short lock forgives a snooze but it runs to its end; then penalties count once', () => {
    const cfg = {...SETTINGS, seatedSnooze: 10, seatedDue: 2, seatedLate: 4, redWindow: 4};
    const model = new WellnessModel();
    tick(model, {dt: 2}, cfg);
    model.snooze(now, cfg);
    tick(model, {localActive: false, wallMs: now + 1000}, cfg);
    assert.equal(model.snoozes.seated.state, 'forgiven');
    assert.equal(model.snoozeStates().seated, 'snoozed');
    tick(model, {dt: 2, wallMs: now + 10000}, cfg);
    tick(model, {dt: 2, wallMs: now + 12000}, cfg);
    assert.deepEqual([model.missed, model.seated], [2, 0]);
});

test('upgrading never replays penalties: old broken snoozes are dropped, past-window timers reset', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate + W() + 5, missed: 3,
        snoozes: {seated: {until: 1, held: 0, grace: 0, state: 'broken', charged: 2}}});
    assert.deepEqual(model.snoozes, {});
    tick(model);
    assert.deepEqual([model.missed, model.seated], [3, 0]);
});

test('shrinking the red window mid-round charges at most two, then resets', () => {
    const model = new WellnessModel({seated: SETTINGS.seatedLate + 60});
    tick(model, {}, {...SETTINGS, redWindow: 60});
    assert.deepEqual([model.missed, model.seated], [2, 0]);
});
```

Update these existing tests:
- **"habit score … repeated misses":** the `late` model now ends with `missed === 0` after one tick ("Entering red is a warning"). The restored model must also have `missed === 0`. Set `restored.seated = SETTINGS.seatedLate + SETTINGS.redWindow / 2 - 1`, tick, and expect `missed === 1`. The rest stays the same.
- **"locking, leaving … forgive snoozes":** expect `state === 'forgiven'` and `missed === 0`. Drop the `grace` assertion.
- **Delete** "snoozes hold red misses, persist and charge once after active grace"; the snooze tests above replace it.
- In `tests/settings.test.js`, add: `assert(settings.get_uint('red-window') === 10 && settings.get_uint('seated-grace') === 2, 'Bounded red window defaults')` and `assert(!settings.settings_schema.has_key('seated-repeat'), 'Unbounded miss intervals are gone')`.

- [ ] **Step 2: Run the tests to make sure they fail.** Run `node tests/logic.test.mjs`. Expected: the new tests FAIL. For example, "entering red" fails with `missed` 1 instead of 0.
- [ ] **Step 3: Implement** the rules above in `logic.js`, the schema and `prefs.js`.
- [ ] **Step 4: Run the tests to make sure they pass.**
  - `node tests/logic.test.mjs` and `gjs -m tests/settings.test.js`: all pass.
  - `node --experimental-vm-modules tests/dashboard.test.mjs`: still passes. The extension still uses `countdown()` and `reminderUrgency()`, which stay untouched in this task.
- [ ] **Step 5: Commit**

```bash
git add extension/logic.js extension/schemas/org.gnome.shell.extensions.work-habbits.gschema.xml extension/prefs.js tests/logic.test.mjs tests/settings.test.js
git commit -m "Bound the red phase: a penalty halfway and at the end, then a new round"
```

---

### Task 2: Panel gauges read-out

**Files:**
- Modify: `extension/logic.js` (add to `WellnessModel`)
- Test: `tests/logic.test.mjs`

**Interfaces:**
- Consumes: `snoozeStates()`, `deskColor()` and `inputColor()` from Task 1.
- Produces:
  - `snoozeSeconds(name, cfg = SETTINGS) -> number`. While snoozed, it returns `(until - wallMs) / 1000`. While over, it returns the time to the next snooze-window penalty: `W/2 - grace` before halfway, otherwise `W - grace`.
  - `gauges({desk, input, idleSeconds, handsIdle}, cfg = SETTINGS) -> {posture: Gauge, hands: Gauge}`, where `Gauge = {color: 'green'|'orange'|'red'|'gray', blink: null|'slow'|'fast', fraction: number, seconds: number|null}`.

**Rules:**
- **Gray:** `{color: 'gray', blink: null, fraction: 0, seconds: null}` when unavailable. For posture that is `!desk` or `lastPosition === 'unknown'`; for hands it is `!input`.
- **Which reminder the posture gauge reads:** sitting uses `seated` (due `seatedDue`, late `seatedLate`); standing or away uses `stand` (due `standRequired`, late `standLate`) on `standingRun`. Hands uses `input`.
- **Seconds:**
  - snooze present: `snoozeSeconds`
  - green: `due - value`
  - orange: `late - value`
  - red: time to the next penalty, `late + W/2 - value` before halfway, else `late + W - value`
- **Fraction:** green is `min(1, value / due)`; every other color is `1`.
- **Blink:** `'slow'` for orange, `'fast'` for red. It is `null` when snoozed, when green or gray, or when the user is idle. For posture, idle means `idleSeconds >= cfg.postureActiveWindow`.
- **Hands resting** (`handsIdle >= cfg.inputActiveWindow`): color as `inputColor`, so green; `blink: null`; `fraction: min(1, input / inputDue)`; `seconds` is `max(0, inputResetIdle - handsIdle)` if `input > 0`, else `inputDue`.

- [ ] **Step 1: Write the failing test**

```js
test('gauges fill toward the change, count down to the next state and blink only when due and active', () => {
    const model = new WellnessModel({seated: 1800, input: 750, lastInputWallMs: now});
    tick(model, {dt: 0});
    const view = (overrides = {}) => model.gauges({desk: true, input: true, idleSeconds: 0, handsIdle: 0, ...overrides});
    assert.deepEqual(view().posture, {color: 'green', blink: null, fraction: 0.25, seconds: 5400});
    assert.deepEqual(view().hands, {color: 'green', blink: null, fraction: 0.5, seconds: 750});
    model.seated = SETTINGS.seatedDue + 30;
    assert.deepEqual(view().posture, {color: 'orange', blink: 'slow', fraction: 1, seconds: 90});
    model.seated = SETTINGS.seatedLate + 60;
    assert.deepEqual(view().posture, {color: 'red', blink: 'fast', fraction: 1, seconds: SETTINGS.redWindow / 2 - 60});
    model.seated = SETTINGS.seatedLate + SETTINGS.redWindow / 2 + 10;
    assert.equal(view().posture.seconds, SETTINGS.redWindow / 2 - 10);
    assert.equal(view({idleSeconds: SETTINGS.postureActiveWindow}).posture.blink, null);
    model.snooze(now);
    assert.deepEqual(view().posture, {color: 'orange', blink: null, fraction: 1, seconds: SETTINGS.seatedSnooze});
    model.wallMs = now + SETTINGS.seatedSnooze * 1000;
    assert.deepEqual(view().posture, {color: 'red', blink: 'fast', fraction: 1, seconds: SETTINGS.redWindow / 2});
    model.input = SETTINGS.inputDue;
    assert.deepEqual(view({handsIdle: 30}).hands, {color: 'green', blink: null, fraction: 1, seconds: 90});
    assert.deepEqual(view({desk: false, input: false}),
        {posture: {color: 'gray', blink: null, fraction: 0, seconds: null}, hands: {color: 'gray', blink: null, fraction: 0, seconds: null}});
    const standing = new WellnessModel({standingRun: 300});
    tick(standing, {position: 'standing', dt: 0});
    assert.deepEqual(standing.gauges({desk: true, input: false, idleSeconds: 0, handsIdle: 0}).posture,
        {color: 'green', blink: null, fraction: 0.25, seconds: 900});
});
```

- [ ] **Step 2:** Run `node tests/logic.test.mjs`. Expected: FAIL, `model.gauges is not a function`.
- [ ] **Step 3:** Implement `snoozeSeconds` and `gauges` in `extension/logic.js`.
- [ ] **Step 4:** Run `node tests/logic.test.mjs`. Expected: all PASS.
- [ ] **Step 5: Commit**

```bash
git add extension/logic.js tests/logic.test.mjs
git commit -m "Add a gauges read-out for the posture and hands panel items"
```

---

### Task 3: Top bar: label, bar and time per item, optional icons

**Files:**
- Modify: `extension/extension.js`: `Meter`, `enable()`, the new `_buildPanel()` and `_paintGauges()`, the blink methods, `_paint()`, `disable()`
- Modify: `extension/stylesheet.css`
- Modify: `extension/logic.js`: delete `countdown()` and `reminderUrgency()`
- Modify: the schema (add `panel-icons`) and `extension/prefs.js` (Tracking switch)
- Delete: `extension/icons/sitting-symbolic.svg`
- Test: `tests/dashboard.test.mjs`, `tests/logic.test.mjs` (delete the countdown and urgency tests: "countdown selects…", "countdown urgency blinks…", "snoozed countdown shows…"), `tests/test_installer.py:130-131`

**Interfaces:**
- Consumes: `gauges()` from Task 2.
- Produces:
  - `Meter` constructor `new Meter({style_class = 'wh-meter', thickness = 0.5} = {})`. Fill height is `height * thickness`. The level gains `lit` (default `true`); when `false`, only the track is drawn.
  - `_buildPanel(box)` sets `this._panelItems = {posture, hands}`, each `{icon: St.Icon, name: St.Label, bar: Meter, time: St.Label}`.
  - `_paintGauges(gauges)`.
  - `_setBlink({posture, hands})` with values `null|'slow'|'fast'`.
  - `_paintBlink()`.

**Rules:**
- **Structure:** `enable()` creates `this._postureIcon = new Gio.FileIcon(... 'standing-symbolic.svg')`, then calls `this._buildPanel(box)` in place of the old icon/countdown/icon children.
- **Each item:** an `St.BoxLayout` `wh-gauge` holding:
  - the icon: `system-status-icon`, visible only while `panel-icons` is true. Posture's `gicon` is `this._postureIcon`; Hands' `icon_name` is `'input-keyboard-symbolic'`.
  - a vertical `wh-gauge-identity` box holding the name label (`wh-gauge-name`, text `Posture` or `Hands`) and the bar (`new Meter({style_class: 'wh-panel-meter', thickness: 1})`)
  - the time label: `wh-gauge-time wh-num`, `muted: true`, top-aligned
- **Painting:**
  - Bar: `setLevel({fraction, color: COLORS[color]})`.
  - Icon: `set_style(`color: ${COLORS[color]};`)`.
  - Time: `seconds === null ? '—' : formatTimer(seconds)`.
- **Blink:**
  - A single 250 ms `GLib.timeout_add`, as today, runs while any gauge blinks.
  - Half periods: `slow` 1 s, `fast` 0.5 s. Each gauge's phase starts lit when its kind changes.
  - When unlit, the bar is set with `lit: false` and the icon's `opacity` is 60.
  - Name and time never blink.
- **Accessible name:** `work-habbits: ${position or 'posture unknown'}, posture ${posture.color}, hands ${hands.color}`.
- **Remove:** `_deskIcon`, `_inputIcon`, `_countdown`, `_countdownColor`, `_countdownStyle`, `_blinkKind`, `_postureIcons`, `_setCountdownBlink`, `_paintCountdownBlink`, `.wh-countdown`.
- **CSS:** `.wh-panel { spacing: 14px; }`, `.wh-gauge { spacing: 6px; }`, `.wh-gauge-identity { spacing: 1px; }`, `.wh-gauge-name { font-size: 12px; font-weight: 600; }`, `.wh-gauge-time { font-size: 11px; }`, `.wh-panel-meter { width: 44px; height: 3px; }`.
- **Schema:** `<key name="panel-icons" type="b"><default>false</default><summary>Show posture and keyboard icons in the top bar</summary></key>`.
- **prefs.js:** add the Tracking switch `['panel-icons', 'Show icons in the top bar']`.
- **`install.sh`:** unchanged; its `icons/*.svg` glob now installs only the standing icon.
- **`test_installer.py`:** assert `standing-symbolic.svg` only.

- [ ] **Step 1: Write the failing test.** In `tests/dashboard.test.mjs`:
  - Extract the main test's setup into a helper. It covers the lines from `new extension.namespace.default()` through `app._model.update(...)`, and Tasks 4 and 6 reuse it:

    ```js
    function buildApp({seated = SETTINGS.seatedDue, input = SETTINGS.inputDue} = {}) {
        const state = {icons: false, banners: true};
        const played = [];
        const app = new extension.namespace.default();
        app._settings = {get_string: () => 'manual',
            get_boolean: key => ({'panel-icons': state.icons, 'notifications-enabled': true, 'sound-enabled': true})[key] ?? false,
            get_uint: key => ({'sound-effect': 3, 'sound-repeat': 15})[key]};
        app._postureIcon = 'standing-icon';
        app._buildPanel(new Actor());
        // …the remaining existing setup (menu, session, store, model with `seated`/`input`)…
        return {app, state, played};
    }
    ```

    The main test then begins `const {app, state, played} = buildApp();`.
  - Replace the hand-made `_deskIcon`, `_inputIcon` and `_countdown` actors with the helper's `_buildPanel` call.
  - Replace the old icon and countdown assertions with the following (`icons = true` becomes `state.icons = true`):

```js
const {posture, hands} = app._panelItems;
assert.equal(posture.name.text, 'Posture');
assert.equal(posture.icon.gicon, 'standing-icon');
assert.equal(hands.icon.icon_name, 'input-keyboard-symbolic');
assert.equal(posture.icon.visible, false, 'Icons are opt-in');
assert.equal(posture.bar._level.color, orange);
assert.equal(posture.bar._level.fraction, 1);
assert.equal(posture.time.text, '2:00', 'Orange counts down the 2-minute warning');
assert.equal(app._blink.posture, 'slow');
state.icons = true;
app._paint(true, 0, 'manual', true);
assert.equal(posture.icon.visible, true);
assert.ok(posture.icon.style.includes(orange), 'Icon follows the bar color');
```

  Later in the same test:
  - After `seated = seatedLate`: `assert.equal(posture.bar._level.color, '#f26a66')` and `assert.equal(app._blink.posture, 'fast')`.
  - After `_paint(false, …)`: `assert.equal(posture.time.text, '—')` and `assert.equal(hands.bar._level.color, '#9ca3af')`.
  - Replace the gicon/icon_name assertions for Bluetooth with `assert.match(app._indicator.accessible_name, /standing/)`.
  - Store the active blink kinds on `this._blink` so the test can read them.

- [ ] **Step 2:** Run `node --experimental-vm-modules tests/dashboard.test.mjs`. Expected: FAIL, `app._buildPanel is not a function`.
- [ ] **Step 3:** Implement the rules above. Delete the sitting icon with `git rm extension/icons/sitting-symbolic.svg`.
- [ ] **Step 4: Run the tests.** Run the dashboard test twice, once with and once without `WORK_HABBITS_TEST_ORIENTATION=1`. Also run `node tests/logic.test.mjs`, `gjs -m tests/settings.test.js` and `/usr/bin/python3 -m unittest discover -s tests -p test_installer.py`. Expected: all PASS.
- [ ] **Step 5: Commit**

```bash
git add extension/extension.js extension/stylesheet.css extension/logic.js extension/prefs.js extension/schemas/org.gnome.shell.extensions.work-habbits.gschema.xml tests/dashboard.test.mjs tests/logic.test.mjs tests/test_installer.py
git commit -m "Show Posture and Hands as labeled progress bars in the top bar, with optional icons"
```

---

### Task 4: No reminder banners; menu texts for the new flow

**Files:**
- Modify: `extension/extension.js`: `_paint`, `_notify` (delete), `_alerts` (delete everywhere), the snooze button handler, `_rollDay`
- Modify: the schema (remove `notifications-enabled`) and `extension/prefs.js` (remove the switch)
- Test: `tests/dashboard.test.mjs`, `tests/settings.test.js`

**Interfaces:**
- Consumes: `gauges()` and `snoozeSeconds()` from Task 2.
- Produces: none.

**Rules:**
- `Main.notify` stays only in `_deskAction`, for "Desk command failed" and "Desk unavailable".
- **Posture card hint, when there's no `reason`:**
  - If the posture gauge is red and has no snooze: `Too late: penalty in ${formatTimer(seconds)}`.
  - Otherwise, today's texts.
- **Hands card hint:** the same red text first, then today's texts.
- **Snooze hint line per snooze:**
  - snoozed: `${label}: snoozed ${t}`
  - over and active: `${label}: penalty in ${t}, counts ×${SETTINGS.snoozePenalty}`
  - over and forgiven: `${label}: penalty in ${t}`
  - Here `t = formatTimer(model.snoozeSeconds(name))` and the labels are the existing `{seated: 'Stand', stand: 'Sit', input: 'Hands'}`.

- [ ] **Step 1: Write the failing test.**
  - In `tests/dashboard.test.mjs`, change the main.js mock to `{notify: (...args) => notified.push(args)}` with a module-level `const notified = []`.
  - The `buildApp()` settings mock from Task 3 already returns `true` for `get_boolean('notifications-enabled')`, so today's code would notify.
  - After the orange and red paints, add:

```js
assert.deepEqual(notified, [], 'Reminders never raise desktop banners');
assert.match(app._postureCard.hint.text, /^Too late: penalty in /);
```

  - In `tests/settings.test.js`: `assert(!settings.settings_schema.has_key('notifications-enabled'), 'Reminder banners are gone')`.
- [ ] **Step 2:** Run `node --experimental-vm-modules tests/dashboard.test.mjs`. Expected: FAIL, because `notified` has entries.
- [ ] **Step 3:** Implement the rules above.
- [ ] **Step 4:** Run the dashboard test (both orientation variants) and `gjs -m tests/settings.test.js`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add extension/extension.js extension/prefs.js extension/schemas/org.gnome.shell.extensions.work-habbits.gschema.xml tests/dashboard.test.mjs tests/settings.test.js
git commit -m "Drop reminder banners and describe penalties and snoozes in the menu"
```

---

### Task 5: Bundle the sounds with attribution

**Files:**
- Create: `extension/sounds/notification_1.mp3`, `notification_2.mp3` and `notification_3.mp3`, moved from the repo root with a plain `mv` since they're untracked.
- Create: `THIRD_PARTY_NOTICES.md`, `docs/audio-provenance.json`, `tests/test_assets.py`
- Modify: `install.sh:54-60`, `scripts/package.py` (`FILES`), `tests/test_installer.py`, `README.md` (one line near the license or contributing paragraph)

**Interfaces:**
- Produces: the installed path `$EXT/sounds/notification_{1,2,3}.mp3`, used by Task 6's `soundFile()`.

**Provenance values** (verbatim):

| File | Title | Creator | Source | sha256 |
|---|---|---|---|---|
| `extension/sounds/notification_1.mp3` | New Notification 065 | Universfield | `https://pixabay.com/sound-effects/technology-new-notification-065-494546/` | `54630ad061a7ba9fe381439d555e18a89c266c455506811681bb2067b8ecc7d2` |
| `extension/sounds/notification_2.mp3` | Message | SupremeTyLewisS | `https://cdn.pixabay.com/download/audio/2022/01/07/audio_455a3917eb.mp3?filename=supremetylewiss-message-13716.mp3` | `3534dd37fcb4ea22075a7e6057927120c936d7f0d6a176ecdf84e2a4479fe48d` |
| `extension/sounds/notification_3.mp3` | New Notification 067 | Universfield | `https://pixabay.com/sound-effects/film-special-effects-new-notification-067-138695/` | `f00ce1645f1ce40f7e5d1b71306e68bfe4bd135124ed5f0594cc508fe7812d92` |

**Rules:**
- **`THIRD_PARTY_NOTICES.md`** mirrors ai-monitor's `THIRD_PARTY_NOTICES.md` (https://github.com/remkobrenters/ai-monitor):
  - The MIT license covers the code; the MP3s are under the Pixabay Content License.
  - "Thanks to **Universfield** and **SupremeTyLewisS** for sharing these sounds on Pixabay."
  - The table above, without the hash column.
  - The restrictions paragraph, with the license-summary and terms links.
  - The provenance paragraph pointing to `docs/audio-provenance.json`, ending with "This application does not contact Pixabay at runtime."
- **`docs/audio-provenance.json`:** a list of `{file, source, license: 'Pixabay Content License', sha256}`.
- **`install.sh`:** add `"$EXT/sounds"` to the `install -d` line and add `install -m 0644 "$HERE/extension/sounds/"*.mp3 "$EXT/sounds/"`.
- **`scripts/package.py`:** add `'THIRD_PARTY_NOTICES.md'` to `FILES`. The sounds come along with the `extension` directory.
- **README line:** "Bundled notification sounds are third-party Pixabay content; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)."

- [ ] **Step 1: Write the failing tests.** Create `tests/test_assets.py`:

```python
import hashlib
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class AudioProvenanceTest(unittest.TestCase):
    def test_every_bundled_sound_matches_its_recorded_hash_and_is_credited(self):
        entries = json.loads((ROOT / 'docs/audio-provenance.json').read_text())
        sounds = sorted(p.relative_to(ROOT).as_posix() for p in (ROOT / 'extension/sounds').glob('*.mp3'))
        self.assertEqual(sorted(entry['file'] for entry in entries), sounds)
        notices = (ROOT / 'THIRD_PARTY_NOTICES.md').read_text()
        for entry in entries:
            self.assertEqual(hashlib.sha256((ROOT / entry['file']).read_bytes()).hexdigest(), entry['sha256'])
            self.assertIn(entry['file'], notices)
```

  In `tests/test_installer.py`, after the icon assertion, add `for index in (1, 2, 3): self.assertTrue((extension / 'sounds' / f'notification_{index}.mp3').is_file())`.
- [ ] **Step 2:** Run `/usr/bin/python3 -m unittest discover -s tests -p test_assets.py` and `… -p test_installer.py`. Expected: FAIL (missing provenance file, missing sounds).
- [ ] **Step 3:** Move the files (`mkdir -p extension/sounds && mv notification_*.mp3 extension/sounds/`), write the notices and provenance, and update `install.sh`, `package.py` and the README.
- [ ] **Step 4:** Run `/usr/bin/python3 -m unittest discover -s tests -p 'test_assets.py'` and `… -p test_installer.py`. Expected: PASS. `ls notification_*.mp3` at the root reports no such file.
- [ ] **Step 5: Commit**

```bash
git add extension/sounds THIRD_PARTY_NOTICES.md docs/audio-provenance.json tests/test_assets.py tests/test_installer.py install.sh scripts/package.py README.md
git commit -m "Bundle three Pixabay notification sounds with credits and provenance"
```

---

### Task 6: Sound in red: settings, repeat, Do Not Disturb

**Files:**
- Create: `extension/sound-options.js` (pure), `extension/sound.js` (process), `tests/sound.test.mjs`
- Modify: `extension/extension.js` (`enable`, `_paint`, `disable`, settings handler, `_buildMenu`), the schema, `extension/prefs.js`, `Makefile` (`test` target), `README.md` (apt prerequisites)
- Test: `tests/sound.test.mjs`, `tests/dashboard.test.mjs`, `tests/settings.test.js`

**Interfaces:**
- Consumes: the `Gauge.blink` value `'fast'` from Task 2, which already means red, not snoozed and active. Also the installed sounds from Task 5.
- Produces:
  - In `sound-options.js`:
    - `SOUND_EFFECTS = [{name: 'Notification 1', file: 'notification_1.mp3'}, {name: 'Notification 2', file: 'notification_2.mp3'}, {name: 'Notification 3', file: 'notification_3.mp3'}]`
    - `SOUND_REPEATS = [{seconds: 0, name: 'Once'}, {seconds: 15, name: 'Every 15 seconds'}, {seconds: 30, name: 'Every 30 seconds'}, {seconds: 60, name: 'Every minute'}]`
    - `soundFile(effect: number, extensionPath: string) -> string`. Effects outside 1–3 fall back to `notification_3.mp3`.
    - `class ChimeSchedule { update({red: boolean, allowed: boolean, repeatSeconds: number, nowSeconds: number}) -> boolean }`. It returns true on the rising edge of `red && allowed`, then every `repeatSeconds` while that stays true, never when `repeatSeconds` is 0.
  - In `sound.js`: `class Sound { constructor(extensionPath: string, onError: (message: string) => void); play(effect: number); stop(); destroy() }`.

**Rules:**
- **`Sound.play`** follows ai-monitor's `extension/sound.js`, with no volume and no custom file:
  - Check `GLib.find_program_in_path('gst-play-1.0')` first. If it's missing, call `onError('Reminder sounds need gstreamer1.0-plugins-base-apps.')`.
  - Then check the file. If it isn't a regular file: `onError('Reminder sound file is missing; run ./install.sh again.')`.
  - Spawn `[player, '--quiet', '--no-interactive', '--flags=audio', uri]` with stdout and stderr silenced, and kill it after 15 s.
  - If it fails: `onError('Could not play the reminder sound. Check the output device.')`.
  - Never throw.
- **Schema:**
  - `sound-enabled` (b, `true`, "Play a sound while a reminder is red")
  - `sound-effect` (u, 1–3, `3`)
  - `sound-repeat` (u, 0–60, `15`, "Seconds between repeated sounds while red; 0 plays once")
- **prefs.js:** a new `Adw.PreferencesGroup({title: 'Sound', description: 'Orange stays silent. In red a sound plays while you are at the computer. Do Not Disturb mutes it.'})`, added after Tracking, containing:
  - a `SwitchRow` `Play a sound when a reminder turns red` (bound to `sound-enabled`)
  - a `ComboRow` `Sound` with `SOUND_EFFECTS` names and a suffix `Gtk.Button` (icon `media-playback-start-symbolic`, tooltip `Play`, `valign: CENTER`). The button calls `new Sound(this.path, message => window.add_toast(new Adw.Toast({title: message}))).play(settings.get_uint('sound-effect'))`.
  - a `ComboRow` `Repeat while red` with `SOUND_REPEATS` names, mapped to and from `sound-repeat` by `seconds`. Unknown stored values select `Every 15 seconds`.
- **`extension.js`:**
  - `enable()`:
    - `this._sound = new Sound(this.path, message => { this._soundError = message; })`
    - `this._chimes = new ChimeSchedule()`
    - `this._notificationSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'})`
    - `this._soundError = ''`
  - **Settings handler:** a key starting with `sound-` clears `_soundError`.
  - **In `_paint`,** after the gauges:
    - `red = posture.blink === 'fast' || hands.blink === 'fast'`
    - `allowed = active && get_boolean('sound-enabled') && this._notificationSettings.get_boolean('show-banners')`
    - Call `this._chimes.update({red, allowed, repeatSeconds: get_uint('sound-repeat'), nowSeconds: GLib.get_monotonic_time() / 1e6})`. If it returns true, call `this._sound.play(get_uint('sound-effect'))`.
  - **Menu:** a `PopupMenuItem` `this._soundItem`, made like `_historyItem`, is visible while `_soundError` is non-empty and shows it.
  - **`disable()`:** call `this._sound?.destroy()` and null out `_sound`, `_chimes` and `_notificationSettings`.
- **Makefile `test` target:** add `node tests/sound.test.mjs` after the logic test.
- **README apt line:** `sudo apt install python3-venv python3-gi gir1.2-adw-1 libglib2.0-bin gstreamer1.0-plugins-base-apps`.

- [ ] **Step 1: Write the failing tests.** Create `tests/sound.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {ChimeSchedule, SOUND_EFFECTS, SOUND_REPEATS, soundFile} from '../extension/sound-options.js';

const run = (schedule, steps) => steps.map(([nowSeconds, red, allowed = true, repeatSeconds = 15]) =>
    schedule.update({red, allowed, repeatSeconds, nowSeconds}));

test('chimes on entering red, then every interval, and again at once after leaving red', () => {
    assert.deepEqual(run(new ChimeSchedule(), [[0, false], [1, true], [2, true], [15, true], [16, true], [31, true],
        [32, false], [33, true]]), [false, true, false, false, true, false, true, true]);
});

test('once means only on entering red', () => {
    assert.deepEqual(run(new ChimeSchedule(), [[0, true, true, 0], [100, true, true, 0]]), [true, false]);
});

test('muted while not allowed; becoming allowed in red chimes at once', () => {
    assert.deepEqual(run(new ChimeSchedule(), [[0, true, false], [20, true, false], [21, true, true], [22, true, false]]),
        [false, false, true, false]);
});

test('sound choices and files', () => {
    assert.deepEqual(SOUND_EFFECTS.map(sound => sound.name), ['Notification 1', 'Notification 2', 'Notification 3']);
    assert.deepEqual(SOUND_REPEATS.map(option => option.seconds), [0, 15, 30, 60]);
    assert.equal(soundFile(1, '/ext'), '/ext/sounds/notification_1.mp3');
    assert.equal(soundFile(9, '/ext'), '/ext/sounds/notification_3.mp3');
});
```

  In `tests/dashboard.test.mjs`:
  - Extend the GLib mock with `find_program_in_path: () => null`, `path_is_absolute: () => true`, `file_test: () => true`, `FileTest: {IS_REGULAR: 0}`.
  - In `buildApp()` (Task 3), set:
    - `app._chimes = new ChimeSchedule()` (imported from `../extension/sound-options.js`)
    - `app._sound = {play: effect => played.push(effect)}`
    - `app._notificationSettings = {get_boolean: key => key === 'show-banners' && state.banners}`
    - `app._soundError = ''`

    Its settings mock already answers `sound-enabled`, `sound-effect` and `sound-repeat`.
  - Add these assertions to the main test:

```js
assert.deepEqual(played, [], 'Orange is silent');
// after the paint with seated = seatedLate:
assert.deepEqual(played, [3], 'Red plays the chosen sound once on entry');
app._paint(true, 0, 'manual', true);
assert.deepEqual(played, [3], 'No repeat before the interval');
```

  Add this separate test:

```js
test('Do Not Disturb mutes the red sound and a missing player is reported, not thrown', async () => {
    const sound = moduleAt(new URL('../extension/sound.js', import.meta.url).href).namespace;
    const errors = [];
    new sound.Sound('/ext', message => errors.push(message)).play(3);
    assert.match(errors[0], /gstreamer1\.0-plugins-base-apps/);
    const {app, state, played} = buildApp({seated: SETTINGS.seatedLate});
    state.banners = false;
    app._paint(true, 0, 'manual', true);
    assert.deepEqual(played, [], 'Do Not Disturb (show-banners off) mutes the sound');
    state.banners = true;
    app._paint(true, 0, 'manual', true);
    assert.deepEqual(played, [3], 'Leaving Do Not Disturb while red plays at once');
});
```

  In `tests/settings.test.js`: `assert(settings.get_boolean('sound-enabled') && settings.get_uint('sound-effect') === 3 && settings.get_uint('sound-repeat') === 15, 'Sound defaults')`.
- [ ] **Step 2:** Run `node tests/sound.test.mjs`. Expected: FAIL, cannot find module `sound-options.js`. Then run the dashboard test. Expected: FAIL.
- [ ] **Step 3:** Implement `sound-options.js`, `sound.js`, the schema keys, the prefs group, the `extension.js` wiring, the Makefile line and the README apt line.
- [ ] **Step 4:** Run `node tests/sound.test.mjs`, the dashboard test (both variants), `gjs -m tests/settings.test.js` and `node --check extension/sound.js extension/sound-options.js`. Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add extension/sound-options.js extension/sound.js extension/extension.js extension/prefs.js extension/schemas/org.gnome.shell.extensions.work-habbits.gschema.xml tests/sound.test.mjs tests/dashboard.test.mjs tests/settings.test.js Makefile README.md
git commit -m "Play a configurable, repeating sound while a reminder is red, muted by Do Not Disturb"
```

---

### Task 7: Rendered previews and README/CONTRIBUTING

**Files:**
- Create: `docs/previews/previews.html` and the PNGs `panel-green.png`, `panel-orange.png`, `panel-red.png`, `panel-icons.png`, `panel-snoozed.png`, `panel-unavailable.png`, `menu-dark.png`, `menu-light.png`
- Delete: `docs/screenshots/` (all five PNGs, with `git rm`)
- Modify: `README.md` (Screenshots section, "Reminders and counts", habit score paragraph, Settings mentions, the "Desktop banners follow the notification switch" sentence), `CONTRIBUTING.md` (Screenshots section and the "Keep the README screenshots current" line), `.github/pull_request_template.md` if it mentions screenshots

**Interfaces:**
- Consumes: the final styles and texts from Tasks 3–6.
- Produces: none.

**Rules:**
- **`previews.html`:**
  - Self-contained: inline CSS, the inline standing SVG from `extension/icons/standing-symbolic.svg`, and the Yaru keyboard SVG path.
  - `location.hash` selects one scene; only that scene is shown, at the top-left, with no margin around it.
  - Reproduce `stylesheet.css` values exactly: font `Ubuntu`, the 12px/600 name, the 11px time at opacity 190/255, the 44×3 bar, spacing, the `COLORS` values and the 38em menu width.
  - The panel background is `#1d1d1d`. The menu is drawn in both a dark and a light theme.
- **Sample values,** consistent with the defaults:

  | Scene | Posture | Hands |
  |---|---|---|
  | green | 1:29:42, fraction 0.25 | 12:30, fraction 0.5 |
  | orange | 1:12, orange | green |
  | red | 3:48 to penalty, red | green |
  | icons | green, orange and red rows with icons | |
  | snoozed | 14:12, orange | |
  | unavailable | normal | gray `—` |

  The menu scenes show habit score 82%, posture red with the "Too late: penalty in 3:48" hint, hands green, a snooze line, and the totals table.
- **Static images** show the lit blink phase.
- **Render:**
  - One `google-chrome --headless=new --no-sandbox --user-data-dir="$TMPDIR/chrome" --hide-scrollbars --force-device-scale-factor=2 --window-size=<w>,<h> --screenshot=docs/previews/<scene>.png "file://$PWD/docs/previews/previews.html#<scene>"` per scene.
  - Window sizes are chosen per scene so there's no empty border.
  - Document the loop in `CONTRIBUTING.md`.
- **README Screenshots section** becomes **Previews**, opening with: "Rendered previews of the interface with sample data. They are not desktop screenshots." It has:
  - a panel table: green / orange / red / snoozed / unavailable, plus icons on
  - a menu table: dark / light
  - alt text describing each state
- **README "Reminders and counts":**
  - the spec §2 flow: orange silent warning (default 2 minutes, 1 for hands), the red window (default 10 minutes, a penalty halfway and at the end), the reset, the sound and its repeat, Do Not Disturb muting, no banners
  - snooze per spec §2
  - the habit score: a point only before red; neutral in red before the first penalty; at most two misses per round, four after a snooze that ran out while working
- **CONTRIBUTING:**
  - "Keep previews in `docs/previews/`; they are renderings and must be labeled as such."
  - Keep the "Do not present rendered mockups as actual screenshots" rule.
- **Check:** `grep -rn -i screenshot --exclude-dir=.git --exclude-dir=.superpowers .` may show only intentional mentions, such as the rule above and the v1.1.0 release notes.

- [ ] **Step 1:** Write `docs/previews/previews.html` and render all eight PNGs.
- [ ] **Step 2: Verify the images.**
  - Open every PNG with the Read tool and compare it to the spec's §1 state table and the sample values.
  - The bars fill left to right, the colors are correct, the time is smaller and softer than the label, and nothing is clipped.
  - Fix and re-render until all eight match.
- [ ] **Step 3:** Update the README, CONTRIBUTING and the PR template, then `git rm -r docs/screenshots`.
- [ ] **Step 4: Verify the links.** `grep -o 'docs/previews/[a-z-]*\.png' README.md | sort -u | xargs ls` lists all eight files, and the screenshot grep above is clean.
- [ ] **Step 5: Commit**

```bash
git add docs/previews README.md CONTRIBUTING.md .github/pull_request_template.md
git commit -m "Replace outdated screenshots with labeled renderings and document the new reminder flow"
```

---

### Task 8: Full verification

**Files:** none, unless a check fails.

- [ ] **Step 1:** Create the dev environment, if it's missing: `/usr/bin/python3 -m venv .venv && .venv/bin/python -m pip install -r requirements-dev.txt`. This needs network access to `pypi.org` and `files.pythonhosted.org`.
- [ ] **Step 2:** Run `make check`. Expected: exit 0. All lint, schema, Python, node, GJS and installer tests pass.
- [ ] **Step 3:** Run `make dist`. Expected: it prints `dist/work-habbits-source.zip`, and `unzip -l dist/work-habbits-source.zip | grep -E 'THIRD_PARTY|sounds/notification_[123].mp3'` shows four lines.
- [ ] **Step 4:** Run `git status --short`. Only `.superpowers/` and `dist/` may be untracked; everything else is committed.
- [ ] **Step 5:** Report to the owner, with the manual desktop checklist from spec §9: the panel in light and dark, blinking, the sound and its repeat, the snooze path, no banners, and Do Not Disturb muting. Reload Shell with Alt+F2 → `r` after `./install.sh`.
