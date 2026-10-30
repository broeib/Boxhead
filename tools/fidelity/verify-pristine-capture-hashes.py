#!/usr/bin/env python3
"""Re-read retained pristine PNGs against capture-time hashes where recorded.

Repeat --root in the same order used by audit-map-images.py. A later complete
case replaces an earlier complete case; failed/partial attempts never provide
coverage and remain in attempts[]. No browser, capture, or game is started.

Exit 0 means every available recorded hash matched and all 18 complete maps
were selected. status remains PARTIAL when historical first-gameplay hashes
were not recorded. Newly computed hashes never stand in for missing expected
hashes. This is a supplementary provenance review, not a gameplay acceptance.
"""
import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ORIGINAL_SHA = '34ff145d96891ddea20278700c8b1fb6fd6273ca0e71b73d8bdf0df183fdbece'
DIRECTIONS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
EXPECTED_MAPS = list(range(1, 19))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require(value, message):
    if not value:
        raise ValueError(message)


def child(directory, name):
    require(isinstance(name, str) and name and not Path(name).is_absolute(), 'Expected relative evidence path')
    base = directory.resolve()
    result = (base / name).resolve()
    require(result != base and result.is_relative_to(base), 'Evidence path leaves its source directory')
    return result


def collect_reports(roots, result):
    selected, seen_sources = {}, set()
    for value in roots:
        path = Path(value).resolve()
        if path.is_dir():
            path /= 'report.json'
        try:
            require(path not in seen_sources, 'Duplicate source report')
            seen_sources.add(path)
            raw = path.read_bytes()
            data = json.loads(raw)
            source = {'path': str(path), 'sha256': sha(raw), 'bytes': len(raw),
                      'reportedPass': data.get('pass'), 'capturedAllRequested': data.get('capturedAllRequested')}
            result['sources'].append(source)
            require(data.get('swfSha256') == ORIGINAL_SHA, 'Original SWF fingerprint differs')
            require(data.get('errors') == [], 'Aggregate contains global errors')
            require(data.get('framesPerDirection') == 3, 'Expected the existing three-frame directional capture')
            require(isinstance(data.get('cases'), list), 'Missing aggregate cases')
            maps_in_source = set()
            for case_index, case in enumerate(data['cases']):
                index = case.get('map')
                require(type(index) is int and index in EXPECTED_MAPS, 'Invalid map identifier')
                require(index not in maps_in_source, 'Duplicate map within one source report')
                maps_in_source.add(index)
                complete = case.get('captured') is True and case.get('gameplayVerified') is True and not case.get('error') and not case.get('errors')
                attempt = {'map': index, 'sourceReport': str(path), 'sourceReportSha256': source['sha256'],
                           'caseIndex': case_index, 'name': case.get('name'), 'complete': bool(complete), 'selected': False,
                           'captured': case.get('captured'), 'gameplayVerified': case.get('gameplayVerified'),
                           'error': case.get('error'), 'errors': case.get('errors', [])}
                result['attempts'].append(attempt)
                if complete:
                    if index in selected:
                        selected[index][2]['selected'] = False
                    attempt['selected'] = True
                    selected[index] = (path, case, attempt)
        except Exception as error:
            result['errors'].append({'stage': 'source', 'path': str(path), 'error': str(error)})
    return selected


def verify_case(index, path, case, attempt, result):
    folder = child(path.parent, f'{index:02d}')
    expected = {}
    directions = case.get('directions', [])
    require([entry.get('direction') for entry in directions] == DIRECTIONS, 'Missing or reordered directional capture')
    for direction in directions:
        frames = direction.get('frames', [])
        require(len(frames) == 3, 'Missing directional PNG record')
        for number, frame in enumerate(frames, 1):
            name = f"04-{direction['direction']}-{number:02d}.png"
            require(frame.get('file') == name, 'Directional filename does not identify its direction/sample')
            require(isinstance(frame.get('sha256'), str) and re.fullmatch('[0-9a-f]{64}', frame['sha256']), 'Missing/invalid recorded directional hash')
            expected[name] = frame['sha256']
    first_name = '03-first-gameplay.png'
    first_record = case.get('firstGameplayEvidence')
    first_expected = None
    if first_record is not None:
        require(isinstance(first_record, dict), 'Malformed first-gameplay evidence')
        first_expected = first_record.get('sha256')
        require(isinstance(first_expected, str) and re.fullmatch('[0-9a-f]{64}', first_expected), 'Malformed recorded first-gameplay hash')
        expected[first_name] = first_expected
    filenames = case.get('screenshots', [])
    require(isinstance(filenames, list) and len(set(filenames)) == len(filenames), 'Missing/duplicate screenshot list')
    require(set(expected).issubset(filenames), 'Recorded hashed image omitted from screenshot list')
    require({'00-original-main.png', '01-initial-selection.png', '02-selected-map.png', first_name}.issubset(filenames), 'Missing selected-case scene PNG')
    files = []
    for name in sorted(filenames):
        file = child(folder, name)
        require(file.suffix.lower() == '.png', 'Expected a PNG filename')
        raw = file.read_bytes()
        actual = sha(raw)
        expected_hash = expected.get(name)
        item = {'file': name, 'path': str(file), 'bytes': len(raw), 'expectedSha256': expected_hash,
                'actualSha256': actual, 'captureTimeHashRecorded': expected_hash is not None,
                'matchesCaptureTimeHash': actual == expected_hash if expected_hash is not None else None,
                'hashScope': 'capture-time-verified' if expected_hash is not None else 'computed-at-review-only'}
        files.append(item)
        if expected_hash is not None and actual != expected_hash:
            result['errors'].append({'stage': 'hash mismatch', 'map': index, **item})
    first = next(item for item in files if item['file'] == first_name)
    result['selectedMaps'].append({'map': index, 'name': case.get('name'), 'selectedCase': dict(attempt),
                                   'firstGameplay': first, 'directionalCaptureHashes': 24, 'files': files,
                                   'selectionCardSha256NotComparedToWholePng': case.get('selectionCardSha256')})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--root', action='append', required=True, help='Ordered aggregate report path or directory containing report.json')
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    output = args.out.resolve()
    require(output.suffix == '.json', 'Output must be JSON')
    result = {'classification': 'PRISTINE_CAPTURE_HASH_PROVENANCE_REVIEW', 'generatedAt': datetime.now(timezone.utc).isoformat(),
              'helperSha256': sha(Path(__file__).read_bytes()), 'sourceMutations': 0, 'originalSwfSha256': ORIGINAL_SHA,
              'expectedMaps': EXPECTED_MAPS, 'sources': [], 'attempts': [], 'selectedMaps': [], 'errors': [],
              'limitations': ['Only explicitly completed cases provide coverage. Incomplete attempts remain recorded and cannot be relabeled as completed.',
                             'A missing historical expected hash remains null. The current actual hash is only a review-time fingerprint.',
                             'selectionCardSha256 hashes a cropped map card, not the retained full-stage PNG; it is not compared to whole-file bytes.',
                             'PNG decoding, scene/visual review, and candidate/control RGB equality belong to the separate image audit.',
                             'Pristine live screenshots are not paired to candidate frames at identical input/tick/random state.']}
    selected = collect_reports(args.root, result)
    for index, (path, case, attempt) in sorted(selected.items()):
        try:
            verify_case(index, path, case, attempt, result)
        except Exception as error:
            result['errors'].append({'stage': 'selected map', 'map': index, 'sourceReport': str(path), 'error': str(error)})
    result['missingCompleteMaps'] = sorted(set(EXPECTED_MAPS) - set(selected))
    result['unverifiedSelectedMaps'] = sorted(set(selected) - {entry['map'] for entry in result['selectedMaps']})
    recorded = [item for entry in result['selectedMaps'] for item in entry['files'] if item['captureTimeHashRecorded']]
    first = [entry['firstGameplay'] for entry in result['selectedMaps']]
    first_verified = [entry['map'] for entry in result['selectedMaps'] if entry['firstGameplay']['matchesCaptureTimeHash'] is True]
    first_only = [{'map': entry['map'], **entry['firstGameplay']} for entry in result['selectedMaps'] if not entry['firstGameplay']['captureTimeHashRecorded']]
    result['recordedHashes'] = {'compared': len(recorded), 'matched': sum(item['matchesCaptureTimeHash'] is True for item in recorded),
                              'directional': sum(entry['directionalCaptureHashes'] for entry in result['selectedMaps']),
                              'firstGameplay': sum(item['captureTimeHashRecorded'] for item in first)}
    result['firstGameplayCaptureHashCoverage'] = {'verifiedMaps': first_verified, 'verified': len(first_verified), 'expected': 18,
                                                 'complete': len(first_verified) == 18, 'actualOnlyMaps': [entry['map'] for entry in first_only]}
    result['firstGameplayActualOnly'] = first_only
    result['actualPngFilesRead'] = sum(len(entry['files']) for entry in result['selectedMaps'])
    result['selectedMapCoverageComplete'] = not result['missingCompleteMaps'] and not result['unverifiedSelectedMaps']
    result['integrityOfRecordedHashesPass'] = not result['errors'] and result['selectedMapCoverageComplete'] and result['recordedHashes']['directional'] == 432 and all(item['matchesCaptureTimeHash'] is True for item in recorded)
    result['status'] = ('PASS' if result['firstGameplayCaptureHashCoverage']['complete'] else 'PARTIAL') if result['integrityOfRecordedHashesPass'] else 'FAIL'
    require(output not in [Path(source['path']) for source in result['sources']], 'Output would overwrite a source report')
    if output.exists():
        require(json.loads(output.read_text()).get('classification') == result['classification'], 'Output would overwrite unrelated existing evidence')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ['status', 'integrityOfRecordedHashesPass', 'selectedMapCoverageComplete',
                                                 'actualPngFilesRead', 'recordedHashes', 'firstGameplayCaptureHashCoverage', 'errors']}, ensure_ascii=False))
    return 0 if result['integrityOfRecordedHashesPass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
