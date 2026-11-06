import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import wayland_setup


class WaylandSetupTests(unittest.TestCase):
    def test_authorized_setup_is_idempotent_and_applies_access_to_current_devices(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / '70-work-habbits-input.rules'
            unrelated = Path(directory) / 'example.rules'
            unrelated.write_text('other rule')
            with (
                patch.object(wayland_setup, 'RULE_PATH', target),
                patch('wayland_setup.subprocess.run') as run,
            ):
                wayland_setup.enable_input()
                original = target.stat().st_mtime_ns
                wayland_setup.enable_input()
            self.assertEqual(target.read_bytes(), wayland_setup.RULE)
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            self.assertEqual(target.stat().st_mtime_ns, original)
            self.assertEqual(unrelated.read_text(), 'other rule')
            self.assertEqual(
                sorted(item.name for item in target.parent.iterdir()), [target.name, 'example.rules']
            )
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(
                commands,
                [
                    ['/usr/bin/udevadm', 'control', '--reload-rules'],
                    ['/usr/bin/udevadm', 'trigger', '--action=change', '--subsystem-match=input'],
                    ['/usr/bin/udevadm', 'settle', '--timeout=10'],
                ]
                * 2,
            )

    def test_helper_uses_exactly_the_reviewable_bundled_rule(self):
        rule = Path(__file__).resolve().parents[1] / '70-work-habbits-input.rules'
        self.assertEqual(wayland_setup.RULE, rule.read_bytes())

    def test_an_existing_different_rule_or_symlink_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / '70-work-habbits-input.rules'
            target.write_text('custom rule')
            with (
                patch.object(wayland_setup, 'RULE_PATH', target),
                patch('wayland_setup.subprocess.run') as run,
            ):
                with self.assertRaises(ValueError):
                    wayland_setup.enable_input()
                self.assertEqual(target.read_text(), 'custom rule')
                target.unlink()
                original = Path(directory) / 'original'
                original.write_bytes(wayland_setup.RULE)
                target.symlink_to(original)
                with self.assertRaises(ValueError):
                    wayland_setup.enable_input()
                run.assert_not_called()
                self.assertTrue(target.is_symlink())
                self.assertEqual(original.read_bytes(), wayland_setup.RULE)

    def test_udev_failure_is_retryable_without_overwriting_an_existing_rule(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / '70-work-habbits-input.rules'
            with (
                patch.object(wayland_setup, 'RULE_PATH', target),
                patch('wayland_setup.subprocess.run', side_effect=subprocess.TimeoutExpired('udevadm', 15)),
            ):
                with self.assertRaises(subprocess.TimeoutExpired):
                    wayland_setup.enable_input()
            self.assertEqual(target.read_bytes(), wayland_setup.RULE)
            with patch.object(wayland_setup, 'RULE_PATH', target), patch('wayland_setup.subprocess.run'):
                wayland_setup.enable_input()

    def test_no_privileged_work_before_authorization_or_with_unexpected_arguments(self):
        with (
            patch('sys.argv', ['wayland_setup.py', '--enable']),
            patch('wayland_setup.os.geteuid', return_value=1000),
            patch('wayland_setup.enable_input') as enable,
            patch('builtins.print'),
        ):
            self.assertEqual(wayland_setup.main(), 1)
            enable.assert_not_called()
        for arguments in [[], ['--enable', '/tmp/different-rule'], ['--enable', '--rule=custom']]:
            with (
                self.subTest(arguments=arguments),
                patch('sys.argv', ['wayland_setup.py', *arguments]),
                patch('wayland_setup.enable_input') as enable,
                patch('sys.stderr'),
            ):
                with self.assertRaises(SystemExit) as result:
                    wayland_setup.main()
                self.assertEqual(result.exception.code, 2)
                enable.assert_not_called()


if __name__ == '__main__':
    unittest.main()
