import hashlib
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class AudioProvenanceTest(unittest.TestCase):
    def test_every_bundled_sound_matches_its_recorded_hash_and_is_credited(self):
        entries = json.loads((ROOT / 'docs/audio-provenance.json').read_text())
        sounds = sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / 'extension/sounds').glob('*.mp3'))
        self.assertEqual(sorted(entry['file'] for entry in entries), sounds)
        notices = (ROOT / 'THIRD_PARTY_NOTICES.md').read_text()
        for entry in entries:
            self.assertEqual(hashlib.sha256((ROOT / entry['file']).read_bytes()).hexdigest(), entry['sha256'])
            self.assertIn(entry['file'], notices)


if __name__ == '__main__':
    unittest.main()
