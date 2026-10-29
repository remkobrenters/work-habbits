#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
BLUETOOTH=0
case ${1:-} in
    --bluetooth) BLUETOOTH=1 ;;
    --help|-h) printf 'Usage: ./install.sh [--bluetooth]\nInstall work-habbits for GNOME 46–50 (input counts require Xorg). No sudo.\n'; exit 0 ;;
    '') ;;
    *) fail 'Usage: ./install.sh [--bluetooth]' ;;
esac
[[ $# -le 1 ]] || fail 'Usage: ./install.sh [--bluetooth]'
[[ $(id -u) -ne 0 ]] || fail 'Run as your desktop user, without sudo.'
[[ -z ${SSH_CONNECTION:-}${SSH_TTY:-} ]] || fail 'Run this from your local desktop, not SSH.'
[[ ${XDG_SESSION_TYPE:-} == x11 || ${XDG_SESSION_TYPE:-} == wayland ]] || fail 'A local GNOME graphical session is required.'
if [[ $XDG_SESSION_TYPE == x11 ]]; then
    [[ ${DISPLAY:-} =~ ^:[0-9]+(\.[0-9]+)?$ ]] || fail 'A local X11 DISPLAY is required.'
else
    printf 'Wayland: posture and movement reminders are available; keyboard/mouse counts require Xorg.\n'
fi
SHELL_VERSION=$(gnome-shell --version)
[[ $SHELL_VERSION =~ ^GNOME\ Shell\ (46|47|48|49|50)(\.|$) ]] || fail 'Expected GNOME Shell 46–50. See README compatibility notes.'
systemctl --user is-active --quiet graphical-session.target || fail 'No active graphical session.'
SESSION=${XDG_SESSION_ID:-$(loginctl show-user "$(id -un)" -p Display --value)}
[[ -n $SESSION ]] || fail 'Could not find your desktop login session.'
[[ $(loginctl show-session "$SESSION" -p Remote --value) == no ]] || fail 'A local session is required.'
[[ $(loginctl show-session "$SESSION" -p Active --value) == yes ]] || fail 'Your desktop session must be active.'
[[ $(loginctl show-session "$SESSION" -p Name --value) == "$(id -un)" ]] || fail 'The session belongs to a different user.'
[[ $(loginctl show-session "$SESSION" -p Type --value) == "$XDG_SESSION_TYPE" ]] || fail 'Your graphical session type does not match the terminal.'
/usr/bin/python3 -c 'import sys; assert sys.version_info >= (3, 11); import gi; gi.require_version("Adw", "1"); from gi.repository import Gio, Adw; assert hasattr(Adw, "SpinRow")' || fail 'Python 3.11+, python3-gi and libadwaita 1.4+ bindings are required.'
command -v glib-compile-schemas >/dev/null || fail 'Install libglib2.0-bin first.'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HOME/.local/share/work-habbits"
EXT="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/work-habbits@local"
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
install -d -m 0700 "$APP"
if [[ ! -x $APP/.venv/bin/python ]]; then
    /usr/bin/python3 -m venv "$APP/.venv" || fail 'Install python3-venv first.'
fi
"$APP/.venv/bin/python" -m pip install --disable-pip-version-check --no-input -r "$HERE/requirements.txt"
if [[ $BLUETOOTH == 1 ]]; then
    "$APP/.venv/bin/python" -m pip install --disable-pip-version-check --no-input -r "$HERE/requirements-bluetooth.txt"
    "$APP/.venv/bin/python" -c 'import bleak; import dbus_fast'
fi
"$APP/.venv/bin/python" -c 'import Xlib.ext.record'

# Updating this extension must not change other installed applications.
if gnome-extensions info work-habbits@local >/dev/null 2>&1; then
    gnome-extensions disable work-habbits@local
fi
systemctl --user stop work-habbits-desk.service 2>/dev/null || true
install -d "$EXT" "$EXT/icons" "$EXT/schemas" "$APP/schemas" "$UNIT"
install -m 0644 "$HERE/desk_monitor.py" "$HERE/desk_service.py" "$HERE/input_monitor.py" "$APP/"
install -m 0644 "$HERE/work-habbits-desk.service" "$UNIT/work-habbits-desk.service"
install -m 0644 "$HERE/extension/"*.js "$HERE/extension/stylesheet.css" "$HERE/extension/metadata.json" "$EXT/"
install -m 0644 "$HERE/extension/schemas/"*.gschema.xml "$EXT/schemas/"
install -m 0644 "$HERE/extension/schemas/"*.gschema.xml "$APP/schemas/"
install -m 0644 "$HERE/extension/icons/"*.svg "$EXT/icons/"
glib-compile-schemas --strict "$EXT/schemas"
glib-compile-schemas --strict "$APP/schemas"
systemctl --user daemon-reload
systemctl --user enable --now work-habbits-desk.service

/usr/bin/python3 - <<'PY'
from gi.repository import Gio
settings = Gio.Settings.new('org.gnome.shell')
settings.delay()
uuid = 'work-habbits@local'
enabled = settings.get_strv('enabled-extensions')
if uuid not in enabled:
    enabled.append(uuid)
disabled = [value for value in settings.get_strv('disabled-extensions') if value != uuid]
if not settings.set_strv('enabled-extensions', enabled):
    raise SystemExit('Could not enable the extension')
if not settings.set_strv('disabled-extensions', disabled):
    raise SystemExit('Could not clear the extension disabled flag')
if not settings.set_boolean('disable-user-extensions', False):
    raise SystemExit('Could not enable user extensions')
settings.apply()
Gio.Settings.sync()
PY

printf '\nInstalled work-habbits. Log out and back in to load the extension.\n'
if [[ $XDG_SESSION_TYPE == x11 ]]; then
    printf 'On Xorg you can also reload Shell: Alt+F2, type restart, press Enter.\n'
fi
printf 'Open Settings from the panel menu to choose your desk mode.\n'
printf 'Bluetooth requires ./install.sh --bluetooth and a configured device address.\n'
printf 'Check installation: %s/status.sh\n' "$HERE"
