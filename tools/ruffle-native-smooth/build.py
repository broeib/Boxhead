#!/usr/bin/env python3
"""Build and independently capture the private smooth runtime on CI/CD.

Requires an already applied overlay, the retained sealed projection-scan v1 parent, the pinned
builder image and a populated offline Cargo cache. Never installs an AMP app.
Each invocation needs a new output directory; failed evidence is preserved.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

IMAGE = "sha256:612f92fa418bc2af18dca2501464dbffa6393ad895a7c7f906216f71e896c8cf"
PARENT_MANIFEST = "4cf43da0ad7f0be085ff6e36e769b916f9422482f6aa7a5c353ae2455cc5f50e"
PARENT_RESULT = "71a29ae5842aeae85acc635beb48c136efd562dfbe0b8d58c56de5f2c7059db4"
VARIANT = "native-smooth-v2"
# The preserved registry archive ignores its own lockfile. This is the only
# ignored source admitted by this reviewed driver, never a runtime-supplied
# allowlist. Query the whole vendor subtree to reject other ignored additions.
IGNORED_SOURCE_ROOT = "third_party/boxhead-gc-arena"
IGNORED_SOURCES = {
    "third_party/boxhead-gc-arena/Cargo.lock": {
        "bytes": 16008,
        "sha256": "aae89dd5e83905c9688a54585a5135270cbc9ba1a3ad3062547a030eda5403c6",
    },
}
RESOURCE_SCOPE = "Cargo and all descendant build/test processes; not export-only memory"
RESOURCE_WRAPPER = (
    "import json,resource,subprocess,sys\n"
    "p=subprocess.run(sys.argv[1:])\n"
    "print('BOXHEAD_NATIVE_SMOOTH_RESOURCE '+json.dumps({'maxRssKiB':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss,"
    "'scope':'Cargo and all descendant build/test processes; not export-only memory'}),flush=True)\n"
    "sys.exit(p.returncode)"
)


def stamp():
    return datetime.now(timezone.utc).isoformat()


def identity(file):
    file = Path(file)
    assert file.is_file() and not file.is_symlink(), f"Expected regular file: {file}"
    before = file.stat()
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    after = file.stat()
    assert (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (
        after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), f"File changed: {file}"
    return {"bytes": after.st_size, "sha256": digest.hexdigest()}


def record(file):
    file = Path(file).resolve(strict=True)
    return {"file": str(file), **identity(file)}


def read_bound(row):
    file = Path(row["file"])
    assert identity(file) == {key: row[key] for key in ("bytes", "sha256")}, f"Changed provenance: {file}"
    return json.loads(file.read_text())


def write_new(file, value):
    with Path(file).open("x") as stream:
        stream.write(json.dumps(value, indent=2) + "\n")
    return record(file)


def git(source, *args):
    return subprocess.run(["git", "-C", str(source), *args], check=True, capture_output=True).stdout.decode()


def inventory(source, expected, engine, prior):
    rows = []
    for name, wanted in sorted(expected.items()):
        target = source / name
        assert target.resolve().is_relative_to(source), f"Source escapes checkout: {name}"
        actual = identity(target)
        assert actual == wanted, f"Unexpected source content: {name}"
        rows.append({"path": name, **actual})
    head = git(source, "rev-parse", "HEAD").strip()
    assert head == engine["upstream"]["commit"]
    assert not git(source, "diff", "--cached", "--name-only").strip(), "Source index must stay clean"
    changed = sorted(git(source, "diff", "--name-only").splitlines())
    untracked = sorted(git(source, "ls-files", "--others", "--exclude-standard").splitlines())
    ignored = sorted(git(source, "ls-files", "--others", "--ignored", "--exclude-standard",
                         "--", IGNORED_SOURCE_ROOT).splitlines())
    assert ignored == sorted(IGNORED_SOURCES), "Undeclared or missing ignored vendor source"
    for name, wanted in IGNORED_SOURCES.items():
        assert expected.get(name) == wanted, f"Ignored source missing from complete inventory: {name}"
        assert identity(source / name) == wanted, f"Changed ignored vendor source: {name}"
    required_changed = sorted(set(prior["gitDiffNames"]) | {
        row["path"] for row in engine["files"] if not row.get("baselineAbsent") and row["path"] not in prior["gitUntracked"]})
    required_untracked = sorted(set(prior["gitUntracked"]) | {"web/version_seal.json"} | {
        row["path"] for row in engine["files"] if row.get("baselineAbsent") and row["path"] not in IGNORED_SOURCES})
    assert changed == required_changed, "Undeclared tracked source change"
    assert untracked == required_untracked, "Undeclared untracked source"
    return {"schema": "boxhead-native-smooth-full-source-v2", "recordedAt": stamp(),
            "sourceRoot": str(source), "sourceCommit": head, "engineVariant": VARIANT,
            "files": rows, "gitHead": head, "gitIndexClean": True,
            "gitDiffNames": changed, "gitUntracked": untracked,
            "gitIgnoredSources": ignored,
            "versionSeal": identity(source / "web/version_seal.json")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("source-root", "cache-root", "target-root", "parent-bundle-root", "out"):
        parser.add_argument("--" + option, type=Path, required=True)
    parser.add_argument("--cpus", type=int, default=2, choices=range(1, 5))
    parser.add_argument("--memory", default="6g", choices=("4g", "6g", "8g"))
    args = parser.parse_args()
    source, cache, target, parent = [getattr(args, key).resolve(strict=True)
        for key in ("source_root", "cache_root", "target_root", "parent_bundle_root")]
    out = args.out.resolve()
    out.mkdir(parents=False, exist_ok=False)
    package = Path(__file__).resolve().parent
    shutil.copytree(package / "engine", out / "engine")
    engine_record = record(out / "engine/manifest.json")
    engine = read_bound(engine_record)
    assert engine["engineVariant"] == VARIANT
    parent_manifest = record(parent / "runtime/manifest.json")
    parent_result = record(parent / "result.json")
    assert parent_manifest["sha256"] == PARENT_MANIFEST
    assert parent_result["sha256"] == PARENT_RESULT
    parent_data = read_bound(parent_manifest)
    capture = read_bound(parent_data["buildCapture"])
    prior = read_bound(capture["sourceBefore"])
    expected = {row.get("path", row.get("file")): {key: row[key] for key in ("bytes", "sha256")}
        for row in prior["files"]}
    for row in engine["files"]:
        wanted = {key: row[key] for key in ("bytes", "sha256")}
        assert identity(out / "engine" / row["path"]) == wanted
        assert identity(source / row["path"]) == wanted, "Apply the checked overlay before this build"
        expected[row["path"]] = wanted
    for row in engine["unchangedParentFiles"]:
        assert identity(source / row["path"]) == {key: row[key] for key in ("bytes", "sha256")}
    # A new runtime receives its own build-date seal. Parent evidence is immutable.
    seal_file = source / "web/version_seal.json"
    seal = json.loads(seal_file.read_text())
    seal["build_date"] = stamp()
    seal_file.write_text(json.dumps(seal, indent=2) + "\n")
    expected["web/version_seal.json"] = identity(seal_file)
    seal_record = write_new(out / "version-seal.json", seal)
    assert identity(seal_file) == {key: seal_record[key] for key in ("bytes", "sha256")}
    before = inventory(source, expected, engine, prior)
    before_record = write_new(out / "source-before.json", before)
    env = {"CARGO_HOME": "/cache/cargo", "CARGO_NET_OFFLINE": "true", "npm_config_cache": "/cache/npm",
           "CARGO_BUILD_JOBS": str(args.cpus), "CARGO_FEATURES": "jpegxr",
           "NODE_ENV": "production", "ENABLE_VERSION_SEAL": "true",
           "CFG_RELEASE_CHANNEL": "boxhead-experiment", "VERSION4": "0.6.0.0", "BUILD_WASM_MVP": "true"}

    def docker(label, tail, cwd):
        command = ["docker", "run", "--rm", "--network", "none", "--cpus", str(args.cpus),
            "--memory", args.memory, "--user", f"{os.getuid()}:{os.getgid()}", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--mount", f"type=bind,source={source},target=/work",
            "--mount", f"type=bind,source={cache},target=/cache",
            "--mount", f"type=bind,source={target},target=/work/target",
            "--workdir", cwd, "--name", f"boxhead-smooth-{os.getpid()}-{label}"]
        for key, value in env.items():
            command += ["--env", f"{key}={value}"]
        return command + [IMAGE] + tail

    stages = []
    for group in engine["rustUnitGroups"]:
        # Only this reviewed new group uses the renderer crate. Metadata
        # cannot select an arbitrary Cargo package or alter the old groups.
        package_name = "ruffle_render_wgpu" if group["label"] == "readback_buffer" else "ruffle_core"
        tail = ["python3", "-c", RESOURCE_WRAPPER, "cargo", "test", "--offline", "--locked",
                "-p", package_name, "--lib", group["filter"], "--", "--test-threads=1"]
        stages.append({"label": group["label"], "command": docker(group["label"], tail, "/work"),
                       "cwd": str(out), "timeoutSeconds": 1800})
    for label, workspace, budget in (("wasm", "ruffle-core", 2400), ("selfhosted", "ruffle-selfhosted", 600)):
        stages.append({"label": label, "command": docker(label,
            ["npm", "run", "build", "--workspace=" + workspace], "/work/web"),
            "cwd": str(out), "timeoutSeconds": budget})
    plan = {"schema": "boxhead-native-smooth-build-plan-v2", "engineVariant": VARIANT,
            "sourceRoot": str(source), "sourceCommit": engine["upstream"]["commit"], "imageId": IMAGE,
            "environment": env, "resources": {"cpus": args.cpus, "memory": args.memory},
            "engineManifest": engine_record, "parentRuntimeManifest": parent_manifest,
            "parentBuildResult": parent_result, "sourceBefore": before_record,
            "versionSeal": seal_record, "driver": record(__file__), "stages": stages}
    plan_record = write_new(out / "build-plan.json", plan)
    observed = {"schema": "boxhead-native-smooth-build-capture-v2", "engineVariant": VARIANT,
                "startedAt": stamp(), "pass": False, "buildPlan": plan_record,
                "sourceBefore": before_record, "stages": []}
    fixtures = []
    try:
        for stage in stages:
            actual = {key: stage[key] for key in ("label", "command", "cwd")}
            actual.update(startedAt=stamp(), state="running")
            observed["stages"].append(actual)
            log_file = out / (stage["label"] + ".log")
            status_file = out / (stage["label"] + ".json")
            status_file.write_text(json.dumps(actual, indent=2) + "\n")
            try:
                with log_file.open("xb") as log:
                    result = subprocess.run(stage["command"], cwd=out, stdin=subprocess.DEVNULL,
                        stdout=log, stderr=subprocess.STDOUT, timeout=stage["timeoutSeconds"])
                actual.update(state="complete", returncode=result.returncode)
            except Exception as error:
                actual.update(state="failed", returncode=-1, error=str(error))
                raise
            finally:
                name = stage["command"][stage["command"].index("--name") + 1]
                present = subprocess.run(["docker", "container", "inspect", name],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
                if present:
                    subprocess.run(["docker", "stop", "--time", "10", name], timeout=30,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                actual.update(finishedAt=stamp(), log=record(log_file))
                status_file.write_text(json.dumps(actual, indent=2) + "\n")
            print(json.dumps({"label": stage["label"], "returncode": actual["returncode"]}), flush=True)
            assert actual["returncode"] == 0, f"Build stage failed: {stage['label']}"
            group = next((group for group in engine["rustUnitGroups"] if group["label"] == stage["label"]), None)
            if group:
                text = log_file.read_text()
                names = re.findall(r"^test (\S+) \.\.\. ok$", text, flags=re.M)
                assert sorted(names) == sorted(group["exactNames"]), "Executed fixture names differ"
                summary = re.findall(r"^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured;", text, flags=re.M)
                assert summary == [(str(group["expectedPassed"]), "0", str(group["expectedIgnored"]), "0")]
                ignored = re.findall(r"^test (\S+) \.\.\. ignored(?:,.*)?$", text, flags=re.M)
                assert sorted(ignored) == sorted(group.get("exactIgnoredNames", [])), "Ignored fixture names differ"
                resources = [json.loads(row) for row in re.findall(r"^BOXHEAD_NATIVE_SMOOTH_RESOURCE (.+)$", text, flags=re.M)]
                assert len(resources) == 1 and resources[0]["maxRssKiB"] > 0 and resources[0]["scope"] == RESOURCE_SCOPE
                fixtures.append({"label": group["label"], "filter": group["filter"], "executed": len(names),
                    "passed": len(names), "failed": 0, "ignored": len(ignored), "exactNames": names, "exactIgnoredNames": ignored,
                    "log": actual["log"], "resources": resources[0]})
        after = inventory(source, expected, engine, prior)
        for key in before:
            if key != "recordedAt":
                assert before[key] == after[key], f"Source changed during build: {key}"
        observed["sourceAfter"] = write_new(out / "source-after.json", after)
        observed["rustFixtures"] = write_new(out / "rust-fixtures.json", {
            "schema": "boxhead-native-smooth-rust-fixtures-v2", "engineVariant": VARIANT,
            "engineManifest": engine_record, "groups": fixtures,
            "totalExecuted": sum(group["executed"] for group in fixtures), "inheritedPasses": False})
        assert sum(group["executed"] for group in fixtures) == engine["totalRequiredRustTests"]
        observed["pass"] = True
    except Exception as error:
        observed["error"] = str(error)
        raise
    finally:
        observed["finishedAt"] = stamp()
        capture_record = write_new(out / "build-capture.json", observed)

    produced = source / "web/packages/selfhosted/dist"
    runtime = out / "runtime"
    shutil.copytree(produced, runtime)
    files = []
    for file in sorted(runtime.rglob("*")):
        assert not file.is_symlink(), "Runtime contains a symlink"
        if file.is_file():
            files.append({"file": str(file.relative_to(runtime)), **identity(file)})
    assert len([row for row in files if row["file"].endswith(".wasm")]) == 2
    manifest = {"schema": "boxhead-ruffle-web-bundle-v1", "engineVariant": VARIANT, "arm": "candidate",
        "sourceCommit": engine["upstream"]["commit"], "createdAt": stamp(), "imageId": IMAGE,
        "files": files, "engineManifest": engine_record, "parentRuntimeManifest": parent_manifest,
        "patchFiles": engine["files"],
        "parentBuildResult": parent_result, "buildPlan": plan_record, "buildCapture": capture_record,
        "sourceBefore": before_record, "sourceAfter": observed["sourceAfter"],
        "rustFixtures": observed["rustFixtures"], "versionSeal": seal_record,
        "wasmVariants": ["extensions", "mvp"], "sourceAfterVerified": True,
        "gameplayPassClaimed": False, "performancePassClaimed": False}
    manifest_record = write_new(runtime / "manifest.json", manifest)
    result = {"schema": "boxhead-native-smooth-build-result-v2", "engineVariant": VARIANT,
        "arm": "candidate", "compiled": True, "sourceAfterVerified": True,
        "manifest": manifest_record, "engineManifest": engine_record, "buildPlan": plan_record,
        "buildCapture": capture_record, "sourceBefore": before_record,
        "sourceAfter": observed["sourceAfter"], "rustFixtures": observed["rustFixtures"], "files": files,
        "captureRebuiltCompiler": True, "preBuildCompleteSourceInventoryClaimed": True,
        "gameplayPassClaimed": False, "performancePassClaimed": False}
    result_record = write_new(out / "result.json", result)
    print(json.dumps({"pass": True, "result": result_record, "manifest": manifest_record}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Projector build failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
