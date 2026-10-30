# Top-bar progress bars and sound reminders — design

Date: 2026-10-30. Status: approved by the owner ("build it").

Decisions marked **(Claude's call)** were made by Claude and haven't been confirmed. Everything else was decided by the owner in conversation.

## Why

The top-bar indicator is hard to read. It shows one countdown, and an arrow (`◂`/`▸`) points at the posture or keyboard icon to say which timer it belongs to. The owner's other GNOME extension, ai-monitor (`~/Development/ai-monitor`), uses a calmer pattern: a label with a thin bar underneath and a small value beside it. The owner wants the same here, with both timers always visible.

The reminders also need a clearer escalation without desktop banners. Orange is a silent warning. Red adds a sound that can repeat. After two penalties, the round gives up and the timer resets, so nobody gets stuck in an endless penalty loop.

## Goals

1. Replace the top-bar indicator with two items, **Posture** and **Hands**, in ai-monitor's layout.
2. Bars and optional icons signal state by color and blinking: green, orange slow blink, red fast blink.
3. Replace the open-ended miss counting with a bounded red window: two penalties, then a reset.
4. A notification sound that starts on red and can repeat. The user picks the sound and how often it repeats.
5. No desktop banners for reminders.
6. Bundle the three Pixabay sounds in a dedicated folder, with attribution and provenance.
7. New README images for the main situations, replacing the outdated v1.0.0 screenshots, clearly labeled as renderings.

## Non-goals

- Redesigning the dropdown menu. Its layout stays; only texts that describe the reminder flow change.
- A volume setting or a custom sound file **(Claude's call)**. ai-monitor has both, but they weren't asked for. The system volume applies.
- A version bump or release notes.
- Changes to Bluetooth, input collection, history storage format or the habit-score formula, apart from when misses are counted.

## Anti-goals

- Sound when the user is not at the computer (idle, locked, tracking paused), when the reminder is snoozed, or while GNOME's Do Not Disturb is on.
- Any sound during orange.
- Presenting rendered images as real screenshots. `CONTRIBUTING.md` forbids it.
- A reminder that can keep charging penalties forever.

## 1. Top bar

### Layout

Each item: `[optional icon] [label over bar] [time]`. The two items sit side by side, Posture first, then Hands. The panel icons, the arrow and the single countdown go away.

| Element | Spec (matches ai-monitor's stylesheet) |
|---|---|
| Label | "Posture" / "Hands", 12px, weight 600, normal panel text color |
| Bar | 44×3px under the label, rounded, track `rgba(128,128,128,0.28)` (Claude's call) |
| Time | 11px, tabular figures, softer (about 70% opacity), next to the label |
| Spacing | about 6px inside an item, about 14px between items (Claude's call) |

Colors stay `COLORS` in `extension/extension.js`: green `#40cb82`, orange `#f1ac43`, red `#f26a66`, gray `#9ca3af`.

### Bar direction

The bar **fills up toward the change**. It's empty when its timer resets and full when the change is due. Once a reminder is orange or red, the bar stays full.

### Optional icons

A new setting, **Show icons in the top bar**, is off by default (Claude's call). When it's on:
- Posture always shows the standing figure (`extension/icons/standing-symbolic.svg`).
- Hands shows the theme's `input-keyboard-symbolic`.
- Each icon takes its bar's color and blinks with it.

The sitting icon (`extension/icons/sitting-symbolic.svg`) is deleted, and the posture icon no longer switches between sitting and standing.

### States per item

| State | Bar / icon | Blink | Time shows |
|---|---|---|---|
| Green | green, fill = elapsed ÷ due | none | time until the change is due |
| Orange (change due) | full, orange | slow: 1 s on, 1 s off (today's `near` rate) | time until red |
| Red (too late) | full, red | fast: 0.5 s on, 0.5 s off (today's overdue rate) | time until the next penalty (Claude's call) |
| Snoozed | full, orange | none | snooze time remaining |
| Gray (unavailable) | gray, empty | none | `—` |

Only the bar and the icon blink. The label and the time don't (Claude's call).

Gray means the timer can't run:
- tracking is paused, or the session isn't an active, unlocked local desktop
- Posture: the Bluetooth desk is unavailable
- Hands: there are no input counts, for example on Wayland

What "the change" means in each case:
- **Posture while sitting:** stand up, or start a movement break in fixed-desk mode.
- **Posture while standing or away, break not yet complete:** green, counting down until the break is complete.
- **Posture once the break is complete:** the "sit down again" reminder (orange, then red, as today).
- **Hands:** rest your hands for the configured break.

While typing has paused but the hand timer hasn't reset yet, Hands stays green, as `inputColor` does today. The time then counts down to the reset (Claude's call).

The panel's accessible name keeps describing both states, as it does today.

## 2. Reminder flow (bounded red window)

The same flow applies to all three reminders: **seated** (stand up), **stand** (sit down again after a completed break) and **input** (rest hands). All times are *active* time measured as today: seated and standing require `idle < postureActiveWindow`, and input requires `handsIdle < inputActiveWindow`. Idle, locked or paused time never advances orange, red or penalties.

Timeline for the seated reminder with default settings:

| Active time | State | Sound |
|---|---|---|
| 0–120 min | green | — |
| 120–122 min | orange (orange window = `seated-grace`) | silent |
| 122–132 min | red (red window = `red-window`, 10 min) | yes, if enabled |
| 127 min (halfway through red) | **penalty 1**: one miss added | continues |
| 132 min (end of red) | **penalty 2**: one miss added, then **reset** | stops |

**Reset** means the timer for the current state starts a new round:
- **Seated:** `seated = 0`. The user gets a full new seated round before the next reminder. This doesn't count as a stand.
- **Input:** `input = 0`. A full new typing round begins.
- **Stand ("sit down again"):** the standing timer restarts, so the next "sit down" reminder comes after another full break length (`stand-required`). The break stays complete: no new heeded point, and the seated timer isn't touched again (Claude's call).

Doing the change (standing up, sitting down, resting hands) ends the round at any moment:
- **Before red:** heeded point, as today.
- **During red, before penalty 1:** no point and no penalty (Claude's call). Today this situation can't happen, because a miss is charged when red starts.
- **After a penalty:** the penalties already charged remain.

This replaces today's rule: a miss when red starts, then one more every `*-repeat` minutes with no limit. A round now charges at most two misses, or four after a broken snooze (see below). The habit score formula (heeded ÷ heeded + missed) is unchanged.

### Snooze ("Snooze — leaving soon") (Claude's call: proposed in chat, not contradicted)

- Snooze is offered while a reminder is orange or red, once per round, as today.
- Snoozing silences the sound and stops the blinking: steady orange, and the time shows the snooze remaining. Snooze lengths stay as today (`seated-snooze`, `stand-snooze`, `input-snooze`).
- Penalties already charged in this round are taken back when snoozing.
- **If the user leaves** (lock, leaving the session, or idle ≥ `snooze-away`) while the snooze is running, nothing is charged, as today. *(Open for the builder check: what state the round is in when they come back.)*
- **If they're still working when the snooze runs out,** the reminder goes straight to red with sound for a full red window. Both penalties in that window count × `snooze-penalty` (default 2, so 4 misses at most). The timer then resets as usual.
- Snooze state survives Shell restarts, as today.

## 3. Sound

- **When it plays:**
  - The first time a reminder enters red.
  - Then every N seconds while any reminder is red, the user is active (not idle by the same measure that freezes the timer), and the reminder isn't snoozed.
  - It stops at reset, on the change, on snooze, on idle, on lock or on pause.
- If two reminders are red at once, it still plays once per interval, not once per reminder (Claude's call).
- **Do Not Disturb mutes the sound** (Claude's call, recommended in chat; the owner said "build it" without choosing). Mute while `org.gnome.desktop.notifications show-banners` is false. The bars and icons still blink. This check is part of the pure gating logic and gets a test and a README line. Today's banners were silenced by Do Not Disturb, so muting keeps that behaviour.
- **Repeat options:** Once, Every 15 seconds (default), Every 30 seconds, Every minute.
- **Sounds:** three bundled effects. Notification 3 is the default.
- **Playback:**
  - Reuse ai-monitor's approach (`ai-monitor/extension/sound.js`): spawn `gst-play-1.0 --quiet --no-interactive <uri>` and kill it after 15 s.
  - `gst-play-1.0` comes from `gstreamer1.0-plugins-base-apps`; add it to the README's apt prerequisites.
  - If the player or a sound file is missing, show a one-line message in the dropdown, the same way history errors appear today. Never throw.
- **Settings:** a ▶ preview button next to the sound choice plays it once, like ai-monitor (Claude's call).

## 4. No reminder banners

- Remove the reminder notifications in `_paint`: `_notify` and `this._alerts`.
- Remove the `notifications-enabled` key and its Settings switch.
- `Main.notify` for real failures stays: "Desk command failed" and "Desk unavailable" in `_deskAction` (Claude's call). Nothing else would tell the user about those.

## 5. Settings changes

Settings window (`extension/prefs.js`) and schema (`extension/schemas/org.gnome.shell.extensions.work-habbits.gschema.xml`):

| Change | Key | Default |
|---|---|---|
| Add a "Show icons in the top bar" switch (Tracking group) | `panel-icons` (b) | false |
| Remove "Show reminder notifications" | `notifications-enabled` | — |
| New **Sound** group: "Play a sound when a reminder turns red" switch | `sound-enabled` (b) | true (Claude's call) |
| Sound effect combo, labels "Notification 1/2/3", plus ▶ preview | `sound-effect` (u, 1–3) | 3 |
| Repeat combo: Once / Every 15 seconds / Every 30 seconds / Every minute | `sound-repeat` (u, seconds; 0 = once; choices 0/15/30/60) | 15 |
| Orange window defaults | `seated-grace`, `stand-grace` | 5 → **2** (Claude's call; the owner said "1–2 min") |
|  | `input-grace` | 1 (unchanged) |
| Relabel the three grace rows to "Orange warning before red" | | |
| Add "Red warning window" (Habit score group), description "Penalties at halfway and at the end; then the timer resets" | `red-window` (u, 2–60) | 10 |
| Remove "Further seated/standing/input minutes per miss" | `seated-repeat`, `stand-repeat`, `input-repeat` | — |

Key names are the builder's call, except that removed keys must be gone from the schema, `configure()` and `SETTINGS`. Existing installs keep values the user customized for the keys that remain.

## 6. Sound files and attribution

Folder: `extension/sounds/`. All three are Pixabay sounds under the Pixabay Content License. Notifications 1 and 3 are by **Universfield**.

The owner supplied the files as `notification_1.mp3` … `notification_3.mp3` in the project root. Move them (`git mv` is not possible since they're untracked; use a plain move) to `extension/sounds/notification_1.mp3` … `notification_3.mp3`, keeping the owner's names. Then delete the root copies.

| Setting label | File | Pixabay title | Page | sha256 of supplied file |
|---|---|---|---|---|
| Notification 1 | `notification_1.mp3` (2.4 s) | New Notification 065 | https://pixabay.com/sound-effects/technology-new-notification-065-494546/ | `54630ad061a7ba9fe381439d555e18a89c266c455506811681bb2067b8ecc7d2` |
| Notification 2 | `notification_2.mp3` (1.75 s) | Message (creator **SupremeTyLewisS**) | https://cdn.pixabay.com/download/audio/2022/01/07/audio_455a3917eb.mp3?filename=supremetylewiss-message-13716.mp3 | `3534dd37fcb4ea22075a7e6057927120c936d7f0d6a176ecdf84e2a4479fe48d` |
| Notification 3 (default) | `notification_3.mp3` (3.5 s) | New Notification 067 | https://pixabay.com/sound-effects/film-special-effects-new-notification-067-138695/ | `f00ce1645f1ce40f7e5d1b71306e68bfe4bd135124ed5f0594cc508fe7812d92` |

**Notification 2 (Claude's call, owner said "build it" without choosing).** The owner linked "Notification Chime" by Universfield, but the file they supplied is byte-identical to ai-monitor's `sound_effect_1.mp3`: "Message" by SupremeTyLewisS. Ship the supplied file and credit it correctly. Its source and sha come from ai-monitor's `docs/audio-provenance.json`. The thanks line names both Universfield and SupremeTyLewisS.

Pixabay answers automated requests with HTTP 403. Provenance for notifications 1 and 3 therefore records the Pixabay page URL as the source.

**Attribution**, copied from ai-monitor's pattern:
- A root `THIRD_PARTY_NOTICES.md`: Pixabay license, not MIT; thanks to Universfield; a file table; the restrictions paragraph.
- `docs/audio-provenance.json`: file, source, license, sha256 for each sound.
- A line in the README pointing to the notices file.

**Packaging and install:**
- `install.sh` installs `extension/sounds/*.mp3` into `$EXT/sounds/`.
- `install.sh` stops installing the sitting icon. `extension/icons/` keeps only the standing icon.
- `scripts/package.py` adds `THIRD_PARTY_NOTICES.md` to `FILES`. The sounds come along with the `extension` directory.
- The installer test (`tests/test_installer.py`) covers the new files.

## 7. Renderings for the README

The images are **renderings**, not screenshots. The README and `CONTRIBUTING.md` must say so, the way ai-monitor's README introduces "anonymized previews".

- **How (Claude's call):**
  - A single HTML file reproduces the final top bar and dropdown, using the real colors, sizes and font (Ubuntu) from `stylesheet.css` and the implementation.
  - Headless Chrome (`google-chrome --headless --screenshot`; Playwright's Chromium is also cached) turns it into PNGs.
  - Commit the HTML source next to the images so they can be updated. Document the one-line render command in `CONTRIBUTING.md`. No new build tooling or dependencies.
- **Folder (Claude's call):** `docs/previews/`. Remove `docs/screenshots/` and its five images.
- **Situations (Claude's call):**
  1. Panel, green: both items green.
  2. Panel, orange: Posture due, slow-blink frame.
  3. Panel, red: Posture red, counting down to a penalty.
  4. Panel with icons on: green, orange and red.
  5. Panel, snoozed.
  6. Panel, gray: Hands unavailable on Wayland.
  7. Dropdown, dark theme.
  8. Dropdown, light theme.
- **Sample data only**, matching the flow above (the times must agree with the defaults).
- **Must be produced after the implementation** and match it.

## 8. Docs to update

- **README:**
  - top-bar description and preview tables
  - "Reminders and counts": orange/red/penalty/reset flow, sound, no banners, snooze
  - habit-score paragraph: misses at halfway and end of red, maximum per round
  - Settings mentions
  - apt prerequisites (`gstreamer1.0-plugins-base-apps`)
  - third-party assets line
- **CONTRIBUTING.md:** the screenshots section becomes previews and renderings.

## 9. Testing

- **`tests/logic.test.mjs`:**
  - orange and red boundaries
  - penalties at halfway and at the end
  - reset per reminder (seated, stand, input)
  - heeded rules (before red earns a point; red before penalty 1 is neutral)
  - snooze: takeback, leaving forgives, the post-snooze window doubles
  - idle and lock never advance red
  - the maximum penalties per round
  - persistence across restart (derived from the saved timer values plus snoozes, as today)
- **`tests/dashboard.test.mjs`:**
  - the panel builds two items, with or without icons
  - bar fraction and colors per state
  - blink state per state
  - no `Main.notify` for reminders
- **`tests/settings.test.js`:** the new keys and the removed keys.
- **Sound timing logic** (when to play, repeat interval, gating) should live in pure code so node tests can cover it. Process spawning stays thin and untested, like ai-monitor's.
- `make check` must pass.
- **Manual desktop check** (owner, Ubuntu 24.04 / GNOME 46 / Xorg):
  - the panel looks right in light and dark
  - blinking
  - sound and its repeat
  - the snooze path
  - no banners
  - reload with Alt+F2 → `r`

## Left to the builder

- Internal structure: how penalty counts are derived, whether to keep the `_misses` bookkeeping, and how the post-snooze window is tracked. Prefer deriving from saved timer values, as today, so the daily record format stays `schemaVersion: 1`.
- Exact dropdown hint wording for the new flow, for example "Penalty in 3:12" or "Resets after the next penalty".
- Exact copy of new Settings descriptions.
