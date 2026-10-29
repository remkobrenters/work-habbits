import json
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

from input_monitor import InputCounter, local_display, shortcut_keycodes


def frame(kind, fill=0):
    return bytes([kind]) + bytes([fill]) * 31


def key(kind, keycode):
    return bytes([kind, keycode]) + bytes(30)


class InputCounterTests(unittest.TestCase):
    def test_counts_only_presses_and_samples_motion(self):
        counter = InputCounter()
        counter.consume(frame(2) * 3 + frame(3) + frame(4) + frame(5) + frame(6), 1, 1000)
        counter.consume(frame(6), 1.1, 1000.1)
        counter.consume(frame(6), 1.3, 1000.3)
        batch = counter.snapshot(ready=True)
        self.assertEqual((batch['keys'], batch['clicks'], batch['moves']), (3, 1, 2))
        self.assertEqual(batch['lastInputWallMs'], 1000000)
        self.assertEqual(counter.snapshot(ready=True)['keys'], 0)

    def test_pointer_motion_alone_is_counted_but_does_not_end_a_hand_break(self):
        counter = InputCounter()
        counter.consume(frame(2), 1, 1000)
        counter.snapshot(ready=True)
        counter.consume(frame(6), 100, 1099)
        batch = counter.snapshot(ready=True)
        self.assertEqual((batch['moves'], batch['lastInputWallMs']), (1, 1000000))
        counter.consume(frame(2), 200, 1199)
        self.assertTrue(counter.snapshot(ready=True)['hadBreak'])

    def test_a_longer_hand_break_needs_longer_without_input(self):
        counter = InputCounter(break_seconds=180)
        counter.consume(frame(2), 1, 1000)
        counter.consume(frame(2), 150, 1149)
        self.assertFalse(counter.snapshot(ready=True)['hadBreak'])
        counter.consume(frame(2), 330, 1329)
        self.assertTrue(counter.snapshot(ready=True)['hadBreak'])

    def test_media_keys_do_not_end_a_hand_break(self):
        counter = InputCounter()
        counter.ignore_shortcuts(media=frozenset({172, 123}), supers=frozenset(), screen_lock=frozenset())
        counter.consume(frame(2), 1, 1000)
        counter.snapshot(ready=True)
        counter.consume(key(2, 172) + key(3, 172) + key(2, 123), 100, 1099)
        batch = counter.snapshot(ready=True)
        self.assertEqual((batch['keys'], batch['lastInputWallMs']), (0, 1000000))
        counter.consume(frame(2), 200, 1199)
        self.assertTrue(counter.snapshot(ready=True)['hadBreak'])

    def test_super_l_does_not_end_a_hand_break_but_a_plain_l_does(self):
        counter = InputCounter()
        counter.ignore_shortcuts(media=frozenset(), supers=frozenset({133}), screen_lock=frozenset({46}))
        counter.consume(frame(2), 1, 1000)
        counter.snapshot(ready=True)
        counter.consume(key(2, 133) + key(2, 46) + key(3, 46) + key(3, 133), 100, 1099)
        batch = counter.snapshot(ready=True)
        self.assertEqual((batch['keys'], batch['lastInputWallMs']), (0, 1000000))
        counter.consume(key(2, 46), 200, 1199)
        batch = counter.snapshot(ready=True)
        self.assertEqual((batch['keys'], batch['hadBreak']), (1, True))

    def test_shortcut_keys_are_looked_up_by_keysym_in_the_keyboard_map(self):
        keymap = {
            0x1008FF14: [(172, 0), (208, 0)],
            0x1008FF31: [(172, 1)],
            0x1008FF13: [(123, 0)],
            0xFFEB: [(133, 0)],
            0xFFEC: [(134, 0)],
            0x6C: [(46, 0)],
        }

        class Connection:
            def keysym_to_keycodes(self, keysym):
                return iter(keymap.get(keysym, []))

        self.assertEqual(
            shortcut_keycodes(Connection()),
            dict(media=frozenset({172, 208, 123}), supers=frozenset({133, 134}), screen_lock=frozenset({46})),
        )

    def test_two_minute_boundary_and_reset_is_reported_once(self):
        counter = InputCounter()
        counter.consume(frame(2), 1, 1000)
        counter.consume(frame(2), 120.5, 1119.5)
        self.assertFalse(counter.snapshot(ready=True)['hadBreak'])
        counter.consume(frame(2), 240.5, 1239.5)
        self.assertTrue(counter.snapshot(ready=True)['hadBreak'])
        self.assertFalse(counter.snapshot(ready=True)['hadBreak'])

    def test_payload_content_is_opaque_and_not_exported(self):
        batches = []
        for fill in (0, 42, 255):
            counter = InputCounter()
            counter.consume(frame(2, fill) + frame(6, fill), 1, 1000)
            batch = counter.snapshot(ready=True)
            batch.pop('heartbeat')
            batches.append(batch)
        self.assertEqual(batches[0], batches[1])
        self.assertEqual(batches[1], batches[2])
        self.assertEqual(set(batches[0]), {'keys', 'clicks', 'moves', 'ready', 'hadBreak', 'lastInputWallMs'})

    def test_scroll_steps_are_activity_but_not_mouse_clicks(self):
        counter = InputCounter()
        counter.consume(bytes([4, 4]) + bytes(30), 1, 1000)
        batch = counter.snapshot(ready=True)
        self.assertEqual(batch['clicks'], 0)
        self.assertEqual(batch['lastInputWallMs'], 1000000)

    def test_remote_display_is_rejected(self):
        self.assertTrue(local_display(':1'))
        self.assertTrue(local_display(':0.0'))
        for value in ('localhost:10.0', 'office:0', '', ':0\n'):
            self.assertFalse(local_display(value))

    def test_ssh_launch_fails_before_opening_any_input_source(self):
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve().parents[1] / 'input_monitor.py')],
            env={**os.environ, 'SSH_CONNECTION': 'remote local', 'DISPLAY': ':1'},
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(result.returncode, 1)
        self.assertFalse(json.loads(result.stdout)['ready'])
        self.assertEqual(result.stderr, '')

    @unittest.skipUnless(shutil.which('node'), 'Node is needed for the Python/JS integration test')
    def test_actual_summary_drives_js_counters_and_timer(self):
        counter = InputCounter()
        counter.consume(frame(2) + frame(4) + frame(6), 1, 1000)
        batch = counter.snapshot(ready=True)
        script = """
import {readFileSync} from 'node:fs';
import {WellnessModel} from './extension/logic.js';
const model = new WellnessModel();
model.onInputBatch(JSON.parse(readFileSync(0, 'utf8')));
model.update({dt: 1, wallMs: 1_000_100, localActive: true,
    deskReady: true, position: 'standing', idleSeconds: 0, inputAvailable: true});
console.log(JSON.stringify(model.serialize('2026-10-26')));
"""
        result = subprocess.run(
            ['node', '--input-type=module', '-e', script],
            cwd=Path(__file__).resolve().parents[1],
            input=json.dumps(batch),
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads(result.stdout)
        self.assertEqual((state['keys'], state['clicks'], state['moves'], state['input']), (1, 1, 1, 1))


if __name__ == '__main__':
    unittest.main()
