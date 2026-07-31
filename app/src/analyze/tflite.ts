import {loadTensorflowModel, TensorflowModel} from 'react-native-fast-tflite';
import * as RNFS from '@dr.pogodin/react-native-fs';

// Models are shipped as real Android assets under `assets/models/` (copied
// there from `src/analyze/models/` -- see android/app/src/main/assets/models).
//
// WHY NOT `require('./models/*.tflite')`: with `tflite` in metro assetExts,
// require() bundles each model as an Android `raw` resource whose only handle
// at runtime is a bare resource name ("src_analyze_models_msdmusicnn1", no
// scheme). react-native-fast-tflite@3's native Android loader passes that
// straight into `new URL(...)`, which throws `MalformedURLException: no
// protocol: src_analyze_models_msdmusicnn1` -- so EVERY analyzeSong failed at
// model load and zero features rows were ever written (caught on-device via
// the debug-build logcat). fast-tflite explicitly supports `{ url: 'file://..'}`
// (README), so instead we copy each bundled asset to the app's files dir once
// and load it by real filesystem path.
const EMBEDDING_ASSET = 'models/msd-musicnn-1.tflite';

// One binary-softmax head per mood. Input is the pooled [1,200] embedding,
// output [1,2] softmax over {class 0, class 1} -- see POSITIVE_INDEX below
// for which index is the "positive" (mood-present) class per head.
const HEAD_ASSETS: Record<string, string> = {
  happy: 'models/mood_happy-msd-musicnn-1.tflite',
  sad: 'models/mood_sad-msd-musicnn-1.tflite',
  relaxed: 'models/mood_relaxed-msd-musicnn-1.tflite',
  aggressive: 'models/mood_aggressive-msd-musicnn-1.tflite',
  acoustic: 'models/mood_acoustic-msd-musicnn-1.tflite',
  party: 'models/mood_party-msd-musicnn-1.tflite',
  danceable: 'models/danceability-msd-musicnn-1.tflite',
};

// Copy a bundled Android asset to the files dir (once) and return a
// `file://` URL fast-tflite can load. Idempotent: skips the copy if the
// destination already exists (models are immutable, shipped in the APK).
async function assetToFileUrl(assetPath: string): Promise<{url: string}> {
  const dest = `${RNFS.DocumentDirectoryPath}/${assetPath}`;
  const destDir = dest.slice(0, dest.lastIndexOf('/'));
  await RNFS.mkdir(destDir).catch(() => {});
  if (!(await RNFS.exists(dest))) {
    await RNFS.copyFileAssets(assetPath, dest);
  }
  return {url: `file://${dest}`};
}

// Per-head positive-class index, carried over from the v1 (Mac) analyzer --
// see analyzer/flowstate_analyzer/features.py's MOOD_HEADS comment, sourced
// from the essentia classification-heads metadata JSON's "classes" field
// (and locked down by analyzer/tests/test_features_polarity.py):
//   mood_happy:      ["happy", "non_happy"]           -> index 0
//   mood_sad:        ["non_sad", "sad"]                -> index 1
//   mood_relaxed:    ["non_relaxed", "relaxed"]         -> index 1
//   mood_aggressive: ["aggressive", "not_aggressive"]   -> index 0
//   mood_acoustic:   ["acoustic", "non_acoustic"]       -> index 0
//   mood_party:      ["non_party", "party"]             -> index 1
//   danceability:    ["danceable", "not_danceable"]     -> index 0
export const POSITIVE_INDEX: Record<string, number> = {
  happy: 0,
  sad: 1,
  relaxed: 1,
  aggressive: 0,
  acoustic: 0,
  party: 1,
  danceable: 0,
};

const MEL_PATCH_FRAMES = 187;
const MEL_PATCH_BANDS = 96;
const EMBEDDING_DIM = 200;

let embeddingModel: TensorflowModel | undefined;
let headModels: Record<string, TensorflowModel> | undefined;

/** Load the embedding + 7 mood-head models once, caching them for reuse. */
export async function loadModels(): Promise<void> {
  if (embeddingModel && headModels) return;

  embeddingModel = await loadTensorflowModel(await assetToFileUrl(EMBEDDING_ASSET), []);

  const entries = await Promise.all(
    Object.entries(HEAD_ASSETS).map(async ([name, assetPath]) => {
      const model = await loadTensorflowModel(await assetToFileUrl(assetPath), []);
      return [name, model] as const;
    }),
  );
  headModels = Object.fromEntries(entries);
}

function ensureLoaded(): {
  embedding: TensorflowModel;
  heads: Record<string, TensorflowModel>;
} {
  if (!embeddingModel || !headModels) {
    throw new Error('tflite models not loaded -- call loadModels() first');
  }
  return {embedding: embeddingModel, heads: headModels};
}

/**
 * Mean-pool a list of per-patch model outputs (each length `dim`) into a
 * single vector, matching v1's `patches.mean(axis=0)` (features.py).
 * Pure function -- unit-tested directly in __tests__/tflite.test.ts.
 */
export function meanPool(outputs: Float32Array[], dim: number): Float32Array {
  if (outputs.length === 0) {
    throw new Error('meanPool requires at least one output to pool');
  }
  const pooled = new Float32Array(dim);
  for (const output of outputs) {
    if (output.length !== dim) {
      throw new Error(`meanPool: expected length ${dim}, got ${output.length}`);
    }
    for (let i = 0; i < dim; i++) {
      pooled[i] += output[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    pooled[i] /= outputs.length;
  }
  return pooled;
}

/**
 * Select the positive-class probability from a binary-softmax head output,
 * matching v1's `probs.mean(axis=0)[positive_index]` (features.py). `softmax`
 * is the head's raw 2-element output ([class0, class1]).
 * Pure function -- unit-tested directly in __tests__/tflite.test.ts.
 */
export function pickMood(softmax: Float32Array, positiveIndex: number): number {
  if (softmax.length !== 2) {
    throw new Error(`pickMood: expected a 2-element softmax output, got ${softmax.length}`);
  }
  if (positiveIndex !== 0 && positiveIndex !== 1) {
    throw new Error(`pickMood: positiveIndex must be 0 or 1, got ${positiveIndex}`);
  }
  return softmax[positiveIndex];
}

/**
 * Run each [187,96] mel patch through the embedding model and mean-pool the
 * [200] outputs into one Float32Array(200), matching v1's
 * `TensorflowPredictMusiCNN(...).mean(axis=0)`.
 */
export async function runEmbedding(patches: Float32Array[]): Promise<Float32Array> {
  if (patches.length === 0) {
    throw new Error('runEmbedding requires at least one patch');
  }
  const {embedding} = ensureLoaded();

  const expectedLength = MEL_PATCH_FRAMES * MEL_PATCH_BANDS;
  const outputs: Float32Array[] = [];
  for (const patch of patches) {
    if (patch.length !== expectedLength) {
      throw new Error(
        `runEmbedding: expected patch of length ${expectedLength} (187x96), got ${patch.length}`,
      );
    }
    const [output] = await embedding.run([patch.buffer as ArrayBuffer]);
    // .slice() is REQUIRED, not cosmetic: `new Float32Array(output)` is a
    // zero-copy VIEW when `output` is an ArrayBuffer (react-native-fast-tflite
    // reuses the same native output buffer across .run() calls) -- without a
    // copy, every entry in `outputs` ends up aliasing the SAME underlying
    // memory, so by the time meanPool() runs, all entries silently read back
    // as the LAST patch's values (meanPool of N aliases of the same array is
    // just that array). Confirmed on-device (Task 5): this collapsed the
    // pooled embedding to patch[last]'s output alone, which happened to look
    // fine (~0.99+ cosine) for near-stationary fixtures whose patches barely
    // differ from each other, but was caught by the `sweep_50_7900hz` chirp
    // fixture (patches vary a lot -- cosine 0.6954 before this fix, ~1.0 after).
    // `.slice()` forces an independent copy (new buffer, byteOffset 0) at the
    // moment each result is read, before the next .run() call can overwrite it.
    const outArr = new Float32Array(output).slice();
    outputs.push(outArr);
  }
  return meanPool(outputs, EMBEDDING_DIM);
}

/**
 * Run the pooled [200] embedding through each of the 7 mood heads, applying
 * the per-head positive-class index (POSITIVE_INDEX) to each head's [2]
 * softmax output.
 */
export async function runMoods(embedding: Float32Array): Promise<Record<string, number>> {
  if (embedding.length !== EMBEDDING_DIM) {
    throw new Error(`runMoods: expected embedding of length ${EMBEDDING_DIM}, got ${embedding.length}`);
  }
  const {heads} = ensureLoaded();

  const moods: Record<string, number> = {};
  for (const [name, model] of Object.entries(heads)) {
    const [output] = await model.run([embedding.buffer as ArrayBuffer]);
    moods[name] = pickMood(new Float32Array(output), POSITIVE_INDEX[name]);
  }
  return moods;
}

/**
 * Full pipeline: mel patches -> pooled 200-d embedding + 7 mood scores.
 * Loads models on first call (cached thereafter).
 */
export async function analyzeEmbeddingAndMoods(
  patches: Float32Array[],
): Promise<{embedding: Float32Array; moods: Record<string, number>}> {
  await loadModels();
  const embedding = await runEmbedding(patches);
  const moods = await runMoods(embedding);
  return {embedding, moods};
}
