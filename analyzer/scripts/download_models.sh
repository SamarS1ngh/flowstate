#!/usr/bin/env bash
set -euo pipefail

DIR="${1:-models}"
mkdir -p "$DIR"
BASE="https://essentia.upf.edu/models"

curl -fL -o "$DIR/msd-musicnn-1.pb" "$BASE/feature-extractors/musicnn/msd-musicnn-1.pb"
for m in mood_happy mood_sad mood_relaxed mood_aggressive mood_acoustic mood_party danceability; do
  curl -fL -o "$DIR/$m-msd-musicnn-1.pb" "$BASE/classification-heads/$m/$m-msd-musicnn-1.pb"
done

echo "Models downloaded to $DIR"
