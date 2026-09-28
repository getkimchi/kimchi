import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("delivery", Path(__file__).with_name("delivery-diagnostic.py"))
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class StartupCleanupTests(unittest.TestCase):
    def test_failed_tmux_start_without_pane_keeps_original_error_and_cleans_home(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            trial = root / "trial"
            run = root / "work"
            run.mkdir()
            (run / "live-run.json").write_text(json.dumps({"tmux": "owned-run"}))
            manifest = {key: "hash" for key in ["binary_sha256", "fixture_sha256", "probe_sha256", "driver_sha256"]}

            def setup(*_args):
                (trial / "home").mkdir(parents=True)
                return trial, {}

            def command(args, **_kwargs):
                if args[0] == "tmux":
                    self.assertEqual(args[4], "=owned-run")
                    return subprocess.CompletedProcess(args, 1, "", "no server")
                if args[2] == "start":
                    return subprocess.CompletedProcess(args, 1, f"Run: {run}\n", "socket path too long")
                if args[2] == "stop":
                    return subprocess.CompletedProcess(args, 1, "", "no server")
                self.assertEqual(args[2], "status")
                return subprocess.CompletedProcess(args, 0, "Live: false\n", "")

            with mock.patch.object(delivery, "setup_trial", side_effect=setup), \
                 mock.patch.object(delivery, "read_json", side_effect=lambda p: manifest if p.name == "manifest.json" else json.loads(p.read_text())), \
                 mock.patch.object(delivery.runner, "digest", return_value="hash"), \
                 mock.patch.object(delivery.runner, "stop_descendants", side_effect=lambda captured: self.assertEqual(captured, {})), \
                 mock.patch.object(delivery.subprocess, "run", side_effect=command):
                with self.assertRaises(subprocess.CalledProcessError):
                    delivery.run_trial(root, "trial", "early")
            self.assertEqual(json.loads((trial / "cleanup.json").read_text()), {"live": False, "home_removed": True})
            self.assertEqual(json.loads((trial / "error.json").read_text())["type"], "CalledProcessError")


if __name__ == "__main__":
    unittest.main()
