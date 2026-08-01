# flowstate — How It Works & The Journey to Release

This document explains, in plain language, **what we built**, **how the "vibe" system
actually works** (including the honest answer to "does the model learn?"), and **the
biggest errors we fought through** to ship on-device analysis in `v0.3.0-alpha`.

It's written to be read top to bottom by someone who isn't a machine-learning
specialist. Short Q&A sidebars (marked **⟢ Aside**) answer questions that came up
along the way.

---

## Table of contents

1. [What we built](#1-what-we-built)
2. [How the model works (plain language)](#2-how-the-model-works-plain-language)
   - [Step 0 — Audio into numbers](#step-0--audio-into-numbers)
   - [Step 1 — The mel-spectrogram: sound into a picture](#step-1--the-mel-spectrogram-sound-into-a-picture)
   - [Step 2 — MusiCNN: the picture into a fingerprint](#step-2--musicnn-the-picture-into-a-fingerprint)
   - [Step 3 — Mood heads: reading labels off the fingerprint](#step-3--mood-heads-reading-labels-off-the-fingerprint)
   - [Step 4 — Vibe shuffle: walking between nearby spots](#step-4--vibe-shuffle-walking-between-nearby-spots)
3. [Does it learn / evolve?](#3-does-it-learn--evolve)
4. [The biggest errors we fought through](#4-the-biggest-errors-we-fought-through)
5. [The parity gap we caught after release (resampling)](#5-the-parity-gap-we-caught-after-release-resampling)
6. [Where it landed + the one lesson](#6-where-it-landed--the-one-lesson)

---

## 1. What we built

flowstate is a music app that plays your YouTube Music library and offers
**"vibe shuffle"** — instead of random shuffle, it queues songs that *sound like*
whatever you're currently playing. The signature feature: **it figures out what
songs sound like entirely on your phone** — no PC, no server, no cloud analysis.

What a user does:

```
install APK → log in with YouTube → library syncs → tap "Analyze playlist"
(or just play songs) → vibe shuffle unlocks once 10 songs are analyzed
```

Seven parts under the hood:

| Part | Job |
|------|-----|
| **Auth** (`src/auth`) | OAuth device-flow login (the "smart TV" flow), no password typing |
| **Sync** (`src/library`) | Pulls playlists + tracks from YouTube's TV browse surface into SQLite |
| **Resolver** (`src/stream`) | Turns a videoId into a playable/downloadable audio URL |
| **Player** (`src/player`) | Playback, mini-player, full-screen player with seek + gestures |
| **Analyzer** (`src/analyze`) | **The on-device brain**: audio → "fingerprint" |
| **Engine** (`src/engine`) | Turns fingerprints into a vibe-matched queue + learns from feedback |
| **DB** (`src/db`) | SQLite: songs, playlists, and `features` (the fingerprints) |

The rest of this doc is about the **Analyzer** and **Engine** — the interesting part.

---

## 2. How the model works (plain language)

The goal of analysis: turn each song into a **fingerprint** — a list of 200 numbers
(the "embedding") plus 7 mood scores. Everything about "vibe" is built on that
fingerprint. Here's the whole chain:

```
wave → picture → fingerprint → labels → nearby-song walk → shaped by your feedback
```

### Step 0 — Audio into numbers

A song is downloaded and decoded to raw **PCM** — just a list of amplitude samples,
the speaker cone's position measured many times a second. We force it to
**16 kHz, mono**:

- **Mono** — collapse stereo to one channel. The "vibe" doesn't live in left/right.
- **16 kHz** — MusiCNN was trained at this rate; it's exactly what the model expects.

We only analyze a **120-second middle slice** — enough to characterize a song,
cheap to process.

> **⟢ Aside — why 16 kHz if music energy lives below 8 kHz?**
> Because of the **Nyquist theorem**: to capture a frequency, you must sample at
> **at least twice** it.
> - Content we care about: up to **8 kHz**.
> - Samples per second needed: **2 × 8 = 16 kHz**.
>
> They measure different things — 8 kHz is "highest pitch," 16 kHz is "samples per
> second" — and Nyquist forces the second to be double the first. **Why double:**
> you need at least two samples per wave cycle (catch the peak and the trough) to
> detect a frequency at all. Sample slower and fast wiggles vanish or fold down into
> fake lower tones — **aliasing**. (Same reason CD audio is 44.1 kHz: to cover
> hearing up to ~20 kHz you need ~40 kHz+ of sampling.)

### Step 1 — The mel-spectrogram: sound into a picture

The neural net "sees" pictures, not audio. So we turn the raw wave into a picture.

**Start:** audio is just a wiggly line — the speaker moving in and out, measured
16,000 times a second. That wiggle alone doesn't say "warm guitar" or "bright
cymbal." We reshape it, in five moves:

1. **Chop into tiny frames.** Cut the audio into chunks of **512 samples (~32 ms)**
   each. In such a short slice the sound barely changes — it's one "snapshot." Take
   one, slide forward a little, take another, **overlapping** so nothing's missed.
   → *Like filming sound as a burst of still photos.*

2. **Soften the edges.** Hard-cut chunks create fake noise later. So multiply each
   chunk by a **bell shape** — strong in the middle, fading to zero at both ends.
   → *Like feathering each photo's border so it blends instead of a harsh cut.*

3. **Split into pitches (FFT).** Each snapshot is still a wiggle. The **Fourier
   Transform** answers: *how much bass, how much midrange, how much treble is in
   here?* It turns "loudness over time" into "energy at each pitch."
   → *Like shining the sound through a prism — one messy wave splits into how much
   of each pitch it contains.*

4. **Group pitches like ears do.** Hearing isn't even — 200 vs 400 Hz is obvious,
   but 8000 vs 8200 Hz sound identical. So bunch the fine pitch detail into **96
   groups ("mel bands")** — many groups down low where we're sensitive, few up high
   where we aren't.
   → *96 "pitch buckets" spaced the way your ear actually cares.*

5. **Squash the loudness.** Loudness feels logarithmic — whisper vs shout is a huge
   number gap but a smaller *felt* difference. Taking a **log** compresses it so
   quiet detail and loud peaks both show up.
   → *Like lowering contrast so you see both bright and dark parts at once.*

**Result:** stack all the snapshots side by side → a **2D image**:
- left → right = **time**
- bottom → top = **pitch** (low to high, 96 bands)
- brightness = **how much energy** at that pitch, that moment

That's the **mel-spectrogram** — a heat-map of the song. Bass = bright blobs at the
bottom, cymbals = specks at the top, rhythm = repeating vertical stripes. **That
picture is what the neural net actually reads — never the raw audio.**

> **⟢ Aside — why this step was the hard part.** MusiCNN was trained on essentia's
> *exact* recipe: precise frame size, bell shape, band spacing, log formula. If the
> phone drew the picture even slightly differently, the model would see a wrong image
> and give bad fingerprints — with no crash, just quietly worse recommendations. So
> every constant had to match. We proved it with a **parity gate**: draw the picture
> on a Mac (essentia) and on the phone, feed both to the model, and require the two
> fingerprints to match with **cosine similarity ≥ 0.99**. We hit **1.000000**.

### Step 2 — MusiCNN: the picture into a fingerprint

Now hand that heat-map picture to the neural net. It's trained to look at the
picture and boil it down to **200 numbers** that summarize "what this song is like."

**How it looks at the picture:** it slides small **filters** across the image, each
hunting for one pattern. Two kinds:
- **Tall filters** span many pitch-bands at one instant → catch *texture/timbre*:
  "this is a distorted guitar," "this is a breathy voice."
- **Wide filters** span time at one pitch → catch *rhythm*: "steady four-on-the-floor
  beat," "slow swells."

→ *Like a jeweler with a set of stencils, checking the picture against each: "does
THIS pattern appear? this one? this one?"*

**Layer by layer it abstracts.** Early filters find simple things (a beat, a bright
band). Later layers combine those into complex ideas ("driving rock energy," "sparse
acoustic feel"). By the end it isn't looking at pixels anymore — it's looking at
*musical concepts*.

**The output — 200 numbers.** The song gets crushed down to a list of 200 values.
Not loudness, not pitch — **learned traits**. You can't name them ("number 47 = ?"),
but together they place the song at a **spot** in an imaginary 200-dimensional space.

→ *Like describing a person with 200 sliders — warmth, energy, roughness… — instead
of their raw photo. Two people with similar sliders are similar people.*

**The key property:** songs that *sound* alike get **nearby spots**. Two lo-fi tracks
land close; lo-fi and thrash-metal land far apart. **That closeness IS the vibe.**
This 200-number spot is the song's **fingerprint** (the "embedding").

*(Practical detail: the net reads the picture in 3-second chunks — 200 numbers per
chunk — then averages them into one fingerprint for the whole song.)*

### Step 3 — Mood heads: reading labels off the fingerprint

The 200 numbers are powerful but nameless. So **7 tiny models** sit on top, each
answering one yes/no question by reading the fingerprint: happy? sad? relaxed?
aggressive? acoustic? party? danceable?

Each outputs a **0–1 score** ("82% happy").

→ *Like a panel of 7 quick judges, each glancing at the fingerprint and holding up
one number.*

They're cheap because the hard work is already done — the fingerprint encodes
everything; the judges just translate it into words. These power the **mood chips**
in the player.

### Step 4 — Vibe shuffle: walking between nearby spots

Every analyzed song is now a **spot** in that 200-dimensional space. Playing a song =
standing on its spot.

**Vibe shuffle** measures the **angle** between your current spot and every other
song's spot (**cosine similarity** — a small angle means very alike), then picks the
next song from the **closest** ones.

→ *Like a star map where similar-sounding songs cluster together. You're standing on
one star; vibe shuffle hops to a neighbor, not a random star across the galaxy.*

That's the whole trick: **turn every song into a point, then walk to nearby points.**

*(The exact score is `similarity⁴ × recency × feedbackBias`: similarity dominates,
recency avoids replaying what you just heard, and feedbackBias is your thumbs-down
history — see the next section.)*

---

## 3. Does it learn / evolve?

**The neural network does NOT learn.** MusiCNN is **pre-trained and frozen**. It
never trains on your device, never updates its weights, and produces the *same*
fingerprint for the same audio forever. That part is fixed "ears," not adaptive AI.

**But the app adapts to you**, in a preference layer *on top of* the fixed
fingerprints:

- Hit **"Doesn't fit"** in the player → that song gets pushed away in future queues.
- **It generalizes** — songs *near* the rejected one in the 200-d space (very
  similar sound), played from a similar context, also get pushed away. Reject one,
  and it avoids the whole neighborhood — you don't have to rate every track.
- **It forgets** — every dislike **fades over time**.

> **⟢ Aside — what "forgets over ~30 days" actually means.**
> A thumbs-down isn't permanent. Each "Doesn't fit" starts at full strength (1.0),
> and that strength **halves every 30 days**:
> - today → **1.0** (fully suppressed)
> - 30 days → **0.5**
> - 60 days → **0.25**
> - 90 days → **0.125** … fading toward zero.
>
> **Why:** taste changes. A genre you couldn't stand in January you might love by
> June. If dislikes were permanent, the app would be frozen to your *old* self,
> forever avoiding stuff you've since grown into. The fade means **recent feedback
> dominates and stale feedback drops away**, so the vibe tracks *current* you.
>
> And it's self-correcting: if you *still* dislike it, you'll thumbs-down again →
> strength resets to full. Keep hating it → it stays gone. Stop caring → it fades
> back in. **You only keep rejecting the things you still reject.**

So the honest framing: **fixed ears, adaptive taste.** The model's *perception* of
sound is constant; the app's *preferences* about which perceptions to string
together are personal, feedback-driven, and time-decaying. It also "grows" in the
trivial sense that coverage improves — more analyzed songs means richer candidate
pools and better matches.

---

## 4. The biggest errors we fought through

The path to release was mostly debugging. The big ones, in the order they hurt:

### a) Mel-spectrogram parity — the existential risk
If the phone's picture didn't match essentia's, every fingerprint would be subtly
wrong and vibe matching would silently degrade — no crash, just bad recommendations,
impossible to debug after the fact. So we built the **parity gate first**, before
any app code: draw the picture + fingerprint on a Mac (essentia, in Docker), do the
same on the phone, require **cosine ≥ 0.99**. The usual culprits (filterbank
normalization, log offset, off-by-one framing) were tuned in a pure-numpy reference,
then ported to Kotlin. Final match: **1.000000 across all 12 test clips.** This gate
is the reason we could trust everything downstream.

### b) Analysis silently produced ZERO results — the error that hid for a whole session
The biggest one, because it was **four bugs stacked**, each masking the next:

1. **"Verified" that was never verified.** Earlier work marked the inference tasks
   "device-verified," but they'd never actually run on a real phone. The feature
   *looked* finished and was 100% broken. (The lesson of the whole project.)

2. **Models never loaded.** `require('./model.tflite')` bundled the models as Android
   *raw resources*, whose only runtime handle is a bare name with no URL scheme. The
   TFLite library did `new URL("src_analyze_models_…")` → **`MalformedURLException:
   no protocol`**. Every song died at model-load.
   → **Fix:** ship the models as real Android *assets*, copy them to the filesystem
   once at startup, load via a proper `file://` URL.

3. **The failures were invisible.** Release builds strip `console.warn`, so there was
   zero error output. Worse, the progress bar counts each song "done" even when it
   fails — so **100% failure looked exactly like slow progress.** We thought it was
   slow; it was broken.

4. **The debug build lied too.** To read logs we built a *debug* build — but debug
   loads its JavaScript from the Metro dev-server over an `adb reverse` tunnel.
   Restarting Metro left a **stale tunnel serving old cached code**, so our fixes
   appeared to do nothing.
   → **Lesson:** *release* builds bundle JS deterministically — **use a release build
   to actually verify JS changes.** Use debug only to read logs, never to trust
   *which* code is running.

### c) YouTube throttled the download — the real "why is it so slow"
With models finally loading, songs then failed at **download** — every one hit the
60-second timeout. Cause: googlevideo serves a plain open-ended GET at **~playback
speed** (a 4-minute song downloads in ~4 minutes), so it never finished in time.
→ **Fix:** request the **smallest** audio-only format (analysis downsamples to 16 kHz
mono anyway, so bitrate is irrelevant) with a **bounded `Range` header**
(`bytes=0-12582911`), which the CDN delivers in one fast burst instead of throttling.
Result: **60s+ timeout → ~30 s/song.** This single change turned "broken and slow"
into "works."

### d) The Mac ran out of disk mid-build
A native build filled the disk (Gradle caches ballooned). Recovered by clearing
caches blind and rebuilding cold (~11 min). No data lost.

### e) Player swipe gesture
Horizontal swipe-to-change-track didn't fire — two competing pan gestures in a race,
and real touch input lost the race. Replaced with a single pan that picks its
dominant axis per frame.

### f) Performance + release hygiene
Before the fixes, decode ran over the *entire* track then threw most away, and the
audio buffer was needlessly base64-round-tripped across the JS↔native bridge — fixed
by seeking to the middle, bounding the decode, and keeping the buffer native (~3×
faster). The final packaging pass caught a stray `debuggable true` on release builds
(shouldn't ship) and slimmed the APK from **~140 MB → ~49 MB** by shipping only the
`arm64-v8a` native libraries instead of four architectures.

---

## 5. The parity gap we caught after release (resampling)

After `v0.3.0-alpha` shipped, we went back and stress-tested the one claim we'd only
half-proven: *"the phone fingerprints a song exactly as well as the reference computer
(essentia) does."* It turned out to be **not quite true on real songs** — and chasing
it down led to a real fix. This is the story, in plain language.

### The suspicion
The parity gate that gave us "cosine 1.0" only ever ran on **synthetic test sounds**
(beeps, noise, chords), and it fed them in **past** the first two steps of the pipeline
(unpacking the audio file + shrinking it to 16 kHz). So "perfect match" was proven for
the *back half* of the process, on *fake* audio. The front half, on *real* songs, was
never checked.

### Finding it — like a detective ruling out suspects
1. **Test for real.** Took 5 real songs. Fed the **identical file** to both the phone
   and essentia, all steps, and compared the fingerprints. They were **~5% off**
   (cosine 0.934–0.967), not the ~0% we'd claimed. So the gap was real.
2. **Rule out "different chunk."** Maybe the two just analyzed different 2-minute slices
   of the song? Shifted essentia's slice by several seconds — the fingerprint barely
   moved (still 0.997). Not the cause.
3. **Catch the culprit.** The front half has two suspect steps: *unpacking* the audio
   and *shrinking* it to 16 kHz. I took essentia's own good unpacking, then re-did
   **only the shrink** the phone's cheap way — and the exact ~5% error reappeared. That
   pinned it: **the shrink step was guilty; unpacking was innocent.**

### What "shrinking" means
Digital audio is the speaker's position measured very fast — a song file measures it
**44,100 times per second**. The AI model only wants **16,000 times per second**. So
before analysis we convert 44,100 → 16,000 measurements per second. Fewer data points =
"shrinking" (the real word is **resampling**). You can't just keep every ~3rd
measurement — that injects fake tones (**aliasing**). You have to *recompute* the new
points smoothly. **How well you recompute them was the whole bug.**

### Cheap way vs proper way

The old audio has values at whole positions 0, 1, 2, 3… To shrink, you need values at
**in-between** spots — e.g. position 2.76, then 5.51, then 8.27… (because 44,100 ÷
16,000 ≈ 2.76 apart). Each time: *what's the value at 2.76, given the neighbors?*

**Cheap way — straight line between 2 dots (linear interpolation).**
Look at the 2 nearest points (2 and 3), draw a straight line, read the value at 2.76.
Uses 2 points, 1 step. Fast — but a sound wave *curves* between points, so the
straight-line guess cuts corners and smears the sound (and lets fake high tones
through). This is what was shipping.

**Proper way — smooth curve through many dots (windowed-sinc).**
To find 2.76, use **many** nearby points (we use 64 on each side) and add them up, each
with a **weight** from a special ripple-shaped curve (a *sinc*): nearest points count
most, far ones ripple smaller.

```
new value at 2.76 = w1·(pt 2) + w2·(pt 3) + w3·(pt 4) + …   (~128 points)

weight   │      ╱╲          ← nearest points matter most
         │ ╱╲  ╱  ╲  ╱╲
         │╱  ╲╱    ╲╱  ╲     ← far points matter a little (alternating +/–)
```

That ripple curve is the mathematically-correct recipe for **reconstructing the true
smooth wave** through all those points — so you read its *real* value at 2.76 instead of
a straight-line guess. It also acts as a **filter that removes the too-high tones** that
would otherwise alias.

→ *Connect-the-dots: cheap draws straight lines between dots (jagged, wrong); proper
fits one smooth curve through many dots at once (matches the real shape). Same as
resizing a photo with the "quick" setting vs a proper resize.*

### Fixing it — matching the exact recipe
Knowing "use a proper shrink" wasn't enough — essentia uses a *specific* recipe, and we
had to match it. First attempt (a decent windowed-sinc) improved 5% off → ~2% off, but
not a match; and just using more points didn't help. So I ran a **bake-off**: many
recipes with different settings, each measured against essentia. The winner — a
**Kaiser** window, 64 points per side, cutoff pulled to 0.90 of the limit (leaving a
"transition band" that kills the last aliasing) — hit the target. Ported that exact
recipe into the phone's code (`AudioDecoder.kt`, replacing `linearResample` with
`sincResample`), rebuilt, and re-ran the same 5 songs on the real device.

### Result

| Shrink method | how far off (min cosine) | mean |
|---------------|-------------------------:|-----:|
| straight-line (was shipping) | 0.934 | 0.957 |
| decent sinc (Hann window) | 0.965 | 0.977 |
| **proper sinc (Kaiser, tuned)** | **0.994** | **0.996** ✅ |

Now the phone fingerprints real songs **essentially identically** to the reference —
proven end-to-end on actual music, not just test tones. A real-song parity check was
added to the app so this can't silently regress. Cost: the proper shrink is a bit slower
(~14 s/song more); a precomputed lookup table can recover most of that later.

**The method, reused:** *suspect the claim → test for real → isolate the guilty step by
elimination → find the exact recipe that matches → write it in → re-verify on the real
device.* Same shape as every other bug in this project.

## 6. Where it landed + the one lesson

`v0.3.0-alpha` — on-device analysis, no PC required.

- ~30 s/song; vibe shuffle unlocks at 10 analyzed songs; each song is analyzed once,
  then cached forever.
- Verified live on a real phone: the analyzed count climbs, vibe shuffle enables, and
  playing it opens a real vibe session driven by on-device fingerprints.
- Honest limits: bulk-analyzing a whole large playlist is still a long background job
  (~30 s × number of songs); it's designed around "10 unlocks it, the rest fills in
  gradually."

**The through-line lesson:** *a feature isn't done because the code compiles and the
tests pass — it's done when you've watched it work on the actual device.* Nearly this
entire release was the distance between "looks finished" and "actually works."
