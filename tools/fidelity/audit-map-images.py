#!/usr/bin/env python3
"""Audit actual map PNGs and build review contact sheets.

Runtime pairs are compared only when their source report assigns the same map
and native tick. Pristine live screenshots are never pixel-compared to those
pairs: their clocks, inputs and random state are different.
"""
import argparse
import hashlib
import json
import math
import pathlib
import re
import sys
from datetime import datetime, timezone
from PIL import Image, ImageChops, ImageDraw, ImageFont

ORIGINAL_SHA = "34ff145d96891ddea20278700c8b1fb6fd6273ca0e71b73d8bdf0df183fdbece"
NAMES = ["BOXY", "BUTTONS", "MAZEY", "GLADIATOR", "STRIP", "TIGHT", "COLUMNS", "CASTLE", "BIG BOXY",
         "RECTY", "PATCHY", "FOREST BOX", "TIGHT 2", "MASSIVE", "THIN LINE", "4 CASTLES", "THE STRIPS", "BIG ONE"]
RED_ROI = (20, 45, 620, 410)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_child(directory, value):
    if not isinstance(value, str) or not value or pathlib.Path(value).is_absolute():
        raise ValueError("Evidence path must be a nonempty relative path")
    base = directory.resolve()
    result = (base / value).resolve()
    if not result.is_relative_to(base) or result == base:
        raise ValueError("Evidence path leaves report directory: " + value)
    return result


def read_report(path):
    data = path.read_bytes()
    if len(data) > 32 * 1024 * 1024:
        raise ValueError("Oversized source report")
    return json.loads(data), digest(data)


def discover_reports(roots):
    found = []
    for value in roots:
        root = pathlib.Path(value).resolve()
        if root.is_file():
            found.append(root)
        elif (root / "report.json").is_file():
            found.append(root / "report.json")
        elif root.is_dir():
            found.extend(sorted(root.rglob("report.json")))
        else:
            found.append(root / "report.json")
    return found


def red_fraction(image):
    red, green, blue = image.convert("RGB").crop(RED_ROI).split()
    red = red.point(lambda value: 255 if value > 230 else 0)
    green = green.point(lambda value: 255 if value < 30 else 0)
    blue = blue.point(lambda value: 255 if value < 30 else 0)
    combined = ImageChops.multiply(red, ImageChops.multiply(green, blue))
    return combined.histogram()[255] / (combined.width * combined.height)


def inspect_png(path, red_check=True):
    data = path.read_bytes()
    with Image.open(path) as image:
        size, mode, kind = list(image.size), image.mode, image.format
        if kind != "PNG" or image.size != (640, 480):
            return {"path": str(path), "sha256": digest(data), "size": size, "mode": mode,
                    "format": kind, "redCheckApplied": red_check, "pass": False,
                    "error": "Expected an actual 640x480 PNG stage"}
        image.load()
        fraction = red_fraction(image)
    return {"path": str(path), "sha256": digest(data), "size": size, "mode": mode, "format": kind,
            "redFillFraction": fraction, "redCheckApplied": red_check,
            "pass": not red_check or fraction <= 0.5,
            **({"error": "Red initialization surface exceeds half of the playfield ROI"} if red_check and fraction > 0.5 else {})}


def pixel_difference(first, second):
    with Image.open(first) as image:
        a = image.convert("RGB")
    with Image.open(second) as image:
        b = image.convert("RGB")
    if a.size != (640, 480) or b.size != (640, 480):
        raise ValueError("Cannot compare non-stage image sizes")
    delta = ImageChops.difference(a, b)
    channels = delta.split()
    maximum = ImageChops.lighter(channels[0], ImageChops.lighter(channels[1], channels[2]))
    histogram = maximum.histogram()
    count = a.width * a.height
    different = count - histogram[0]
    highest = max(index for index, occurrences in enumerate(histogram) if occurrences)
    total = sum(index * occurrences for channel in channels for index, occurrences in enumerate(channel.histogram()))
    return {"differentPixels": different, "totalPixels": count, "differentFraction": different / count,
            "maxAbsChannelDelta": highest, "meanAbsChannelDelta": total / (count * 3),
            "differenceBounds": list(delta.getbbox()) if delta.getbbox() else None, "identical": different == 0}


def contact_sheet(expected, images, title, output):
    columns, tile_width, tile_height, label_height, gap, header = 3, 320, 240, 26, 12, 42
    rows = math.ceil(len(expected) / columns)
    sheet = Image.new("RGB", (gap + columns * (tile_width + gap), header + rows * (tile_height + label_height + gap)), "#e6e6e6")
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
        heading = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 19)
    except OSError:
        font = heading = ImageFont.load_default()
    draw.text((gap, 10), title, fill="#111111", font=heading)
    entries = []
    for position, index in enumerate(expected):
        x = gap + (position % columns) * (tile_width + gap)
        y = header + (position // columns) * (tile_height + label_height + gap)
        entry = images.get(index)
        label = f"{index:02d} {NAMES[index - 1]}"
        if entry and entry.get("path"):
            try:
                with Image.open(entry["path"]) as image:
                    if image.size != (640, 480):
                        raise ValueError("Unexpected size")
                    preview = image.convert("RGB").resize((tile_width, tile_height), Image.Resampling.LANCZOS)
                sheet.paste(preview, (x, y))
                if entry.get("tick") is not None:
                    label += " | tick " + str(entry["tick"])
                entries.append({"map": index, **entry})
            except Exception as error:
                entry = None
                entries.append({"map": index, "error": str(error)})
        if not entry:
            draw.rectangle((x, y, x + tile_width - 1, y + tile_height - 1), fill="#fff2f2", outline="#b00020")
            draw.text((x + 16, y + 100), "MISSING / PARTIAL", fill="#b00020", font=heading)
            label += " | MISSING"
            if not entries or entries[-1].get("map") != index:
                entries.append({"map": index, "missing": True})
        draw.text((x + 3, y + tile_height + 4), label, fill="#111111", font=font)
    sheet.save(output)
    return {"path": str(output), "sha256": digest(output.read_bytes()), "size": list(sheet.size), "entries": entries,
            "purpose": "Resized review overview only; unmodified 640x480 source PNGs remain the evidence"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pristine-root", action="append", default=[], help="Pristine capture aggregate root/report; repeat for the pilot and remaining maps")
    parser.add_argument("--candidate-root", action="append", default=[], help="Native frame audit root/report; repeat or supply a parent of map report directories")
    parser.add_argument("--out", required=True)
    parser.add_argument("--from", dest="first", type=int, default=1)
    parser.add_argument("--to", dest="last", type=int, default=18)
    parser.add_argument("--frames", type=int, default=600)
    args = parser.parse_args(argv)
    if not 1 <= args.first <= args.last <= 18 or not 1 <= args.frames <= 10000:
        parser.error("Invalid map/frame range")
    out = pathlib.Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    expected = list(range(args.first, args.last + 1))
    report = {"classification": "MAP_IMAGE_INTEGRITY_AND_PAIRED_PIXEL_AUDIT", "pass": False, "partial": True,
              "generatedAt": datetime.now(timezone.utc).isoformat(), "helperSha256": digest(pathlib.Path(__file__).read_bytes()),
              "expectedMaps": expected, "expectedFramesPerCandidateMap": args.frames, "sources": [],
              "pristineMaps": [], "pristineAttempts": [], "candidateMaps": [], "images": [], "pairedPixels": [], "errors": [], "missing": [], "warnings": [],
              "pristinePixelParityCompared": False, "limitations": [
                  "This audits PNG files and source-report coverage; native graph archives have a separate independent validator.",
                  "Client1/client2 pixels are compared only at the same reported map/tick; differences are measurements, not an automatic gameplay failure.",
                  "No pixel comparison is made between pristine live play and controlled runtime frames with different time/input/random state.",
                  "Contact sheets are resized review aids. Every source candidate PNG is checked at its actual 640x480 size.",
              ]}
    known_images, reference_seen, candidate_seen, source_seen = {}, set(), set(), set()
    reference_selection, reference_game, candidate_first, candidate_late = {}, {}, {}, {}
    candidate_assets, pristine_choices = set(), {}

    def error(stage, message, **context):
        report["errors"].append({"stage": stage, "error": str(message), **context})

    def image(path, red_check, expected_hash=None):
        key = str(path.resolve())
        if key not in known_images:
            try:
                value = inspect_png(path, red_check)
            except Exception as exception:
                value = {"path": key, "pass": False, "error": str(exception)}
                report["missing"].append({"kind": "image", "path": key})
            known_images[key] = value
            report["images"].append(value)
            if not value["pass"]:
                error("image", value.get("error", "Invalid image"), path=key)
        value = known_images[key]
        if red_check and not value.get("redCheckApplied") and "redFillFraction" in value:
            value["redCheckApplied"] = True
            if value["redFillFraction"] > 0.5:
                value["pass"] = False
                value["error"] = "Red initialization surface exceeds half of the playfield ROI"
                error("image", value["error"], path=key)
        if expected_hash and value.get("sha256") != expected_hash:
            error("image hash", "PNG differs from source report", path=key, expected=expected_hash, actual=value.get("sha256"))
        return value

    for path in discover_reports(args.pristine_root):
        try:
            if path in source_seen:
                raise ValueError("Duplicate source report")
            source_seen.add(path)
            data, source_sha = read_report(path)
            report["sources"].append({"kind": "pristine", "path": str(path), "sha256": source_sha, "sourcePass": data.get("pass")})
            if data.get("swfSha256") != ORIGINAL_SHA or not isinstance(data.get("cases"), list):
                raise ValueError("Expected a pinned original capture aggregate report")
            if data.get("pass") is not True or data.get("capturedAllRequested") is not True:
                report["warnings"].append({"stage": "pristine source", "message": "Capture aggregate contains incomplete attempts; only complete per-map cases may provide coverage", "path": str(path)})
            if data.get("errors"):
                error("pristine source", "Capture aggregate has global errors", path=str(path), sourceErrors=data["errors"])
            for case in data["cases"]:
                index = case.get("map")
                if not isinstance(index, int) or index not in expected:
                    error("pristine coverage", "Unexpected map", path=str(path), map=index)
                    continue
                complete = case.get("captured") is True and case.get("gameplayVerified") is True and not case.get("error") and not case.get("errors")
                attempt = {"map": index, "sourceReport": str(path), "complete": complete, "selected": False,
                           "captured": case.get("captured"), "gameplayVerified": case.get("gameplayVerified"),
                           "error": case.get("error"), "errors": case.get("errors", [])}
                report["pristineAttempts"].append(attempt)
                if complete:
                    # An explicitly supplied later successful rerun may replace
                    # a failed attempt. Both histories remain in this report.
                    if index in pristine_choices:
                        pristine_choices[index][2]["selected"] = False
                    attempt["selected"] = True
                    pristine_choices[index] = (path, case, attempt)
        except Exception as exception:
            error("pristine source", exception, path=str(path))
            if not path.exists():
                report["missing"].append({"kind": "source report", "path": str(path)})

    for index, (path, case, attempt) in sorted(pristine_choices.items()):
        try:
            reference_seen.add(index)
            folder = safe_child(path.parent, f"{index:02d}")
            entry = {"map": index, "name": NAMES[index - 1], "sourceReport": str(path), "captured": case.get("captured"),
                     "gameplayVerified": case.get("gameplayVerified"), "images": []}
            hashes = {frame["file"]: frame.get("sha256") for action in case.get("directions", []) for frame in action.get("frames", [])}
            required = {"02-selected-map.png", "03-first-gameplay.png"}
            filenames = set(case.get("screenshots", [])) | required
            for filename in sorted(filenames):
                file = safe_child(folder, filename)
                checked = image(file, filename.startswith(("03-", "04-")), hashes.get(filename))
                entry["images"].append(checked["path"])
            for filename, target in [("02-selected-map.png", reference_selection), ("03-first-gameplay.png", reference_game)]:
                file = safe_child(folder, filename)
                if known_images[str(file)].get("pass"):
                    target[index] = {"path": str(file), "sha256": known_images[str(file)]["sha256"]}
            report["pristineMaps"].append(entry)
        except Exception as exception:
            error("pristine map", exception, map=index, path=str(path))

    for path in discover_reports(args.candidate_root):
        try:
            if path in source_seen:
                raise ValueError("Duplicate source report")
            source_seen.add(path)
            data, source_sha = read_report(path)
            report["sources"].append({"kind": "candidate", "path": str(path), "sha256": source_sha, "sourcePass": data.get("pass")})
            if data.get("classification") != "NATIVE_ORIGINAL_PER_FRAME_MAP_AUDIT":
                raise ValueError("Expected a native per-frame map audit report")
            if data.get("pass") is not True or data.get("currentCase") or data.get("error"):
                error("candidate source", "Native source report is failed or incomplete", path=str(path))
            assets = data.get("assets", {})
            candidate_assets.add((assets.get("onlineSha256"), assets.get("comparisonSha256")))
            if assets.get("originalSha256") != ORIGINAL_SHA:
                error("candidate source", "Original SWF provenance differs", path=str(path))
            # Include every actual PNG in the source directory, even an
            # unreferenced failure capture. It cannot inflate pair coverage.
            directory_pngs = sorted(path.parent.glob("*.png"))
            for file in directory_pngs:
                image(file.resolve(), True)
            for case in data.get("completedCases", []):
                matched = re.fullmatch(r"map-(\d{2})", str(case.get("name", "")))
                index = int(matched.group(1)) if matched else None
                if index not in expected:
                    error("candidate coverage", "Unexpected map", path=str(path), map=index)
                    continue
                if index in candidate_seen:
                    error("candidate coverage", "Duplicate map", path=str(path), map=index)
                    continue
                candidate_seen.add(index)
                if case.get("pass") is not True or case.get("executedTicks") != args.frames:
                    error("candidate map", "Candidate frame window is incomplete", map=index, path=str(path))
                    report["missing"].append({"kind": "complete candidate frame window", "map": index})
                captures = case.get("screenshots", [])
                ticks = set()
                pairs = []
                for capture in captures:
                    tick = capture.get("tick")
                    if not isinstance(tick, int) or tick < 1 or tick > args.frames or tick in ticks:
                        error("candidate pair", "Invalid or repeated capture tick", map=index, tick=tick)
                        continue
                    ticks.add(tick)
                    values = capture.get("images", [])
                    if sorted(value.get("client", 0) for value in values) != [1, 2]:
                        error("candidate pair", "Capture lacks exactly one image for each client", map=index, tick=tick)
                        report["missing"].append({"kind": "candidate PNG pair", "map": index, "tick": tick})
                        continue
                    files = {}
                    for value in values:
                        file = safe_child(path.parent, value["path"])
                        expected_name = f"map-{index:02d}-tick-{tick:05d}-client{value['client']}.png"
                        if file.name != expected_name:
                            raise ValueError("PNG filename does not identify its reported native tick/client")
                        checked = image(file, True, value.get("sha256"))
                        files[value["client"]] = file
                        if value["client"] == 1 and checked.get("pass"):
                            row = {"path": str(file), "sha256": checked["sha256"], "tick": tick}
                            if tick == 1:
                                candidate_first[index] = row
                            if tick == args.frames:
                                candidate_late[index] = row
                    try:
                        difference = pixel_difference(files[1], files[2])
                        paired = {"map": index, "tick": tick, "client1": str(files[1]), "client2": str(files[2]),
                                  "pairClassification": assets.get("pairClassification"), **difference}
                        report["pairedPixels"].append(paired)
                        pairs.append(paired)
                    except Exception as exception:
                        error("candidate pixel pair", exception, map=index, tick=tick)
                required_ticks = {1, args.frames, *range(25, args.frames + 1, 25)}
                missing_ticks = sorted(required_ticks - ticks)
                if missing_ticks:
                    report["missing"].append({"kind": "periodic candidate PNGs", "map": index, "ticks": missing_ticks})
                    error("candidate coverage", "Required capture ticks are absent", map=index, ticks=missing_ticks)
                report["candidateMaps"].append({"map": index, "name": NAMES[index - 1], "sourceReport": str(path),
                                               "executedTicks": case.get("executedTicks"), "captureTicks": sorted(ticks),
                                               "comparedPairs": len(pairs), "missingPeriodicTicks": missing_ticks})
        except Exception as exception:
            error("candidate source", exception, path=str(path))
            if not path.exists():
                report["missing"].append({"kind": "source report", "path": str(path)})

    missing_reference = sorted(set(expected) - reference_seen)
    missing_candidate = sorted(set(expected) - candidate_seen)
    report["missingPristineMaps"] = missing_reference
    report["missingCandidateMaps"] = missing_candidate
    if missing_reference:
        report["missing"].append({"kind": "pristine maps", "maps": missing_reference})
    if missing_candidate:
        report["missing"].append({"kind": "candidate maps", "maps": missing_candidate})
    if not args.pristine_root or not args.candidate_root:
        error("sources", "Both pristine and candidate source roots are required for a complete audit")
    if len(candidate_assets) > 1 or any(not a or not b for a, b in candidate_assets):
        error("candidate assets", "Candidate/control asset hashes differ between source runs or are missing")
    report["candidateAssets"] = [{"candidate": a, "comparison": b} for a, b in sorted(candidate_assets, key=str)]
    sheets = [(reference_selection, "Pristine original - actual selection", "pristine-selection.png"),
              (reference_game, "Pristine original - first verified gameplay", "pristine-first-gameplay.png"),
              (candidate_first, "Candidate client1 - native tick 1", "candidate-first.png"),
              (candidate_late, f"Candidate client1 - native tick {args.frames}", "candidate-late.png")]
    report["contactSheets"] = [contact_sheet(expected, images, title, out / name) for images, title, name in sheets]
    for sheet in report["contactSheets"]:
        for entry in sheet["entries"]:
            if entry.get("missing") or entry.get("error"):
                report["missing"].append({"kind": "contact sheet source", "map": entry["map"], "sheet": sheet["path"], "error": entry.get("error")})
    pairs = report["pairedPixels"]
    report["pixelSummary"] = {"comparedSameTickPairs": len(pairs), "identicalPairs": sum(value["identical"] for value in pairs),
                              "nonidenticalPairs": sum(not value["identical"] for value in pairs),
                              "maximumDifferentPixels": max((value["differentPixels"] for value in pairs), default=None),
                              "maximumAbsChannelDelta": max((value["maxAbsChannelDelta"] for value in pairs), default=None),
                              "worstPairs": sorted(pairs, key=lambda value: (value["differentPixels"], value["maxAbsChannelDelta"]), reverse=True)[:12]}
    report["counts"] = {"pristineMaps": len(reference_seen), "candidateMaps": len(candidate_seen),
                        "actualPNGFilesChecked": len(known_images), "sameTickPairsCompared": len(pairs)}
    report["partial"] = bool(report["missing"])
    report["pass"] = not report["partial"] and not report["errors"] and len(reference_seen) == len(expected) and len(candidate_seen) == len(expected)
    report["status"] = "PASS" if report["pass"] else "PARTIAL" if report["partial"] else "FAIL"
    (out / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"pass": report["pass"], "partial": report["partial"], "status": report["status"], "counts": report["counts"],
                      "missingPristineMaps": missing_reference, "missingCandidateMaps": missing_candidate,
                      "errors": len(report["errors"]), "report": str(out / "report.json")}))
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
