#!/usr/bin/env python3
"""Train and evaluate an Aperture-compatible 130-feature static-sign classifier.

This deliberately creates a candidate TFLite file and never overwrites the live
model. The candidate is evaluated with TensorFlow Lite itself before it can be
considered for integration.
"""
from __future__ import annotations

import argparse
import json
import os
import random
from pathlib import Path

import numpy as np
import pandas as pd
import tensorflow as tf
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
from sklearn.model_selection import train_test_split
from sklearn.utils.class_weight import compute_class_weight

LABELS = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + list("123456789")
NUM_FEATURES = 130
SEED = 42


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    tf.random.set_seed(seed)


def load_feature_csv(path: Path, *, required: bool = True) -> tuple[np.ndarray, np.ndarray]:
    if not path.exists():
        if not required:
            return np.empty((0, NUM_FEATURES), np.float32), np.empty((0,), dtype=str)
        raise FileNotFoundError(f"Feature CSV not found: {path}")
    frame = pd.read_csv(path, low_memory=False)
    if frame.empty:
        return np.empty((0, NUM_FEATURES), np.float32), np.empty((0,), dtype=str)
    if frame.shape[1] < NUM_FEATURES + 1:
        raise ValueError(f"{path} has {frame.shape[1]} columns; expected at least 131 (130 features + label).")
    feature_frame = frame.iloc[:, :NUM_FEATURES].apply(pd.to_numeric, errors="coerce")
    labels = frame.iloc[:, -1].astype(str).str.strip().to_numpy()
    values = feature_frame.to_numpy(dtype=np.float32)
    if not np.isfinite(values).all():
        bad = int((~np.isfinite(values)).sum())
        raise ValueError(f"{path} contains {bad} non-finite/nonnumeric feature values. Fix data before training.")
    unknown = sorted(set(labels) - set(LABELS))
    if unknown:
        raise ValueError(f"{path} contains unsupported labels: {unknown}")
    if len(values) != len(labels):
        raise ValueError(f"Feature/label row mismatch in {path}")
    return values, labels


def encode(labels: np.ndarray) -> np.ndarray:
    mapping = {label: index for index, label in enumerate(LABELS)}
    return np.asarray([mapping[label] for label in labels], dtype=np.int32)


def read_external_splits(root: Path | None):
    if root is None:
        empty_x = np.empty((0, NUM_FEATURES), np.float32)
        empty_y = np.empty((0,), dtype=np.int32)
        return (empty_x, empty_y), (empty_x.copy(), empty_y.copy()), (empty_x.copy(), empty_y.copy())
    if not root.exists():
        raise FileNotFoundError(f"External landmark directory does not exist: {root}")
    data = []
    for filename in ("train.csv", "validation.csv", "test.csv"):
        x, labels = load_feature_csv(root / filename, required=False)
        data.append((x, encode(labels)))
    if not len(data[0][0]):
        raise ValueError(f"No external training rows found at {root / 'train.csv'}")
    if not len(data[1][0]) or not len(data[2][0]):
        raise ValueError("External data must provide train.csv, validation.csv, and test.csv; use the image extractor first.")
    return tuple(data)


def build_model() -> tf.keras.Model:
    inputs = tf.keras.Input(shape=(NUM_FEATURES,), name="sign_features", dtype=tf.float32)
    x = tf.keras.layers.Dense(256, activation="relu", name="dense_256")(inputs)
    x = tf.keras.layers.BatchNormalization(name="bn_256")(x)
    x = tf.keras.layers.Dropout(0.30, name="dropout_256")(x)
    x = tf.keras.layers.Dense(128, activation="relu", name="dense_128")(x)
    x = tf.keras.layers.BatchNormalization(name="bn_128")(x)
    x = tf.keras.layers.Dropout(0.25, name="dropout_128")(x)
    x = tf.keras.layers.Dense(64, activation="relu", name="dense_64")(x)
    x = tf.keras.layers.Dropout(0.15, name="dropout_64")(x)
    outputs = tf.keras.layers.Dense(len(LABELS), activation="softmax", name="class_scores")(x)
    model = tf.keras.Model(inputs, outputs, name="aperture_static_sign_classifier")
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=8e-4),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    return model


def make_train_dataset(x: np.ndarray, y: np.ndarray, sample_weights: np.ndarray, batch_size: int, seed: int):
    ds = tf.data.Dataset.from_tensor_slices((x, y, sample_weights))
    ds = ds.shuffle(min(len(x), 12000), seed=seed, reshuffle_each_iteration=True)

    def augment(features, label, weight):
        coords = features[:126]
        second_hand_present = tf.cast(features[128] >= 0.0, tf.float32)
        mask = tf.concat([tf.ones((63,), tf.float32), tf.fill((63,), second_hand_present)], axis=0)
        # Do not jitter wrist-origin triplets or the absent-hand zero block.
        mask = tf.tensor_scatter_nd_update(mask, [[0], [1], [2], [63], [64], [65]], [0., 0., 0., 0., 0., 0.])
        noise = tf.random.normal((126,), stddev=0.008, dtype=tf.float32) * mask
        augmented = tf.concat([coords + noise, features[126:130]], axis=0)
        return augmented, label, weight

    ds = ds.map(augment, num_parallel_calls=tf.data.AUTOTUNE)
    return ds.batch(batch_size).prefetch(tf.data.AUTOTUNE)


def predict_with_tflite(model_path: Path, x: np.ndarray, batch_size: int = 64) -> np.ndarray:
    interpreter = tf.lite.Interpreter(model_path=str(model_path), num_threads=max(1, (os.cpu_count() or 2) - 1))
    input_detail = interpreter.get_input_details()[0]
    output_detail = interpreter.get_output_details()[0]
    if len(input_detail["shape"]) != 2 or int(input_detail["shape"][-1]) != NUM_FEATURES:
        raise ValueError(f"TFLite input shape {input_detail['shape']} does not match [batch, 130].")
    input_dtype = input_detail["dtype"]
    output_dtype = output_detail["dtype"]
    preds = []
    # Most exported models have a fixed batch size of 1. Resize if a batch dim is dynamic; otherwise use per-row inference.
    shape_signature = input_detail.get("shape_signature", input_detail["shape"])
    if int(shape_signature[0]) == -1:
        interpreter.resize_tensor_input(input_detail["index"], [min(batch_size, max(1, len(x))), NUM_FEATURES], strict=False)
        interpreter.allocate_tensors()
        input_detail = interpreter.get_input_details()[0]
        output_detail = interpreter.get_output_details()[0]
        batch_size = int(input_detail["shape"][0])
        for start in range(0, len(x), batch_size):
            batch = x[start:start + batch_size]
            if len(batch) != batch_size:
                # Run a final smaller batch after resizing.
                interpreter.resize_tensor_input(input_detail["index"], [len(batch), NUM_FEATURES], strict=False)
                interpreter.allocate_tensors()
                input_detail = interpreter.get_input_details()[0]
                output_detail = interpreter.get_output_details()[0]
            interpreter.set_tensor(input_detail["index"], batch.astype(input_detail["dtype"]))
            interpreter.invoke()
            preds.append(interpreter.get_tensor(output_detail["index"]).astype(np.float32))
    else:
        interpreter.allocate_tensors()
        for row in x:
            input_detail = interpreter.get_input_details()[0]
            output_detail = interpreter.get_output_details()[0]
            row_tensor = row.reshape(1, NUM_FEATURES).astype(input_dtype)
            interpreter.set_tensor(input_detail["index"], row_tensor)
            interpreter.invoke()
            preds.append(interpreter.get_tensor(output_detail["index"]).astype(np.float32))
    result = np.concatenate(preds, axis=0) if preds else np.empty((0, len(LABELS)), np.float32)
    if result.ndim != 2 or result.shape[1] != len(LABELS):
        raise ValueError(f"TFLite output shape {result.shape}; expected (N, {len(LABELS)}).")
    return result


def evaluate(name: str, y_true: np.ndarray, probabilities: np.ndarray, out_dir: Path) -> dict:
    if not len(y_true):
        return {"name": name, "samples": 0, "accuracy": None, "macro_f1": None}
    y_pred = np.argmax(probabilities, axis=1)
    report = classification_report(
        y_true, y_pred, labels=list(range(len(LABELS))), target_names=LABELS,
        output_dict=True, zero_division=0,
    )
    pd.DataFrame(report).T.to_csv(out_dir / f"{name}_classification_report.csv", index=True)
    pd.DataFrame(confusion_matrix(y_true, y_pred, labels=list(range(len(LABELS)))),
                 index=LABELS, columns=LABELS).to_csv(out_dir / f"{name}_confusion_matrix.csv")
    return {
        "name": name,
        "samples": int(len(y_true)),
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "macro_f1": float(f1_score(y_true, y_pred, labels=list(range(len(LABELS))), average="macro", zero_division=0)),
        "classification_report_csv": f"{name}_classification_report.csv",
        "confusion_matrix_csv": f"{name}_confusion_matrix.csv",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", required=True, help="Existing landmark_dataset_with_orientation.csv")
    parser.add_argument("--external-dir", help="Directory produced by extract_image_dataset.py (optional, recommended)")
    parser.add_argument("--baseline", help="Current live .tflite model for comparison")
    parser.add_argument("--output", default="frontend/public/models/isl_model_candidate.tflite", help="Candidate model output; live model is never overwritten")
    parser.add_argument("--reports", default="model_training/reports", help="Metrics output directory")
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--batch-size", type=int, default=128)
    parser.add_argument("--seed", type=int, default=SEED)
    args = parser.parse_args()

    seed_everything(args.seed)
    csv_path = Path(args.csv).resolve()
    output_path = Path(args.output).resolve()
    reports_dir = Path(args.reports).resolve()
    reports_dir.mkdir(parents=True, exist_ok=True)

    all_x, all_labels = load_feature_csv(csv_path)
    all_y = encode(all_labels)
    if len(all_x) < 100 or len(np.unique(all_y)) != len(LABELS):
        raise SystemExit("Need at least 100 samples and all 35 A-Z/1-9 classes in the existing CSV.")

    # Sample-level split only: the legacy CSV has no signer/session IDs, so it cannot
    # provide a signer-independent holdout. Keep that limitation explicit in the report.
    x_train, x_temp, y_train, y_temp = train_test_split(
        all_x, all_y, test_size=0.30, random_state=args.seed, stratify=all_y
    )
    x_val_old, x_test_old, y_val_old, y_test_old = train_test_split(
        x_temp, y_temp, test_size=0.50, random_state=args.seed, stratify=y_temp
    )

    ext_train, ext_val, ext_test = read_external_splits(Path(args.external_dir).resolve() if args.external_dir else None)
    if len(ext_train[0]):
        x_train = np.concatenate([x_train, ext_train[0]], axis=0)
        y_train = np.concatenate([y_train, ext_train[1]], axis=0)
        x_val = np.concatenate([x_val_old, ext_val[0]], axis=0)
        y_val = np.concatenate([y_val_old, ext_val[1]], axis=0)
        x_test = ext_test[0]
        y_test = ext_test[1]
        test_source = "external image dataset official test split (primary comparison)"
        external_test_available = True
    else:
        x_val, y_val = x_val_old, y_val_old
        x_test, y_test = x_test_old, y_test_old
        test_source = "random sample-level split of legacy CSV; not signer/session independent"
        external_test_available = False

    # Class weighting balances the old dataset and any additional image-derived rows.
    classes = np.unique(y_train)
    weights = compute_class_weight(class_weight="balanced", classes=classes, y=y_train)
    class_weight_map = {int(c): float(w) for c, w in zip(classes, weights)}
    sample_weights = np.asarray([class_weight_map[int(y)] for y in y_train], dtype=np.float32)

    model = build_model()
    train_ds = make_train_dataset(x_train, y_train, sample_weights, args.batch_size, args.seed)
    callbacks = [
        tf.keras.callbacks.EarlyStopping(monitor="val_loss", patience=12, restore_best_weights=True, verbose=1),
        tf.keras.callbacks.ReduceLROnPlateau(monitor="val_loss", factor=0.5, patience=5, min_lr=1e-6, verbose=1),
    ]
    history = model.fit(
        train_ds,
        validation_data=(x_val, y_val),
        epochs=args.epochs,
        callbacks=callbacks,
        verbose=2,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    # Keep float32 I/O for tfjs-tflite compatibility and predictable scores.
    candidate_bytes = converter.convert()
    output_path.write_bytes(candidate_bytes)

    # Evaluate the exported TFLite artifact itself—not the in-memory Keras model.
    candidate_probs = predict_with_tflite(output_path, x_test)
    candidate_metrics = evaluate("candidate", y_test, candidate_probs, reports_dir)
    metrics = {
        "labels": LABELS,
        "features": NUM_FEATURES,
        "training_rows": int(len(x_train)),
        "validation_rows": int(len(x_val)),
        "test_rows": int(len(x_test)),
        "test_source": test_source,
        "split_limitation": "The legacy CSV has no signer/session metadata. Without external official test data, metrics are sample-level only and may overestimate real-world generalisation.",
        "candidate_model": str(output_path),
        "candidate_model_bytes": len(candidate_bytes),
        "candidate_test": candidate_metrics,
        "external_official_test_available": external_test_available,
        "best_validation_accuracy": float(max(history.history.get("val_accuracy", [0.0]))),
        "best_validation_loss": float(min(history.history.get("val_loss", [float("inf")]))),
    }

    if args.baseline:
        baseline_path = Path(args.baseline).resolve()
        if baseline_path.exists():
            try:
                baseline_probs = predict_with_tflite(baseline_path, x_test)
                baseline_metrics = evaluate("baseline", y_test, baseline_probs, reports_dir)
                metrics["baseline_test"] = baseline_metrics
                metrics["candidate_minus_baseline_accuracy"] = (
                    candidate_metrics["accuracy"] - baseline_metrics["accuracy"]
                    if candidate_metrics["accuracy"] is not None and baseline_metrics["accuracy"] is not None else None
                )
                metrics["candidate_minus_baseline_macro_f1"] = (
                    candidate_metrics["macro_f1"] - baseline_metrics["macro_f1"]
                    if candidate_metrics["macro_f1"] is not None and baseline_metrics["macro_f1"] is not None else None
                )
                if not external_test_available:
                    metrics["baseline_comparison_warning"] = "The legacy model was trained/distilled using the full legacy CSV, so its score on held-out rows from that same CSV is not a fair independent comparison. Use an external test split for the real comparison."
            except Exception as exc:
                metrics["baseline_evaluation_error"] = f"{type(exc).__name__}: {exc}"

    (reports_dir / "training_metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    model.save(reports_dir / "candidate.keras")
    (reports_dir / "labels.json").write_text(json.dumps({"labels": LABELS, "input_size": NUM_FEATURES}, indent=2), encoding="utf-8")
    print(json.dumps(metrics, indent=2))
    print("\nCandidate created; live model was not overwritten.")
    if external_test_available and metrics.get("candidate_minus_baseline_accuracy") is not None:
        if metrics["candidate_minus_baseline_accuracy"] <= 0:
            print("Candidate did not improve accuracy on the external test set. Keep the live model.")
        else:
            print("Candidate improved top-1 accuracy on the external test set; review macro-F1 and per-class report before replacing the live model.")
    return 0

if __name__ == "__main__":
    main()
