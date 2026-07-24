#!/usr/bin/env python3
"""Convert the essentia MusiCNN embedding model + 7 mood-head models
(TF1 frozen graphs, `.pb`) to TFLite for later on-device inference.

Dev tool only — NOT used by the v1 analyzer (flowstate_analyzer/features.py),
which keeps using essentia's TensorflowPredictMusiCNN / TensorflowPredict2D
directly against the original `.pb` files. This script and its output
(`analyzer/models_tflite/*.tflite`) exist purely to unblock Plan D's
on-device (phone) inference path.

Must run in an environment with the same `.pb` files (baked into the
flowstate-analyzer image at /models) and a TensorFlow install providing
`tf.compat.v1.lite.TFLiteConverter.from_frozen_graph`. Essentia is NOT
required for this script — it operates purely on frozen GraphDefs via
TensorFlow, and essentia isn't needed until Task 2/3 (mel fixtures, parity).

The flowstate-analyzer image does not ship a pip `tensorflow` package
(essentia-tensorflow links libtensorflow.so internally, without Python
bindings) AND is amd64-only, which under Rosetta/QEMU emulation on an
Apple Silicon host makes `pip install tensorflow` + `import tensorflow`
extremely slow (minutes, due to double binary translation). Since this
script needs TF but NOT essentia, the practical/reproducible recipe used
was to extract the `.pb` files out of the (architecture-independent) image
and run this script in a *native* arm64 Python container instead:

    docker create --name _tmp flowstate-analyzer
    docker cp _tmp:/models ./analyzer/.models_cache/models
    docker rm _tmp

    docker run --rm -v "$PWD/analyzer:/work" \
      -v "$PWD/analyzer/.models_cache/models:/models:ro" -w /work \
      python:3.10-slim bash -c \
      "pip install --no-cache-dir 'tensorflow==2.13.1' && \
       python scripts/convert_tflite.py --models-dir /models --out-dir models_tflite"

On an amd64 host (or if emulation isn't a bottleneck), the equivalent
single-image invocation is:

    docker run --rm --entrypoint bash -v "$PWD/analyzer:/work" -w /work \
      flowstate-analyzer -c \
      "pip install --no-cache-dir 'tensorflow-cpu==2.13.1' && \
       python scripts/convert_tflite.py"

Tensor names/shapes: essentia's published model metadata JSON (e.g.
https://essentia.upf.edu/models/feature-extractors/musicnn/msd-musicnn-1.json)
lists the embedding input as `model/Placeholder` shape [187, 96] with NO
batch dim, and each head's input as `model/Placeholder` shape [200], also
with no batch dim. Inspecting the actual frozen GraphDefs (via
tf.compat.v1.import_graph_def + Graph.get_operations()) shows the metadata
omits the leading batch dimension: the real placeholders are rank-3
[None, 187, 96] (embedding) and rank-2 [None, 200] (heads). We freeze the
batch dim at 1 for TFLite (essentia feeds patches one at a time internally
and stacks/means results across patches; the on-device code does the same).
See docs/superpowers/sdd/plan-d-task1-report.md for the full inspection
output this was confirmed against.

  Embedding model (msd-musicnn-1.pb):
    input:  model/Placeholder     shape [1, 187, 96]  dtype float32
            (one MusiCNN patch: 187 frames x 96 mel bands, batch=1)
    output: model/dense/BiasAdd   shape [1, 200]      dtype float32
            (the 200-d embedding; essentia's TensorflowPredictMusiCNN
             default output)

    NOTE: the embedding graph also has a second placeholder,
    `model/Placeholder_1` (dtype bool, unknown shape — almost certainly a
    training-mode/dropout flag). It is NOT an ancestor of
    `model/dense/BiasAdd` (verified: running the frozen graph's session
    with only `model/Placeholder` fed succeeds and produces the correct
    (1, 200) output), so it is safely omitted from input_arrays here and
    is pruned by the converter.

  Mood head models (7x <name>-msd-musicnn-1.pb):
    input:  model/Placeholder   shape [1, 200]   dtype float32
            (a single 200-d embedding vector, batch=1)
    output: model/Softmax        shape [1, 2]     dtype float32
            (2-class softmax; positive-class index varies per head --
             see MOOD_HEADS in flowstate_analyzer/features.py, unchanged
             here)

Usage (inside the container, repo mounted at /work):
    python scripts/convert_tflite.py [--models-dir /models] [--out-dir models_tflite]
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import tensorflow as tf

tf.get_logger().setLevel("ERROR")

EMBED_MODEL = "msd-musicnn-1.pb"
EMBED_INPUT = "model/Placeholder"
EMBED_INPUT_SHAPE = [1, 187, 96]
EMBED_OUTPUT = "model/dense/BiasAdd"

HEAD_MODELS = [
    "mood_happy-msd-musicnn-1.pb",
    "mood_sad-msd-musicnn-1.pb",
    "mood_relaxed-msd-musicnn-1.pb",
    "mood_aggressive-msd-musicnn-1.pb",
    "mood_acoustic-msd-musicnn-1.pb",
    "mood_party-msd-musicnn-1.pb",
    "danceability-msd-musicnn-1.pb",
]
HEAD_INPUT = "model/Placeholder"
HEAD_INPUT_SHAPE = [1, 200]
HEAD_OUTPUT = "model/Softmax"


def load_graph_def(pb_path: Path) -> tf.compat.v1.GraphDef:
    graph_def = tf.compat.v1.GraphDef()
    with tf.io.gfile.GFile(str(pb_path), "rb") as f:
        graph_def.ParseFromString(f.read())
    return graph_def


def run_frozen_graph(
    graph_def: tf.compat.v1.GraphDef,
    input_name: str,
    output_name: str,
    feed: np.ndarray,
) -> np.ndarray:
    with tf.compat.v1.Graph().as_default() as g:
        tf.compat.v1.import_graph_def(graph_def, name="")
        input_t = g.get_tensor_by_name(input_name + ":0")
        output_t = g.get_tensor_by_name(output_name + ":0")
        with tf.compat.v1.Session(graph=g) as sess:
            return sess.run(output_t, feed_dict={input_t: feed})


def convert_one(
    pb_path: Path,
    out_path: Path,
    input_name: str,
    input_shape: list[int],
    output_name: str,
) -> None:
    graph_def = load_graph_def(pb_path)
    converter = tf.compat.v1.lite.TFLiteConverter.from_frozen_graph(
        str(pb_path),
        input_arrays=[input_name],
        output_arrays=[output_name],
        input_shapes={input_name: input_shape},
    )
    tflite_model = converter.convert()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(tflite_model)
    print(f"  wrote {out_path} ({len(tflite_model)} bytes)")


def verify_one(
    pb_path: Path,
    tflite_path: Path,
    input_name: str,
    input_shape: list[int],
    output_name: str,
    atol: float,
    seed: int,
) -> float:
    """Run the same fixed-random input through both the frozen graph and
    the converted .tflite; return max abs diff between outputs."""
    rng = np.random.default_rng(seed)
    feed = rng.uniform(-1.0, 1.0, size=input_shape).astype(np.float32)

    graph_def = load_graph_def(pb_path)
    ref_out = run_frozen_graph(graph_def, input_name, output_name, feed)

    interpreter = tf.lite.Interpreter(model_path=str(tflite_path))
    interpreter.allocate_tensors()
    in_detail = interpreter.get_input_details()[0]
    out_detail = interpreter.get_output_details()[0]
    interpreter.set_tensor(in_detail["index"], feed.reshape(in_detail["shape"]))
    interpreter.invoke()
    tfl_out = interpreter.get_tensor(out_detail["index"])

    ref_flat = np.asarray(ref_out).reshape(-1)
    tfl_flat = np.asarray(tfl_out).reshape(-1)
    max_diff = float(np.max(np.abs(ref_flat - tfl_flat)))

    status = "OK" if max_diff <= atol else "FAIL"
    print(
        f"  [{status}] ref shape={ref_flat.shape} tflite shape={tfl_flat.shape} "
        f"max_abs_diff={max_diff:.3e} (tolerance {atol:.0e})"
    )
    return max_diff


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models-dir", default="/models", type=Path)
    parser.add_argument("--out-dir", default="models_tflite", type=Path)
    parser.add_argument("--seed", default=1234, type=int)
    args = parser.parse_args()

    print(f"TensorFlow version: {tf.__version__}")
    args.out_dir.mkdir(parents=True, exist_ok=True)

    results: dict[str, float] = {}

    # --- Embedding model ---
    embed_pb = args.models_dir / EMBED_MODEL
    embed_tflite = args.out_dir / EMBED_MODEL.replace(".pb", ".tflite")
    print(f"\nConverting embedding model: {embed_pb}")
    convert_one(embed_pb, embed_tflite, EMBED_INPUT, EMBED_INPUT_SHAPE, EMBED_OUTPUT)
    print("Verifying embedding model fidelity:")
    results["embedding"] = verify_one(
        embed_pb,
        embed_tflite,
        EMBED_INPUT,
        EMBED_INPUT_SHAPE,
        EMBED_OUTPUT,
        atol=1e-4,
        seed=args.seed,
    )

    # --- Head models ---
    for head_pb_name in HEAD_MODELS:
        head_pb = args.models_dir / head_pb_name
        head_tflite = args.out_dir / head_pb_name.replace(".pb", ".tflite")
        print(f"\nConverting head model: {head_pb}")
        convert_one(head_pb, head_tflite, HEAD_INPUT, HEAD_INPUT_SHAPE, HEAD_OUTPUT)
        print("Verifying head model fidelity:")
        results[head_pb_name] = verify_one(
            head_pb,
            head_tflite,
            HEAD_INPUT,
            HEAD_INPUT_SHAPE,
            HEAD_OUTPUT,
            atol=1e-3,
            seed=args.seed,
        )

    print("\n=== Summary (max abs diff) ===")
    for name, diff in results.items():
        print(f"  {name}: {diff:.3e}")


if __name__ == "__main__":
    main()
