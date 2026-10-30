#!/usr/bin/env python3
"""Verify, prepare and build the public V24 Ruffle source package."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
UPSTREAM = "https://github.com/ruffle-rs/ruffle.git"
COMMIT = "cac5c99ce4a17e606f4ee3090389bb878f852055"
MARKER = ".boxhead-public-prepare.json"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def identity(file):
    require(file.is_file() and not file.is_symlink(), "Expected regular file: " + str(file))
    data = file.read_bytes()
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def relative_path(value):
    require(isinstance(value, str), "Overlay path must be a string")
    path = PurePosixPath(value)
    require(value and not path.is_absolute() and ".." not in path.parts
            and ".git" not in path.parts and "\\" not in value and str(path) == value,
            "Unsafe overlay path")
    return value


def load_package(root=ROOT):
    manifest_file = root / "overlay-manifest.json"
    manifest = json.loads(manifest_file.read_text())
    require(manifest["upstream"]["commit"] == COMMIT, "Unexpected upstream revision")
    require(manifest["upstream"]["repository"] in (UPSTREAM, UPSTREAM[:-4], "ruffle-rs/ruffle"),
            "Unexpected upstream repository")
    files = manifest["files"]
    require(len(files) == 127, "The complete cumulative V24 overlay requires 127 files")
    names = []
    for row in files:
        name = relative_path(row["path"])
        require(re.fullmatch(r"[0-9a-f]{64}", row["sha256"]) is not None, "Invalid overlay hash")
        require(type(row["bytes"]) is int and row["bytes"] >= 0, "Invalid overlay size")
        require(identity(root / "overlay" / name) == {k: row[k] for k in ("bytes", "sha256")},
                "Overlay content changed: " + name)
        names.append(name)
    require(len(set(names)) == len(names), "Duplicate overlay path")
    actual = []
    for file in (root / "overlay").rglob("*"):
        require(not file.is_symlink(), "Overlay contains a symlink")
        if file.is_file():
            actual.append(file.relative_to(root / "overlay").as_posix())
    require(set(actual) == set(names), "Missing or undeclared overlay file")
    for row in manifest["licenses"]:
        name = relative_path(row["path"])
        require(identity(root / name) == {k: row[k] for k in ("bytes", "sha256")},
                "License content changed: " + name)
    return manifest, identity(manifest_file)


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args])


def inventory(source, names):
    rows = []
    for name in sorted(set(names)):
        file = source / relative_path(name)
        if file.is_symlink():
            require(file.resolve().is_relative_to(source), "Source symlink escapes checkout: " + name)
            rows.append({"path": name, "symlink": os.readlink(file)})
        else:
            rows.append({"path": name, **identity(file)})
    return rows


def write_new(file, value):
    with file.open("x") as stream:
        stream.write(json.dumps(value, indent=2) + "\n")


def prepare(source):
    manifest, digest = load_package()
    source = source.parent.resolve(strict=True) / source.name
    require(not source.exists() and not source.is_symlink(), "Prepare requires a fresh source directory")
    require(source.parent.is_dir(), "Source parent directory must exist")
    subprocess.run(["git", "clone", "--filter=blob:none", "--no-checkout", UPSTREAM, str(source)], check=True)
    subprocess.run(["git", "-C", str(source), "checkout", "--detach", COMMIT], check=True)
    source = source.resolve()
    require(git(source, "rev-parse", "HEAD").decode().strip() == COMMIT, "Wrong pristine base")
    require(not git(source, "status", "--porcelain", "--untracked-files=all"), "Base checkout is dirty")
    tracked = git(source, "ls-files", "-z").decode().split("\0")[:-1]
    # Read the entire pristine source before the first overlay mutation.
    baseline = inventory(source, tracked)
    for row in manifest["files"]:
        destination = source / row["path"]
        require(destination.parent.resolve().is_relative_to(source), "Overlay destination escapes source")
        require(not destination.is_symlink(), "Overlay cannot replace a symlink")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((ROOT / "overlay" / row["path"]).read_bytes())
    seal = {"version_number": "0.6.0", "version_name": "boxhead-public-v24 0.6.0",
            "version_channel": "boxhead-public-v24", "build_date": datetime.now(timezone.utc).isoformat(),
            "commitHash": COMMIT, "version4": "0.6.0.0", "firefox_extension_id": "ruffle@ruffle.rs"}
    write_new(source / "web/version_seal.json", seal)
    names = sorted(set(tracked) | {x["path"] for x in manifest["files"]} | {"web/version_seal.json"})
    record = {"schema": "boxhead-public-runtime-source-v1", "upstreamCommit": COMMIT,
              "overlayManifest": digest, "baseline": baseline, "files": inventory(source, names)}
    write_new(source / MARKER, record)
    verify_source(source)
    print("Prepared complete public V24 source: " + str(source))


def verify_source(source):
    source = source.resolve(strict=True)
    manifest, digest = load_package()
    before = json.loads((source / MARKER).read_text())
    require(before["upstreamCommit"] == COMMIT and before["overlayManifest"] == digest,
            "Prepared source does not match this public package")
    require(git(source, "rev-parse", "HEAD").decode().strip() == COMMIT, "Prepared Git revision changed")
    require(not git(source, "diff", "--cached", "--name-only"), "Prepared index changed")
    require(inventory(source, [x["path"] for x in before["files"]]) == before["files"],
            "Prepared source content changed")
    allowed = {x["path"] for x in manifest["files"]} | {"web/version_seal.json", MARKER}
    untracked = set(git(source, "ls-files", "--others", "--exclude-standard", "-z").decode().split("\0")) - {""}
    require(untracked <= allowed, "Unexpected untracked source file")
    for row in manifest["files"]:
        require(identity(source / row["path"]) == {k: row[k] for k in ("bytes", "sha256")},
                "Prepared overlay changed: " + row["path"])
    return before


def run_stage(command, cwd, env, output, label):
    with (output / (label + ".log")).open("x") as log:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    require(result.returncode == 0, label + " failed; inspect its local build log")


def validate_rust_log(text, group):
    rows = re.findall(r"^test (\S+) \.\.\. (ok|ignored|FAILED)(?:$|[, ])", text, re.MULTILINE)
    require(len({name for name, _ in rows}) == len(rows), "Duplicate Rust test result")
    passed = sorted(name for name, result in rows if result == "ok")
    ignored = sorted(name for name, result in rows if result == "ignored")
    failed = [name for name, result in rows if result == "FAILED"]
    require(not failed and group["expectedFailed"] == 0, "Rust group failed")
    require(passed == sorted(group["exactNames"]), "Rust executed names differ from the reviewed group")
    require(ignored == sorted(group.get("exactIgnoredNames", [])), "Rust ignored names differ")
    require(len(passed) == group["expectedExecuted"] == group["expectedPassed"], "Rust execution count differs")
    require(len(ignored) == group["expectedIgnored"], "Rust ignored count differs")
    return {"label": group["label"], "executed": len(passed), "ignored": len(ignored)}


def build(source, output, rust_tests=False, jobs=None):
    before = verify_source(source)
    source = source.resolve(strict=True)
    output = output.parent.resolve(strict=True) / output.name
    require(not output.exists() and not output.is_symlink(), "Build output must be fresh")
    require(not output.is_relative_to(source) and not source.is_relative_to(output), "Output must be outside source")
    require(output.parent.is_dir(), "Build output parent must exist")
    output.mkdir()
    manifest, digest = load_package()
    env = {**os.environ, "CARGO_FEATURES": "jpegxr", "BUILD_WASM_MVP": "true",
           "ENABLE_VERSION_SEAL": "true", "CFG_RELEASE_CHANNEL": "boxhead-public-v24",
           "VERSION4": "0.6.0.0", "NODE_ENV": "production", "CARGO_TERM_COLOR": "never"}
    if jobs:
        env["CARGO_BUILD_JOBS"] = str(jobs)
    versions = {}
    try:
        for executable in ("git", "rustc", "cargo", "node", "npm", "wasm-bindgen"):
            versions[executable] = subprocess.check_output([executable, "--version"], env=env).decode().strip()
        require(re.match(r"v22\.", versions["node"]) is not None, "Use Node 22")
        require(versions["wasm-bindgen"].split()[-1] == "0.2.127", "wasm-bindgen-cli must be 0.2.127")
        run_stage(["npm", "ci", "--include=dev"], source / "web", env, output, "dependencies")
        rust_results = []
        if rust_tests:
            for i, group in enumerate(manifest.get("rustUnitGroups", [])):
                package = "ruffle_render_wgpu" if group["label"] == "readback_buffer" else "ruffle_core"
                run_stage(["cargo", "test", "--locked", "-p", package, "--lib", group["filter"],
                           "--", "--test-threads=1"], source, env, output, "rust-" + str(i))
                rust_results.append(validate_rust_log((output / ("rust-" + str(i) + ".log")).read_text(), group))
            require(sum(x["executed"] for x in rust_results) == manifest["totalRequiredRustTests"],
                    "Complete Rust test count differs")
        for label, workspace in (("wasm", "ruffle-core"), ("selfhosted", "ruffle-selfhosted")):
            run_stage(["npm", "run", "build", "--workspace=" + workspace], source / "web", env, output, label)
        require(verify_source(source) == before, "Source changed during compilation")
        runtime = source / "web/packages/selfhosted/dist"
        require(runtime.is_dir(), "Selfhosted output is missing")
        files = sorted(x for x in runtime.rglob("*") if x.is_file())
        require(all(not x.is_symlink() for x in runtime.rglob("*")), "Runtime contains a symlink")
        require(sum(x.suffix == ".wasm" for x in files) == 2, "Expected both SIMD and MVP WASM variants")
        for name in ("ruffle.js", "LICENSE_MIT", "LICENSE_APACHE"):
            require((runtime / name).is_file(), "Runtime is missing " + name)
        destination = output / "runtime"
        shutil.copytree(runtime, destination)
        rows = [{"path": x.relative_to(destination).as_posix(), **identity(x)}
                for x in sorted(destination.rglob("*")) if x.is_file()]
        write_new(output / "build-manifest.json", {"schema": "boxhead-public-runtime-build-v1",
            "status": "compiled", "upstreamCommit": COMMIT, "overlayManifest": digest,
            "toolVersions": versions, "files": rows, "rustGroups": rust_results,
            "gameplayPassClaimed": False, "performancePassClaimed": False,
            "byteEqualityWithPreviouslyBundledRuntimeClaimed": False})
        print("Built public runtime: " + str(destination))
    except Exception:
        write_new(output / "failed-build.json", {"schema": "boxhead-public-runtime-build-v1", "status": "failed"})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("verify", help="Verify the shipped 127-file overlay without network access")
    for name in ("prepare", "verify-source", "build"):
        command = commands.add_parser(name)
        command.add_argument("--source-root", required=True, type=Path)
        if name == "build":
            command.add_argument("--out", required=True, type=Path)
            command.add_argument("--rust-tests", action="store_true")
            command.add_argument("--jobs", type=int)
    args = parser.parse_args()
    if args.command == "verify":
        manifest, digest = load_package()
        print(json.dumps({"verified": True, "files": len(manifest["files"]), "manifest": digest}))
    elif args.command == "prepare":
        prepare(args.source_root)
    elif args.command == "verify-source":
        verify_source(args.source_root)
        print("Prepared source verified")
    else:
        require(args.jobs is None or args.jobs > 0, "Jobs must be positive")
        build(args.source_root, args.out, args.rust_tests, args.jobs)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print("Public runtime build failed: " + str(error), file=sys.stderr)
        sys.exit(1)
