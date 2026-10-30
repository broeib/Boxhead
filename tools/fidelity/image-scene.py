#!/usr/bin/env python3
"""Read-only classification of actual original game screenshots.

It compares fixed original menu lettering and the foreground of the initial
co-op score HUD. Score outlines and white glyph interiors are checked separately
so moving map walls/backgrounds cannot dominate a gameplay decision.
It never reports gameplay from a timer or from a successful click alone.
"""
import argparse
import json
from collections import deque
from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("image")
parser.add_argument("--main-template", required=True)
parser.add_argument("--game-template", required=True)
parser.add_argument("--selection-template")
parser.add_argument("--content-x", type=int, default=0)
parser.add_argument("--content-y", type=int, default=0)
args = parser.parse_args()
image = Image.open(args.image).convert("RGB")
if args.content_x < 0 or args.content_y < 0 or image.width < args.content_x + 640 or image.height < args.content_y + 480:
    raise SystemExit("Screenshot does not contain the observed 640x480 original stage")
stage = image.crop((args.content_x, args.content_y, args.content_x + 640, args.content_y + 480))
main_template = Image.open(args.main_template).convert("RGB")
game_template = Image.open(args.game_template).convert("RGB")
if main_template.size != (640, 480) or game_template.size != (640, 480):
    raise SystemExit("Templates must be reviewed original-size stage screenshots")

def mask(img, roi, kind):
    values = []
    for red, green, blue in img.crop(roi).getdata():
        if kind == "menu":
            values.append(80 <= red <= 200 and abs(red-green) <= 6 and abs(green-blue) <= 6)
        else:
            values.append(max(red, green, blue) < 65)
    return values

def match(template, roi, kind):
    expected = mask(template, roi, kind)
    actual = mask(stage, roi, kind)
    overlap = sum(a and b for a, b in zip(expected, actual))
    union = sum(a or b for a, b in zip(expected, actual))
    expected_count = sum(expected)
    if expected_count < 150:
        raise SystemExit("Reference image does not contain enough scene-specific pixels")
    return {
        "iou": overlap / union if union else 0,
        "expectedPixels": expected_count,
        "actualPixels": sum(actual),
        "overlap": overlap,
        "roi": list(roi),
    }

def score_foreground(template):
    # First four padded score digits, before the changing multiplier icon.
    # This classifier is used to confirm a newly entered level, whose score is
    # zero. It does not attempt OCR or claim to classify arbitrary huge scores.
    roi = (225, 4, 290, 32)
    reference = template.crop(roi)
    width, height = reference.size
    pixels = list(reference.getdata())
    # Remove light background connected to the ROI boundary. The white ink
    # enclosed by the dark glyph outline remains even over a white map wall.
    barrier = [max(pixel) <= 165 for pixel in pixels]
    exterior = set()
    queue = deque()
    for y in range(height):
        for x in range(width):
            if x in (0, width - 1) or y in (0, height - 1):
                index = y * width + x
                if not barrier[index] and index not in exterior:
                    exterior.add(index)
                    queue.append(index)
    while queue:
        index = queue.popleft()
        x, y = index % width, index // width
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            neighbor = ny * width + nx
            if 0 <= nx < width and 0 <= ny < height and neighbor not in exterior and not barrier[neighbor]:
                exterior.add(neighbor)
                queue.append(neighbor)
    ink = {index for index, pixel in enumerate(pixels) if min(pixel) >= 220 and index not in exterior}
    outline = set()
    for index in ink:
        x, y = index % width, index // width
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                nx, ny = x + dx, y + dy
                if 0 <= nx < width and 0 <= ny < height:
                    neighbor = ny * width + nx
                    if max(pixels[neighbor]) < 75:
                        outline.add(neighbor)
    if len(ink) < 80 or len(outline) < 80:
        raise SystemExit("Reference does not contain a sufficiently outlined initial score")
    actual = list(stage.crop(roi).getdata())
    matching_ink = sum(min(actual[index]) >= 205 for index in ink)
    matching_outline = sum(max(actual[index]) <= 100 for index in outline)
    white_recall = matching_ink / len(ink)
    outline_recall = matching_outline / len(outline)
    return {
        "method": "initial-score-foreground",
        "roi": list(roi),
        "expectedWhitePixels": len(ink),
        "expectedOutlinePixels": len(outline),
        "matchingWhitePixels": matching_ink,
        "matchingOutlinePixels": matching_outline,
        "whiteRecall": white_recall,
        "outlineRecall": outline_recall,
        "foregroundMatch": min(white_recall, outline_recall),
        "ready": white_recall >= 0.92 and outline_recall >= 0.92,
    }

main = match(main_template, (195, 204, 447, 342), "menu")
game = score_foreground(game_template)
selection = match(Image.open(args.selection_template).convert("RGB"), (224, 360, 432, 393), "game") if args.selection_template else None
print(json.dumps({
    "main": main,
    "selection": selection,
    "selectionReady": bool(selection and selection["iou"] >= 0.9),
    "coopScore": game,
    "mainReady": main["iou"] >= 0.88,
    "coopGameplayVisible": game["ready"],
    "classification": "VISUAL_SCENE_OBSERVATION_ONLY",
}))
