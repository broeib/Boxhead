#!/usr/bin/env python3
"""Apply only this hash-bound source overlay to a separate untouched v5 copy."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def identity(path):
    data = path.read_bytes()
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def require_identity(path, expected):
    if identity(path) != {key: expected[key] for key in ("bytes", "sha256")}:
        raise ValueError(f"Source identity mismatch: {path}")


def source_path(root, relative):
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        raise ValueError(f"Source path escapes separate checkout: {relative}")
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    package = Path(__file__).resolve().parent
    repository = package.parents[1]
    engine = package / "engine"
    manifest_file = engine / "manifest.json"
    manifest = json.loads(manifest_file.read_text())
    parent_file = repository / manifest["parentSource"]["file"]
    require_identity(parent_file, manifest["parentSource"])
    parent = json.loads(parent_file.read_text())
    source = args.source_root.resolve(strict=True)
    report = args.report.resolve()
    if report.exists() or not report.parent.is_dir():
        raise ValueError("Report needs a fresh filename in an existing directory")
    if source == engine or engine.is_relative_to(source) or source.is_relative_to(package):
        raise ValueError("A separate v5 source checkout is required")

    # Complete read-only preflight before the first target write.
    for row in parent["files"]:
        require_identity(source_path(source, row["path"]), row)
    for row in manifest["files"]:
        require_identity(engine / row["path"], row)
        target = source_path(source, row["path"])
        if row.get("baselineAbsent") and target.exists():
            raise ValueError(f"New overlay target already exists: {target}")

    for row in manifest["files"]:
        target = source_path(source, row["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((engine / row["path"]).read_bytes())
    for row in manifest["files"] + manifest["unchangedParentFiles"]:
        require_identity(source_path(source, row["path"]), row)

    result = {
        "schema": "boxhead-native-projector-overlay-application-v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceRoot": str(source),
        "engineVariant": manifest["engineVariant"],
        "engineManifest": {"file": str(manifest_file), **identity(manifest_file)},
        "parentSource": manifest["parentSource"],
        "files": [{"path": row["path"], **identity(source / row["path"])} for row in manifest["files"]],
        "sourceApplied": True,
        "testsExecuted": False,
        "runtimeBuilt": False,
    }
    with report.open("x") as output:
        output.write(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"sourceApplied": True, "report": str(report), "files": len(manifest["files"])}))


if __name__ == "__main__":
    main()
