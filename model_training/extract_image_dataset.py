#!/usr/bin/env python3
"""Convert labelled still-sign images into Aperture's 130-feature CSV format.

Expected input layout (RealSign style):
  DATASET_ROOT/Training/A/*.jpg
  DATASET_ROOT/Validation/A/*.jpg
  DATASET_ROOT/Testing/A/*.jpg

Also accepts one class folder level anywhere under the root. Folder names must
match A-Z or 1-9. If no explicit train/validation/test folder exists, images are
split per class 70/15/15 with a fixed seed and the report says this is only a
file-level split (not signer-independent).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import cv2
import numpy as np

LABELS = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + list("123456789")
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
TASK_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)
CSV_COLUMNS = [
    f"hand{hand}_lm{point}_{axis}"
    for hand in (1, 2)
    for point in range(21)
    for axis in ("x", "y", "z")
] + ["hand1_orientation", "hand1_is_left", "hand2_orientation", "hand2_is_left", "label"]


def infer_label(path: Path) -> str | None:
    for part in reversed(path.parts[:-1]):
        candidate = part.strip().upper()
        if candidate in LABELS:
            return candidate
    return None


def infer_split(path: Path) -> str | None:
    # Handles canonical folder names and common dataset labels such as
    # "Training (A-Z)" / "Testing (A-Z)".
    aliases = (
        ("training", "train"), ("train", "train"),
        ("validation", "validation"), ("valid", "validation"), ("val", "validation"),
        ("testing", "test"), ("test", "test"),
    )
    for part in path.parts[:-1]:
        candidate = part.strip().lower()
        for prefix, split in aliases:
            if candidate == prefix or candidate.startswith(prefix + " ") or candidate.startswith(prefix + "_") or candidate.startswith(prefix + "-"):
                return split
    return None


def normalize_landmarks(landmarks: list[Any]) -> list[float]:
    """Match the browser preprocessing: wrist origin, scaled by wrist-to-MCP9 distance."""
    if len(landmarks) < 21:
        raise ValueError("A hand must contain 21 landmarks")
    wrist = landmarks[0]
    middle_mcp = landmarks[9]
    dx = float(middle_mcp.x) - float(wrist.x)
    dy = float(middle_mcp.y) - float(wrist.y)
    dz = float(middle_mcp.z) - float(wrist.z)
    scale = max((dx * dx + dy * dy + dz * dz) ** 0.5, 0.001)
    values: list[float] = []
    for point in landmarks[:21]:
        values.extend([
            (float(point.x) - float(wrist.x)) / scale,
            (float(point.y) - float(wrist.y)) / scale,
            (float(point.z) - float(wrist.z)) / scale,
        ])
    return values


def orientation_features(landmarks: list[Any], handedness_label: str) -> tuple[float, float]:
    thumb_tip = landmarks[4]
    palm_center_x = sum(float(landmarks[i].x) for i in (5, 9, 13, 17)) / 4.0
    thumb_is_left = float(thumb_tip.x) < palm_center_x
    is_palm = thumb_is_left if handedness_label == "Right" else not thumb_is_left
    return (1.0 if is_palm else 0.0, 1.0 if handedness_label == "Left" else 0.0)


def build_feature_row(hand_landmarks: list[list[Any]], handednesses: list[str], label: str) -> list[float | str]:
    """Make a 130-number row in detector order plus the class label."""
    if label not in LABELS:
        raise ValueError(f"Unsupported class label: {label}")
    hands = [(lm, handednesses[i] if i < len(handednesses) else "Right")
             for i, lm in enumerate(hand_landmarks[:2]) if len(lm) >= 21]
    if not hands:
        raise ValueError("No hand detected")

    features = [0.0] * 130
    features[126:130] = [-1.0, -1.0, -1.0, -1.0]
    for hand_idx, (landmarks, handedness) in enumerate(hands):
        coords = normalize_landmarks(landmarks)
        start = hand_idx * 63
        features[start:start + 63] = coords
        orient, is_left = orientation_features(landmarks, handedness)
        features[126 + hand_idx * 2] = orient
        features[127 + hand_idx * 2] = is_left
    values = np.asarray(features, dtype=np.float64)
    if not np.isfinite(values).all():
        raise ValueError("Feature row contains non-finite values")
    return [*map(float, features), label]


def ensure_task_model(path: Path) -> None:
    if path.exists() and path.stat().st_size > 100_000:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading MediaPipe hand-landmarker model to {path} ...")
    request = urllib.request.Request(TASK_MODEL_URL, headers={"User-Agent": "Aperture-ISL-Training/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response, path.open("wb") as target:
        target.write(response.read())
    if path.stat().st_size < 100_000:
        path.unlink(missing_ok=True)
        raise RuntimeError("Downloaded MediaPipe task model is unexpectedly small")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Extracted labelled image dataset root")
    parser.add_argument("--output", required=True, help="Output directory for train/validation/test CSVs")
    parser.add_argument("--task-model", default="model_training/assets/hand_landmarker.task")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    input_root = Path(args.input).resolve()
    output_root = Path(args.output).resolve()
    if not input_root.is_dir():
        parser.error(f"Input dataset directory does not exist: {input_root}")

    files: list[tuple[Path, str, str | None]] = []
    ignored = 0
    for path in input_root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in IMAGE_EXTS:
            continue
        label = infer_label(path.relative_to(input_root))
        if label is None:
            ignored += 1
            continue
        files.append((path, label, infer_split(path.relative_to(input_root))))

    if not files:
        parser.error("No labelled images found. Put images in A/, B/, ... or split/class folders.")

    split_names = {split for _, _, split in files if split}
    explicit_splits = bool(split_names)
    if explicit_splits and not {"train", "validation", "test"}.issubset(split_names):
        missing = {"train", "validation", "test"} - split_names
        parser.error(f"Some explicit split folders were found, but these splits are missing: {sorted(missing)}. Keep the dataset's official split folders together.")

    assignments: dict[Path, str] = {}
    if explicit_splits:
        for path, _label, split in files:
            if split is None:
                # Skip visualization/reference files outside official split folders.
                continue
            assignments[path] = split
    else:
        by_label: dict[str, list[Path]] = defaultdict(list)
        for path, label, _split in files:
            by_label[label].append(path)
        rng = np.random.default_rng(args.seed)
        for label, label_paths in by_label.items():
            paths = sorted(label_paths)
            rng.shuffle(paths)
            n = len(paths)
            n_train = max(1, int(n * 0.70))
            n_val = max(1, int(n * 0.15)) if n >= 3 else 0
            for i, path in enumerate(paths):
                split = "train" if i < n_train else ("validation" if i < n_train + n_val else "test")
                assignments[path] = split

    task_model = Path(args.task_model).resolve()
    ensure_task_model(task_model)

    # Lazy imports give a useful message when the training extras are not installed.
    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
    except ImportError as exc:
        raise SystemExit("Install model_training/requirements.txt before extraction (MediaPipe is required).") from exc

    options = vision.HandLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(task_model)),
        running_mode=vision.RunningMode.IMAGE,
        num_hands=2,
        min_hand_detection_confidence=0.45,
        min_hand_presence_confidence=0.45,
        min_tracking_confidence=0.5,
    )

    output_root.mkdir(parents=True, exist_ok=True)
    rows: dict[str, list[list[float | str]]] = {"train": [], "validation": [], "test": []}
    manifest = []
    failures: Counter[str] = Counter()
    processed = 0
    with vision.HandLandmarker.create_from_options(options) as landmarker:
        for index, (path, label, _declared_split) in enumerate(files, 1):
            split = assignments.get(path)
            if split is None:
                continue
            image_bgr = cv2.imread(str(path))
            if image_bgr is None:
                failures["unreadable_image"] += 1
                continue
            image_rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
            image_rgb = np.ascontiguousarray(image_rgb)
            try:
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=image_rgb)
                result = landmarker.detect(image)
                hand_landmarks = result.hand_landmarks or []
                handednesses = [
                    (item[0].category_name if item else "Right")
                    for item in (result.handedness or [])
                ]
                row = build_feature_row(hand_landmarks, handednesses, label)
            except ValueError as exc:
                failures[str(exc)] += 1
                continue
            except Exception as exc:  # keep a corrupt file from aborting a long extraction
                failures[f"processing_error:{type(exc).__name__}"] += 1
                continue
            rows[split].append(row)
            processed += 1
            manifest.append({
                "csv_split": split,
                "label": label,
                "relative_path": str(path.relative_to(input_root)).replace("\\", "/"),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "detected_hands": len(hand_landmarks),
            })
            if index % 500 == 0:
                print(f"Visited {index}/{len(files)} images; extracted {processed}")

    for split, split_rows in rows.items():
        out_csv = output_root / f"{split}.csv"
        with out_csv.open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(CSV_COLUMNS)
            writer.writerows(split_rows)

    with (output_root / "manifest.csv").open("w", newline="", encoding="utf-8") as f:
        columns = ["csv_split", "label", "relative_path", "sha256", "detected_hands"]
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()
        writer.writerows(manifest)

    report = {
        "input_root": str(input_root),
        "total_image_files": len(files),
        "ignored_unlabelled_images": ignored,
        "processed": processed,
        "split_counts": {k: len(v) for k, v in rows.items()},
        "failed_counts": dict(failures),
        "official_split_folders_detected": explicit_splits,
        "split_warning": None if explicit_splits else "File-level random split only; not signer-independent. Keep separate person/session data when available.",
        "feature_layout": "126 normalized coordinates (2 x 21 x 3) + 4 orientation/handedness values",
    }
    (output_root / "extraction_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    if processed == 0:
        return 2
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
