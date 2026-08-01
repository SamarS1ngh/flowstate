import json, glob
import numpy as np
from flowstate_analyzer.features import Extractor
ext = Extractor("/models", segment_s=120)
out = {}
for f in sorted(glob.glob("/audio/*.m4a")):
    name = f.split("/")[-1]
    try:
        feats = ext.extract(f)
        emb = np.frombuffer(feats.embedding, dtype=np.float32)
        out[name] = {"embedding": emb.tolist(), "moods": feats.moods}
        print("OK", name, "emb_len", len(emb))
    except Exception as e:
        print("FAIL", name, repr(e))
json.dump(out, open("/audio/essentia_ref.json", "w"))
print("wrote", len(out), "refs")
