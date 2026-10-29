import json
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts.import_workspace_monitor import ALL_METRICS, METRICS, convert, import_history


def record(day='2026-10-28', count=10):
    return {
        'schemaVersion': 1,
        'date': day,
        'metrics': {
            **dict.fromkeys(METRICS, count),
            'remindersHeeded': 3,
            'remindersMissed': 7,
            'workSeconds': 123,
        },
        'reminders': {
            'seatedSeconds': 100,
            'standingRunSeconds': 50,
            'inputSeconds': 20,
            'standComplete': True,
            'lastInputWallMs': 1000,
            'snoozes': {'input': {'charged': 4}},
        },
    }


class ImportHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.target = self.root / 'target'
        (self.source / 'days').mkdir(parents=True)

    def write(self, directory, value):
        (directory / 'days').mkdir(parents=True, exist_ok=True)
        path = directory / 'days' / f'{value["date"]}.json'
        path.write_text(json.dumps(value))
        return path

    def test_conversion_preserves_counts_penalties_and_reminder_progress(self):
        converted = convert(record())
        self.assertEqual(converted['metrics']['remindersMissed'], 7)
        self.assertEqual(converted['metrics']['remindersHeeded'], 3)
        self.assertEqual(converted['metrics']['keyStrokes'], 10)
        self.assertEqual(converted['metrics']['awaySeconds'], 0)
        self.assertEqual(
            converted['reminders'],
            {
                'seated': 100,
                'standingRun': 50,
                'input': 20,
                'standComplete': True,
                'lastInputWallMs': 1000,
            },
        )

    def test_older_records_without_scores_or_standing_progress(self):
        old = record()
        del old['metrics']['remindersMissed'], old['metrics']['remindersHeeded']
        del old['reminders']['standingRunSeconds']
        converted = convert(old)
        self.assertEqual(converted['metrics']['remindersMissed'], 0)
        self.assertEqual(converted['reminders']['standingRun'], 0)

    def test_dry_run_writes_nothing(self):
        self.write(self.source, record())
        result = import_history(self.source, self.target)
        self.assertEqual(result['status'], 'dry-run')
        self.assertFalse(self.target.exists())

    def test_import_archives_exact_originals_and_preserves_unrelated_days(self):
        source_path = self.write(self.source, record())
        original = source_path.read_bytes()
        unrelated = self.write(self.target, convert(record('2026-10-27')))
        unrelated_raw = unrelated.read_bytes()
        result = import_history(self.source, self.target, apply=True)
        backup = Path(result['backup'])
        self.assertEqual(source_path.read_bytes(), original)
        self.assertEqual((backup / 'source' / source_path.name).read_bytes(), original)
        self.assertEqual((backup / 'destination' / unrelated.name).read_bytes(), unrelated_raw)
        self.assertEqual(unrelated.read_bytes(), unrelated_raw)
        self.assertEqual(json.loads((backup / 'manifest.json').read_bytes())['status'], 'complete')
        for path in (backup, backup / 'source', self.target / 'days'):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        for path in (backup / 'source' / source_path.name, self.target / 'days' / source_path.name):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_overlap_requires_explicit_policy(self):
        self.write(self.source, record())
        current = self.write(self.target, convert(record()))
        original = current.read_bytes()
        with self.assertRaisesRegex(ValueError, 'Existing dates'):
            import_history(self.source, self.target, apply=True)
        self.assertEqual(current.read_bytes(), original)
        self.assertFalse((self.target / 'imports').exists())

    def test_max_overlap_does_not_sum_and_preserves_source_reminder_progress(self):
        self.write(self.source, record())
        current = convert(record(count=20))
        current['metrics'].update(awaySeconds=40, remindersMissed=12, keyStrokes=2)
        current['reminders'].update(lastInputWallMs=2000, input=99)
        path = self.write(self.target, current)
        original = path.read_bytes()
        result = import_history(self.source, self.target, apply=True, overlap='max')
        imported = json.loads(path.read_bytes())
        self.assertEqual(imported['metrics']['keyStrokes'], 10)
        self.assertEqual(imported['metrics']['mouseClicks'], 20)
        self.assertEqual(imported['metrics']['awaySeconds'], 40)
        self.assertEqual(imported['metrics']['remindersMissed'], 12)
        self.assertEqual(imported['reminders']['input'], 20)
        self.assertEqual((Path(result['backup']) / 'destination' / path.name).read_bytes(), original)

    def test_second_import_cannot_overwrite_new_activity(self):
        self.write(self.source, record())
        import_history(self.source, self.target, apply=True)
        current = convert(record(count=500))
        path = self.write(self.target, current)
        with self.assertRaisesRegex(ValueError, 'already started or completed'):
            import_history(self.source, self.target, apply=True, overlap='max')
        self.assertEqual(json.loads(path.read_bytes()), current)

    def test_invalid_record_prevents_all_writes(self):
        self.write(self.source, record('2026-10-27'))
        bad = record()
        bad['metrics']['keyStrokes'] = -1
        self.write(self.source, bad)
        with self.assertRaisesRegex(ValueError, 'invalid daily record'):
            import_history(self.source, self.target, apply=True)
        self.assertFalse(self.target.exists())

    def test_corrupt_destination_is_preserved(self):
        self.write(self.source, record())
        path = self.write(self.target, convert(record()))
        path.write_text('{corrupt')
        with self.assertRaises(ValueError):
            import_history(self.source, self.target, apply=True, overlap='max')
        self.assertEqual(path.read_text(), '{corrupt')

    def test_rejects_invalid_dates_booleans_and_nonfinite_metrics(self):
        for metric in (True, float('nan'), float('inf'), -1):
            with self.subTest(metric=metric), self.assertRaises(ValueError):
                bad = record()
                bad['metrics']['keyStrokes'] = metric
                convert(bad)
        for day in ('2026-02-30', '1999-10-28', '2026-1-01'):
            with self.subTest(day=day), self.assertRaises(ValueError):
                convert(record(day))

    def test_detects_destination_writes_before_importing_any_day(self):
        self.write(self.source, record())
        from scripts import import_workspace_monitor as importer

        original_write = importer.atomic_write

        def concurrent_write(path, raw):
            original_write(path, raw)
            if path.name == 'manifest.json' and json.loads(raw)['status'] == 'applying':
                self.write(self.target, convert(record(count=200)))

        with patch.object(importer, 'atomic_write', concurrent_write):
            with self.assertRaisesRegex(ValueError, 'Destination changed'):
                import_history(self.source, self.target, apply=True)
        current = json.loads((self.target / 'days/2026-10-28.json').read_bytes())
        self.assertEqual(current['metrics']['keyStrokes'], 200)

    def test_destination_format_contains_all_expected_metrics(self):
        self.assertEqual(set(convert(record())['metrics']), set(ALL_METRICS))


if __name__ == '__main__':
    unittest.main()
