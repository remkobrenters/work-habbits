import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


@unittest.skipUnless(importlib.util.find_spec('gi'), 'GNOME Python bindings required')
class InstallerEnablementTests(unittest.TestCase):
    def run_enablement(self, enabled, disabled):
        installer = Path(__file__).resolve().parents[1] / 'install.sh'
        # Exercise the actual installer settings block with a private in-memory
        # backend. No connection to or changes in the real desktop's settings.
        block = installer.read_text().split("/usr/bin/python3 - <<'PY'\n", 1)[1].split('\nPY', 1)[0]
        script = f"""
from gi.repository import Gio
settings = Gio.Settings.new('org.gnome.shell')
settings.set_strv('enabled-extensions', {enabled!r})
settings.set_strv('disabled-extensions', {disabled!r})
settings.set_boolean('disable-user-extensions', True)
exec(compile({block!r}, 'install.sh settings', 'exec'), {{}})
assert 'work-habbits@local' in settings.get_strv('enabled-extensions')
assert 'work-habbits@local' not in settings.get_strv('disabled-extensions')
expected_enabled = list({enabled!r})
if 'work-habbits@local' not in expected_enabled:
    expected_enabled.append('work-habbits@local')
assert settings.get_strv('enabled-extensions') == expected_enabled
assert settings.get_strv('disabled-extensions') == [value for value in {disabled!r} if value != 'work-habbits@local']
assert 'other-enabled@local' in settings.get_strv('enabled-extensions')
assert 'other-disabled@local' in settings.get_strv('disabled-extensions')
assert settings.get_boolean('disable-user-extensions') is False
"""
        result = subprocess.run(
            ['/usr/bin/python3', '-c', script],
            env={**os.environ, 'GSETTINGS_BACKEND': 'memory'},
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_upgrade_clears_disabled_flag(self):
        self.run_enablement(['other-enabled@local'], ['other-disabled@local', 'work-habbits@local'])

    def test_conflicting_enabled_and_disabled_lists_are_repaired(self):
        self.run_enablement(
            ['other-enabled@local', 'work-habbits@local'], ['other-disabled@local', 'work-habbits@local']
        )

    def test_unrelated_extensions_keep_their_enablement(self):
        self.run_enablement(
            ['other-enabled@local', 'sample-a@local', 'sample-b@local'],
            ['other-disabled@local', 'sample-a@local', 'sample-b@local'],
        )

    def test_first_install_preserves_other_extension_settings(self):
        self.run_enablement(['other-enabled@local'], ['other-disabled@local'])

    def test_install_and_uninstall_preserve_other_files_and_history(self):
        self.run_install_uninstall('x11', '46.9')

    def test_wayland_install_accepts_documented_shell_range_without_an_x11_display(self):
        self.run_install_uninstall('wayland', '50.0')

    def run_install_uninstall(self, session_type, shell_version):
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = root / '.local/share/work-habbits'
            binaries = root / 'bin'
            binaries.mkdir()
            (app / '.venv/bin').mkdir(parents=True)
            commands = {
                'id': '#!/bin/sh\ncase "$1" in -u) echo 1000;; *) echo tester;; esac\n',
                'gnome-shell': '#!/bin/sh\necho "GNOME Shell $TEST_SHELL_VERSION"\n',
                'systemctl': '#!/bin/sh\nprintf "systemctl %s\\n" "$*" >> "$COMMAND_LOG"\n',
                'gnome-extensions': '#!/bin/sh\nprintf "gnome-extensions %s\\n" "$*" >> "$COMMAND_LOG"\n',
                'loginctl': """#!/bin/sh
case "$*" in
  *Remote*) echo no;;
  *Active*) echo yes;;
  *Name*) echo tester;;
  *Type*) echo "$XDG_SESSION_TYPE";;
esac
""",
            }
            for name, script in commands.items():
                path = binaries / name
                path.write_text(script)
                path.chmod(0o700)
            # Installing packages is external I/O. All file installation and
            # schema compilation still use the real commands against this HOME.
            python = app / '.venv/bin/python'
            python.write_text('#!/bin/sh\nexit 0\n')
            python.chmod(0o700)
            history = root / 'state/work-habbits/days/2026-10-28.json'
            history.parent.mkdir(parents=True)
            history.write_text('private history marker')
            other_files = [
                root / '.local/share/example-app/helper.py',
                root / 'data/gnome-shell/extensions/example-extension@local/extension.js',
                root / '.config/systemd/user/example-app.service',
            ]
            for path in other_files:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('other application marker')
            env = {
                **os.environ,
                'HOME': str(root),
                'XDG_DATA_HOME': str(root / 'data'),
                'XDG_STATE_HOME': str(root / 'state'),
                'XDG_CONFIG_HOME': str(root / 'config'),
                'XDG_SESSION_TYPE': session_type,
                'XDG_SESSION_ID': 'test',
                'DISPLAY': ':99' if session_type == 'x11' else '',
                'TEST_SHELL_VERSION': shell_version,
                'SSH_CONNECTION': '',
                'SSH_TTY': '',
                'GSETTINGS_BACKEND': 'memory',
                'PATH': f'{binaries}:/usr/bin:/bin',
                'COMMAND_LOG': str(root / 'commands'),
            }
            installed = subprocess.run(
                ['bash', str(source / 'install.sh')], env=env, capture_output=True, text=True, timeout=20
            )
            self.assertEqual(installed.returncode, 0, installed.stderr)
            extension = root / 'data/gnome-shell/extensions/work-habbits@local'
            self.assertTrue((extension / 'extension.js').is_file())
            self.assertTrue((extension / 'icons' / 'standing-symbolic.svg').is_file())
            for index in (1, 2, 3):
                self.assertTrue((extension / 'sounds' / f'notification_{index}.mp3').is_file())
            self.assertTrue((extension / 'schemas/gschemas.compiled').is_file())
            self.assertTrue((app / 'schemas/gschemas.compiled').is_file())
            self.assertTrue((app / 'desk_service.py').is_file())
            self.assertEqual(app.stat().st_mode & 0o777, 0o700)
            unit = root / 'config/systemd/user/work-habbits-desk.service'
            self.assertTrue(unit.is_file())
            removed = subprocess.run(
                ['bash', str(source / 'uninstall.sh')], env=env, capture_output=True, text=True, timeout=20
            )
            self.assertEqual(removed.returncode, 0, removed.stderr)
            self.assertFalse(app.exists())
            self.assertFalse(extension.exists())
            self.assertFalse(unit.exists())
            self.assertEqual(history.read_text(), 'private history marker')
            for path in other_files:
                self.assertEqual(path.read_text(), 'other application marker')
            calls = (root / 'commands').read_text()
            self.assertNotIn('example-app', calls)
            self.assertNotIn('example-extension', calls)


class InstallerGuardTests(unittest.TestCase):
    def test_help_and_invalid_options_never_require_a_desktop(self):
        installer = Path(__file__).resolve().parents[1] / 'install.sh'
        for args, expected in [(['--help'], 0), (['--unknown'], 1), (['--bluetooth', 'extra'], 1)]:
            result = subprocess.run(
                ['bash', str(installer), *args], capture_output=True, text=True, timeout=5
            )
            self.assertEqual(result.returncode, expected)
            self.assertIn('Usage:', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
