import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import updater


class UpdaterTests(unittest.TestCase):
    def test_version_comparison_uses_numeric_parts(self) -> None:
        self.assertGreater(updater.version_key("2.1.10"), updater.version_key("2.1.9"))

    def test_installed_version_is_optional(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(updater.installed_version(Path(directory)))

    def test_one_shot_is_not_used_for_source_runs(self) -> None:
        with patch.object(updater.sys, "frozen", False, create=True):
            self.assertEqual(updater._run_one_shot_from_temp([]), -1)

    def test_temp_cleanup_is_noop_without_worker_directory(self) -> None:
        with patch.dict(updater.os.environ, {}, clear=True), patch.object(updater.subprocess, "Popen") as popen:
            updater._schedule_temp_cleanup()
        popen.assert_not_called()

    def test_noon_schedule_is_positive(self) -> None:
        self.assertGreater(updater.seconds_until_noon(), 0)

    def test_download_rejects_wrong_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "setup.exe"
            release = updater.Release("v1", "1", "https://example.invalid/setup.exe", "0" * 64)
            with patch.object(updater, "_request", return_value=b"installer"):
                with self.assertRaises(updater.UpdateError):
                    updater.download_release(release, destination)
            self.assertFalse(destination.exists())

    def test_download_accepts_matching_digest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "setup.exe"
            content = b"installer"
            release = updater.Release(
                "v1",
                "1",
                "https://example.invalid/setup.exe",
                updater.hashlib.sha256(content).hexdigest(),
            )
            with patch.object(updater, "_request", return_value=content):
                updater.download_release(release, destination)
            self.assertEqual(destination.read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
