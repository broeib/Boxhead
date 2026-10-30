"""Offline integrity regressions for the public runtime builder."""
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("public_runtime_build", Path(__file__).with_name("build.py"))
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class PackageGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = self.root / "package"
        self.package.mkdir()
        for name in ("overlay", "overlay-manifest.json", "LICENSE_MIT", "LICENSE_APACHE"):
            source = builder.ROOT / name
            if source.is_dir():
                shutil.copytree(source, self.package / name)
            else:
                shutil.copy2(source, self.package / name)

    def manifest(self, change):
        file = self.package / "overlay-manifest.json"
        data = json.loads(file.read_text())
        change(data)
        file.write_text(json.dumps(data))

    def test_complete_package_matches_manifest(self):
        data, _ = builder.load_package(self.package)
        self.assertEqual(len(data["files"]), 127)
        self.assertEqual(sum(row["bytes"] for row in data["files"]), 2300302)

    def test_tampered_missing_and_extra_sources_fail(self):
        file = self.package / "overlay/Cargo.toml"
        original = file.read_bytes()
        file.write_bytes(original + b"\n# mutation\n")
        with self.assertRaisesRegex(ValueError, "content changed"):
            builder.load_package(self.package)
        file.write_bytes(original)
        extra = self.package / "overlay/undeclared.rs"
        extra.write_text("// undeclared\n")
        with self.assertRaisesRegex(ValueError, "undeclared"):
            builder.load_package(self.package)
        extra.unlink()
        file.unlink()
        with self.assertRaisesRegex(ValueError, "regular file"):
            builder.load_package(self.package)

    def test_unsafe_duplicate_and_wrong_base_paths_fail(self):
        for value in ("../escape", "/absolute", "a/../../escape", ".git/config", "a\\b", "a//b"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                builder.relative_path(value)
        self.manifest(lambda data: data["upstream"].update(commit="0" * 40))
        with self.assertRaisesRegex(ValueError, "revision"):
            builder.load_package(self.package)

    def test_license_tampering_fails(self):
        (self.package / "LICENSE_MIT").write_text("changed notice")
        with self.assertRaisesRegex(ValueError, "License content changed"):
            builder.load_package(self.package)

    def test_source_symlink_cannot_substitute_declared_file(self):
        file = self.package / "overlay/Cargo.toml"
        content = file.read_bytes()
        target = self.root / "outside.toml"
        target.write_bytes(content)
        file.unlink()
        file.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "regular file"):
            builder.load_package(self.package)

    def test_real_git_prepare_then_source_tamper_is_rejected(self):
        upstream = self.root / "upstream"
        upstream.mkdir()
        subprocess.run(["git", "init", "-q", str(upstream)], check=True)
        (upstream / "web").mkdir()
        (upstream / "web/base.txt").write_text("pristine\n")
        subprocess.run(["git", "-C", str(upstream), "add", "."], check=True)
        subprocess.run(["git", "-C", str(upstream), "-c", "user.name=Runtime test",
                        "-c", "user.email=runtime@example.invalid", "commit", "-qm", "fixture"], check=True)
        commit = builder.git(upstream, "rev-parse", "HEAD").decode().strip()
        self.manifest(lambda data: data.update(upstream={"repository": str(upstream), "commit": commit}))
        source = self.root / "prepared"
        with patch.object(builder, "ROOT", self.package), patch.object(builder, "UPSTREAM", str(upstream)), \
                patch.object(builder, "COMMIT", commit), redirect_stdout(io.StringIO()):
            # load_package's default root is bound at definition time; use this isolated test package.
            original_load = builder.load_package
            with patch.object(builder, "load_package", lambda: original_load(self.package)):
                builder.prepare(source)
                builder.verify_source(source)
                (source / "web/base.txt").write_text("mutated outside overlay\n")
                with self.assertRaisesRegex(ValueError, "source content changed"):
                    builder.verify_source(source)

    def test_rust_results_require_exact_names_and_ignored_scope(self):
        group = {"label": "example", "exactNames": ["suite::one"],
                 "exactIgnoredNames": ["suite::ignored"], "expectedExecuted": 1,
                 "expectedPassed": 1, "expectedFailed": 0, "expectedIgnored": 1}
        good = "test suite::one ... ok\ntest suite::ignored ... ignored\n"
        self.assertEqual(builder.validate_rust_log(good, group)["executed"], 1)
        for bad in ("running 0 tests\n", good + "test suite::extra ... ok\n",
                    good.replace("suite::one", "suite::different"),
                    good.replace("ignored ... ignored", "ignored ... ok"),
                    good.replace(" ... ok", " ... FAILED")):
            with self.subTest(log=bad), self.assertRaises(ValueError):
                builder.validate_rust_log(bad, group)


if __name__ == "__main__":
    unittest.main()
