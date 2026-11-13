# work-habbits

**v1.4.0** · [Release notes](docs/releases/v1.4.0.md)

A small GNOME extension for desk posture, movement breaks, and keyboard/mouse activity. The top bar shows posture, short hand break and long hand break progress bars; the menu keeps colored reminder cards, a habit score graph, and daily/weekly/monthly totals. Activity stays on your computer; there are no accounts, telemetry, HTTP clients, or remote control endpoints.

## Previews

Rendered previews of the interface with sample data. They are not desktop screenshots. Click an image to view it at full size.

### Top bar

Posture, Short hands, and Long hands each show a label, a bar that fills toward the next change, and the time left.

| Plenty of time | Change due | Too late |
| --- | --- | --- |
| ![Top bar with green Posture, Short hands, and Long hands bars](docs/previews/panel-green.png) | ![Full orange Posture bar that blinks slowly, 1 minute 12 seconds before red](docs/previews/panel-orange.png) | ![Full red Posture bar that blinks fast, 3 minutes 48 seconds until the next penalty](docs/previews/panel-red.png) |

| Snoozed | Hand input unavailable | Optional icons |
| --- | --- | --- |
| ![Steady orange Posture bar while snoozed, 14 minutes 12 seconds left](docs/previews/panel-snoozed.png) | ![Gray, empty Short and Long hands bars when input access is unavailable](docs/previews/panel-unavailable.png) | ![Standing figure and keyboard icons colored like their bars in green, orange and red](docs/previews/panel-icons.png) |

### Menu

The menu brings posture and hand reminders, the habit score, and activity totals together in both themes.

| Light theme | Dark theme |
| --- | --- |
| [![Menu in a light theme: habit score, posture and two hand break cards, snooze button and activity totals](docs/previews/menu-light.png)](docs/previews/menu-light.png) | [![Menu in a dark theme: habit score, posture and two hand break cards, snooze button and activity totals](docs/previews/menu-dark.png)](docs/previews/menu-dark.png) |

When a Wayland session needs input permission, the Long hand break card offers setup:

[![Rendered menu with unavailable hand break cards and Enable Wayland input button](docs/previews/menu-wayland-setup.png)](docs/previews/menu-wayland-setup.png)

## Compatibility

**Desktop-tested on Ubuntu 24.04 LTS, GNOME Shell 46, Xorg.** Other combinations below are expected to work from the documented APIs and compatibility checks; they have not been desktop-tested.

GNOME Shell 50.1 also passes an isolated headless Shell test for native UI, permission explanation, generated input summaries, manual posture and pause/resume. Physical evdev input and actual administrator authorization still need a desktop check.

| Setup | Status | Features |
| --- | --- | --- |
| Ubuntu 24.04 LTS, GNOME 46, Xorg | Tested | Posture, movement breaks, typing and clicking counts |
| GNOME 46–48 on Xorg, other Linux distributions | Expected; untested | Same features, with the prerequisites below |
| GNOME 46–50 on Wayland, including Ubuntu 26.04 LTS / GNOME 50 | Implemented; desktop verification pending | Posture, movement breaks, physical keyboard/mouse counts and hand reminders; [input access setup](#wayland-input-setup) required for counts |
| Other GNOME versions; KDE, Xfce, MATE; Windows/macOS | Not supported | Contributions welcome |

Requirements: Python 3.11+, GTK 4 with libadwaita 1.4+ bindings, GSettings, a local GNOME graphical session, and systemd user services. Optional Bluetooth requires BlueZ 5.55+ and a compatible desk. Xorg input counts use X11 RECORD. Wayland input counts use Linux evdev with explicitly granted device access; graphical setup uses polkit's `pkexec` and udev. XWayland is never used for counts.

The compatibility assessment follows the [GNOME 47](https://gjs.guide/extensions/upgrading/gnome-shell-47.html), [48](https://gjs.guide/extensions/upgrading/gnome-shell-48.html), [49](https://gjs.guide/extensions/upgrading/gnome-shell-49.html), and [50](https://gjs.guide/extensions/upgrading/gnome-shell-50.html) porting guides. Ubuntu 26.04 ships [GNOME 50 on Wayland](https://documentation.ubuntu.com/release-notes/26.04/changes-since-previous-interim/); upstream GNOME 50 removes the X11 session. The extension handles both widget-orientation and theme-color APIs used across these versions.

Please submit a **pull request** with improvements, fixes, or compatibility results. Include the distribution, GNOME version, session type, and what you tested. Expected compatibility is not a guarantee of hardware behavior.

## Desk modes

| Mode | How it works |
| --- | --- |
| **Manual** (default) | Move your desk yourself, then select **I am standing** or **I am sitting**. No Bluetooth connection. |
| **Bluetooth** | Read height and explicitly raise/lower a TiMOTION TWD1-compatible Nordic UART desk. Requires its Bluetooth address. |
| **Disabled** | For a fixed desk. Select **Start movement break** before a walk, then **Back at desk** when you return. No desk commands. |

Input counts work independently of Bluetooth availability on Xorg and Wayland. Pausing **Tracking** stops input collection and the Bluetooth helper. On Wayland, the hands indicator explains when input access setup is needed; posture and movement reminders remain available without it.

## Install

Use a terminal in your active local GNOME desktop session, without sudo. On Ubuntu, install prerequisites once:

```bash
sudo apt install python3-venv python3-gi gir1.2-adw-1 libglib2.0-bin gstreamer1.0-plugins-base-apps
```

From the checkout:

```bash
./install.sh
```

For optional Bluetooth support, use `./install.sh --bluetooth` instead, or run it later. Python packages stay in the application's virtual environment: `python-xlib` and `six`, plus `bleak` and `dbus-fast` with Bluetooth enabled. There is no JavaScript dependency installation or build framework.

Wayland input tracking uses system Python and keeps working if a distribution upgrade changes the Python version. If optional Bluetooth dependencies need rebuilding after an upgrade, rerun `./install.sh`. It repairs an environment with missing pip and reinstalls dependencies for the current Python, preserving a previous Bluetooth installation.

Log out and back in to load the extension. On Xorg, **Alt+F2 → restart → Enter** also reloads Shell. Updated JavaScript modules need a new Shell process; disabling and re-enabling the extension does not reload cached code. Wayland does not support an in-place Shell restart that preserves open windows. You can install the update while working and defer logout until convenient; it loads at your next login. Do not force a Shell restart while you need to keep your current windows.

Open **Settings** in the panel menu to select a desk mode, adjust heights, reminder times and the reminder sound and its volume, or reset defaults. Settings survive reinstalls. New installations and reset defaults use manual mode; Bluetooth is opt-in.

Installation paths:

- Extension: `${XDG_DATA_HOME:-~/.local/share}/gnome-shell/extensions/work-habbits@local`
- Helpers and Python environment: `~/.local/share/work-habbits`
- Service: `${XDG_CONFIG_HOME:-~/.config}/systemd/user/work-habbits-desk.service`
- Preferences: GSettings schema `org.gnome.shell.extensions.work-habbits`

Install/uninstall manage only work-habbits. Other applications, extensions, services, settings, and history stay untouched. Only one application should control a physical Bluetooth desk at a time. work-habbits can use an existing connection to the configured desk, including one made through GNOME Bluetooth or `bluetoothctl`. It does not force a disconnect before attaching. While tracking, its Bluetooth client manages that connection and releases it when stopped.

### Wayland input setup

Once this version is installed, switching from Xorg to Wayland automatically selects the Wayland backend. The tool detects missing input permission and offers **Enable Wayland input…** in the panel menu's Long hand break card:

1. Open the panel menu and choose **Enable Wayland input…**.
2. Review the permission explanation, choose **Enable**, and approve GNOME's administrator dialog.
3. Input counts and hand reminders resume automatically. This permission step needs no terminal commands, logout, or reboot.

Cancelling keeps posture and movement reminders working and leaves the setup action available; it never opens repeated authorization prompts. Permission setup is only offered for access failures, not when a device is disconnected. The new version must be installed once; older versions do not update themselves.

Wayland counts use physical keyboard, mouse and touchpad events from Linux evdev, across native Wayland and XWayland applications. Mutter consumes application input before extension event filters and Shell actor signals can observe it ([Mutter event handling](https://github.com/GNOME/mutter/blob/50.1/src/core/events.c), [Clutter filter ordering](https://github.com/GNOME/mutter/blob/50.1/clutter/clutter/clutter-event.c)); listening only to the Shell would miss activity in applications.

Linux restricts access to these devices. The optional rule grants the active local seat user access to keyboards, mice and touchpads through systemd's `uaccess` ACLs. **Other programs running as that user gain raw input access too, including password-field input.** Locking does not revoke those ACLs; work-habbits itself closes its readers and discards summaries when locked or outside the active local session. Enable it only if you accept that permission change. The normal installer never changes system input permissions, adds you to the `input` group, or runs a root input reader.

After explicit approval, a short-lived setup helper installs only the fixed `70-work-habbits-input.rules` file, reloads udev, and applies access to current devices. It preserves conflicting rules and uses [polkit's normal administrator authorization](https://polkit.pages.freedesktop.org/polkit/pkexec.1.html); there is no passwordless policy or background root service. Reconnected keyboards and mice receive the same active-seat access automatically. Missing permissions or disconnected devices are retried; incomplete device coverage disables hand reminders instead of presenting partial counts as complete.

<details>
<summary>Manual fallback if graphical authorization is unavailable</summary>

Install your distribution's `pkexec` package to use the menu action, or apply the same rule from this checkout:

```bash
sudo install -m 0644 70-work-habbits-input.rules /etc/udev/rules.d/70-work-habbits-input.rules
sudo udevadm control --reload-rules
sudo udevadm trigger --action=change --subsystem-match=input
```

</details>

Counts describe device activity before compositor remapping. Physical mouse buttons count as clicks, including side buttons. Software-generated events (such as the on-screen keyboard), touchpad tap-to-click, and compositor-generated clicks are not counted as physical clicks. Touchpad contact and finger motion count as hand activity, so gestures keep the hand timer running; ordinary mouse motion alone still does not. The media-key and Super+L exclusions use Linux physical key codes on Wayland.

To revoke the optional permission, remove this application's rule, reload the rules, then reboot to close existing device descriptors and reset ACLs:

```bash
sudo rm /etc/udev/rules.d/70-work-habbits-input.rules
sudo udevadm control --reload-rules
```

The user-level uninstaller leaves this optional system rule in place. Remove it separately if you enabled it.

## Reminders and counts

Configurable defaults:

- After **120 active seated minutes**, remind you to stand or take a movement break; red after 2 more active minutes.
- A **20-minute stand or marked movement break** resets the seated timer. Remind you to return to sitting, with a 2-minute orange warning before red.
- After **20 active input minutes**, remind you to take a **20-second short hand break**; red after one more active minute. Short breaks cannot be snoozed.
- After **60 active input minutes**, remind you to take a **5-minute long hand break**; red after one more active minute. Five minutes without typing or clicking, including idle time, completes it. A long break also completes an outstanding short break.
- Red lasts at most **10 active minutes**: a penalty halfway, another at the end, then the timer for your current posture or your hands starts a new round. An ignored reminder never charges more than two misses per round.

The top bar shows Posture, Short hands and Long hands, each with a bar that fills toward the next change and the time until it. Bars, and the optional icons, are green before a deadline, blink orange slowly when due, blink red fast when too late, and are gray when unavailable. In orange the time counts down to red; in red it counts down to the next penalty.

Orange is silent. When a reminder turns red, a sound plays and repeats every 15 seconds by default while you keep working (once, every 15 or 30 seconds, or every minute; three bundled sounds at an adjustable volume, 70% by default). Locked, idle and paused time stays silent, and GNOME's Do Not Disturb mutes the sound while the bars keep blinking. Reminders never show desktop banners. Sounds play through `gst-play-1.0`.

Sitting/standing activity totals accumulate while the local desktop is active and idle time is below 60 seconds. A standing break continues without input while the local session is unlocked. A marked walk continues while locked, but pauses when tracking is disabled or the login becomes inactive. Mark your return explicitly; manual posture is your report, not sensor data.

Both hand timers run while input happened within the last 10 seconds. Typing, clicks, and scrolling indicate activity; wheel steps are not clicks. Pointer movement is sampled at most five times per second; ordinary mouse motion does not restart hand activity. Wayland touchpad contact and finger motion also indicate hand activity. Media keys and Super+L do not end a hand break. Device key auto-repeat counts as presses.

Locking, switching users/TTYs, and remote sessions stop input collection. A Bluetooth disconnect pauses sensor-based posture timers. Suspend and process downtime never count as inferred activity. Daily totals and reminder progress persist across extension restarts and start anew each local calendar day.

Tracking can be paused in Settings; this pauses collection, reminders and the Bluetooth helper while keeping history. The menu shows a **Snooze — leaving soon** button while a posture or long hand reminder is orange or red, once per round. It snoozes standing/sitting reminders for 15 minutes and long hand reminders for 10 minutes (configurable). Short hand reminders continue during a snooze. A snoozed bar stays steady orange, its sound stops, and penalties already charged in this round are taken back. If you are still working when the snooze runs out, a fresh red window starts in which both penalties count twice by default, so at most four misses. Taking the break clears the snooze. Locking, leaving the local session or prolonged idle time cancels the double penalty. Locked and idle time never advances a red window. Snoozes survive Shell restarts.

The red-to-green habit score shows timely breaks divided by all scored reminders over the last 14 active days (configurable). Completing a posture break before red, returning to sitting before red, and completing either hand break after orange but before red earn points. Doing so in red before the first penalty earns nothing and costs nothing. A red window charges a miss halfway and another at its end, then starts a new round. Ordinary hand rests before a reminder earn no points. Inactive time adds no misses.

## Bluetooth protocol and safety

Bluetooth mode is for **TiMOTION TWD1-compatible Nordic UART desks**. Nordic UART alone does not establish desk compatibility. No device address or device-specific name is distributed.

After installing with `--bluetooth`, list nearby devices without connecting:

```bash
~/.local/share/work-habbits/.venv/bin/python \
  ~/.local/share/work-habbits/desk_monitor.py --scan
```

Confirm your compatible desk's address and enter it in Settings. Scan results remain in your terminal. The desktop's normal Bluetooth permissions apply; no root input reader or input-group membership is required. Another controller or phone app may occupy the connection.

The menu offers **Raise desk**, **Lower desk**, and **Stop the desk**. Reminders never trigger a move automatically. Height is classified at the midpoint of your configured sitting and standing heights (80/112 cm defaults).

- Host writes `6e400002-b5a3-f393-e0a9-e50e24dcca9e`; desk notifies `6e400003-b5a3-f393-e0a9-e50e24dcca9e`.
- Notification byte 3 is height in cm. Software targets are limited to 65–130 cm.
- Up/down frames: `d9 ff 01 63 3c` / `d9 ff 02 60 3a`, every 200 ms. STOP/query is five zero bytes.
- Connecting sends STOP/query to obtain height. **Reconnecting can stop an already-moving desk.**
- Conservative braking margins stop motion before the target to allow for coasting. The target is approximate; use the handset for fine adjustment. Different controllers can coast differently.
- Movement stops after 2 seconds without progress or 60 seconds total. Bluetooth writes have a 2-second timeout. Cancellation attempts STOP; no automatic reverse/correction move follows an overshoot.

Keep the travel path clear and stay at the desk. A failed Bluetooth link can prevent STOP arriving; keep the physical handset available. Software controls do not replace the desk's own collision protection. The protocol reference is [go-Stand-Up-Pls](https://github.com/2easy/go-Stand-Up-Pls); transport uses [Bleak](https://bleak.readthedocs.io/).

## Privacy and history

The input helper receives X11 RECORD events on Xorg or Linux evdev events on Wayland, including input in password fields, and reduces them in memory to counts and an activity timestamp. It never emits or stores typed text, keycodes, passwords, window titles, or pointer coordinates. Raw event buffers are not logged. One-second summaries travel over a private process pipe. The Wayland reader checks logind session ownership, active state, lock state and seat before opening devices and again before publishing summaries; the extension separately enforces its own session and tracking checks.

One aggregate JSON file per local calendar day lives in:

```text
${XDG_STATE_HOME:-~/.local/state}/work-habbits/days/YYYY-MM-DD.json
```

The panel icon shows sitting or standing based on desk height in Bluetooth mode, or your selection in manual mode. Movement breaks are walks explicitly marked in fixed-desk mode; their row is shown only in that mode. Hidden movement-break history is retained. History messages appear in the menu only when saving or reading fails.

Records contain sitting/standing/away seconds, key/click/movement counts, reminder progress/outcomes, and the last hand-input timestamp needed to restore breaks. Weeks start Monday; months follow the local calendar. There is no raw event log, server, or database.

Files have owner-only permissions and are replaced atomically every 30 seconds, on day rollover, and when the extension is disabled. Abrupt shutdown may lose the unsaved interval. Failed saves are retried; unreadable records are reported and preserved. Records remain until you delete them. Back up the directory yourself. Startup cost grows with retained daily records.

Bluetooth status and its command socket live in the owner-only `$XDG_RUNTIME_DIR/work-habbits` directory. Other programs running as your user are trusted and can access that user's data and local commands. SSH/TTY input does not count. A remote client mirroring the existing local desktop can see its indicators; injected input counts on Xorg, while Wayland counts are limited to the selected seat's Linux input devices.

## Troubleshooting and uninstall

### GNOME 50 startup error in v1.3.0

v1.3.0 calls `Meta.is_wayland_compositor()`, which GNOME 50 removed. This prevents the input helper from starting and stops menu updates; reinstalling v1.3.0 does not fix it. v1.3.1 handles the removed API and reports the actual cause of any later startup failure.

Install v1.3.1 normally. If you need to restore an already-running v1.3.0 session without logging out, press **Alt+F2**, enter **lg**, and paste this into Looking Glass's evaluator:

```javascript
(() => { Meta.is_wayland_compositor = () => true; const e = Main.extensionManager.lookup('work-habbits@local').stateObj; e.disable(); e.enable(); })()
```

Press Enter, then Escape. This temporary compatibility shim restarts only Work Habbits in the current session; it does not restart GNOME Shell or close application windows. Choose **Enable Wayland input…** in the panel menu if permission is needed. The shim disappears at logout; the installed v1.3.1 code handles the next session without it. This recovery was verified against v1.3.0 in an isolated GNOME 50.1 session with generated input.

### Diagnostics

```bash
./status.sh
gnome-extensions info work-habbits@local
journalctl --user -u work-habbits-desk.service -n 30 --no-pager
```

Diagnostic output can include local paths, Bluetooth addresses, and activity totals; inspect it before sharing. Bluetooth status being absent/stale is normal in manual/disabled mode. The service runs a settings watcher; a running service does not imply a connected desk. The panel shows live totals; disk snapshots update every 30 seconds.

Reinstall/reload for missing helpers. On Wayland, choose **Enable Wayland input…** if the Long hand break card reports missing access. If setup fails, verify that `pkexec` and udev are installed and that `/etc/udev/rules.d/70-work-habbits-input.rules` has not been replaced with a custom file or symlink; setup preserves those rather than overwriting them. Verify typing and clicking increase counts in both a native Wayland app and an XWayland app, then confirm 20 seconds of rest resets the short timer and five minutes resets the long timer. Check lock/unlock, pause/resume, keyboard/mouse reconnects and manual posture toggles before testing Bluetooth with clear travel space and an accessible handset. Simulated tests cannot certify hardware behavior.

Uninstall with `./uninstall.sh`. History and preferences remain. To reset preferences while installed:

```bash
gsettings --schemadir ~/.local/share/work-habbits/schemas \
  reset-recursively org.gnome.shell.extensions.work-habbits
```

Delete the work-habbits history directory separately if you want to discard it.

## One-time import from Workspace Monitor

Keep Work Habbits disabled during the import so its in-memory history cannot overwrite imported records. Preview first, then apply:

```bash
python3 scripts/import_workspace_monitor.py
python3 scripts/import_workspace_monitor.py --apply
```

The importer uses the applications' directories under `${XDG_STATE_HOME:-~/.local/state}`; `--source` and `--target` override them. It imports daily posture and input counts, heeded reminders, and already-scored penalties, and translates reminder progress. It never changes Workspace Monitor's files. Today's source record is the last saved snapshot; stop Workspace Monitor first for a final save when switching tools.

Existing dates stop the import by default. After checking for overlapping tracking, `--overlap max` keeps the larger value of each metric for those dates. This avoids counting overlapping activity twice; disjoint activity on the same day needs manual reconciliation. Workspace Monitor supplies reminder progress so a brief overlap with a fresh Work Habbits installation does not reset established timers.

Owner-only backups of both applications' original records, the import plan, and a manifest are kept in `work-habbits/imports/workspace-monitor/`. These preserve fields not mapped by the importer, including working time and original snooze snapshots. A journal prevents a second import from overwriting subsequent activity; an interrupted import also stops for manual recovery using these backups. Enable Work Habbits after a successful import.

## Development and publication

[CONTRIBUTING.md](CONTRIBUTING.md) covers checks, previews, and GitHub setup. [SECURITY.md](SECURITY.md) covers vulnerability reporting. GitHub checks code style, security lint, shell/JavaScript syntax, schemas, behavior, and dependency advisories on pushes/PRs and weekly. Dependabot proposes weekly updates. `make dist` creates a source archive that excludes local configuration and caches.

Licensed under [MIT](LICENSE). Bundled notification sounds are third-party Pixabay content; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
