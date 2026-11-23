#!/usr/bin/env python3
"""Render Big Stein's and Top G's character lines: python3 tools/generate_custom_voices.py [--only stein,topg].

Use the Apple Silicon MLX setup from generate_big_stein_voice.py, plus SciPy and faster-whisper==1.2.1 (small.en in the local HF
cache) to pick takes. Each voice is designed from a text description with Qwen3-TTS VoiceDesign, never from a recording
of a real person. The Base model then clones that designed reference for every line, so one character keeps one voice.
Every line gets six candidates. The take whose transcript, length and peak fit the cue best is filtered to the disc
calls' bandwidth, trimmed, faded and levelled to the stock roster's mean for that cue (web/client/shell/voice.ts).
"""

import argparse
from difflib import SequenceMatcher
import os
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory

os.environ["HF_HUB_OFFLINE"] = "1"

import mlx.core as mx
from mlx_audio.audio_io import write
from mlx_audio.tts.utils import load_model
import numpy as np
from scipy.ndimage import maximum_filter1d, minimum_filter1d

AUDIO = Path(__file__).resolve().parents[1] / "assets" / "audio"
DESIGN = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16"
CLONE = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
CLONE_REVISION = "a6eb4f68e4b056f1215157bb696209bc82a6db48"
DISC_RATE = 12000
CANDIDATES = 6
BATCH = 3

# Mean active level (dBFS RMS over samples whose 20 ms envelope passes 0.01) of the stock roster's take for each cue,
# measured on assets/audio/sfx at 12 kHz. Cue keys follow voice.ts: the voice id within a character's block.
LEVEL = {2: -13.9, 'hit': -12.2, 7: -14.2, 0xc: -22.0, 0xd: -21.6, 0xe: -16.0, 0xf: -20.0, 0x10: -19.5,
         0x16: -16.2, 0x17: -18.9, 0x18: -20.5, 0x19: -21.0, 0x1a: -21.0, 0x1b: -21.0, 'lose': -14.2, 'draw': -14.2}
# Length window in seconds after trimming. The stock takes run 0.15-0.25 s for a jump or landing, about 0.45 s for a
# hit and 1.0-1.2 s for a taunt or win. Ours run a little longer where a word needs it.
LENGTH = {2: (.6, 1.5), 'hit': (.2, .6), 7: (.6, 1.5), 0xc: (.12, .4), 0xd: (.1, .35), 0xe: (.3, .9), 0xf: (.25, 1.),
          0x10: (.2, .9), 0x16: (.4, 1.), 0x17: (.15, .45), 0x18: (.25, .9), 0x19: (.25, .8), 0x1a: (.15, .45),
          0x1b: (.25, .8), 'lose': (.6, 1.5), 'draw': (.6, 1.5)}

VOICES = {
    "stein": dict(
        folder="big-stein",
        instruct=("A deep, gravelly older man in his sixties. Smug, theatrical cartoon tycoon with a booming, "
                  "chuckling delivery and a slight New York accent. Energetic, crisp, playful."),
        reference="Ha! Welcome to my party, everybody. Big money, big moves, and the biggest grin in the whole arena. "
                  "Watch this!",
        seed=4,
        lines={
            2: ["Read 'em and weep!", "Too rich for you!", "Is that all, kiddo?"],
            'hit': ["Oof!", "Agh!", "Hngh!", "Ack!"],
            7: ["Ka-ching! Pay up!", "Ha! Too easy!"],
            0xc: ["Hup!", "Hoo!", "Yup!"],
            0xd: ["Hmph.", "Oomph."],
            0xe: ["Hi-yaaah!", "Whirlwind!"],
            0xf: ["Mine!", "Gotcha!", "Heavy money!"],
            0x10: ["Catch!", "Hyah!", "Keep the change!"],
            0x16: ["Out of my way!"],
            0x17: ["Hey!"],
            0x18: ["Move it!", "Coming through!", "Yah!"],
            0x19: ["Ha-haa!"],
            0x1a: ["Hi-yah!"],
            0x1b: ["Woo-hoo!"],
            'lose': ["This is rigged!", "I want a refund!"],
            'draw': ["A tie? Boring!"],
        },
    ),
    "topg": dict(
        folder="top-g",
        instruct=("A brash, confident man in his thirties with a deep, raspy baritone and a mid-Atlantic "
                  "British-American accent. Loud boxing-champion hype energy, punchy, cocky but playful, like a "
                  "cartoon action hero."),
        reference="Listen up, champ. I train harder, I move faster, and I never lose. Step into my ring and try to keep up!",
        seed=4,
        lines={
            2: ["Try to keep up, rookie!", "You call that training?", "Champions don't sweat!"],
            'hit': ["Ugh!", "Oof!", "Agh!", "Nngh!"],
            7: ["Undefeated, baby!", "Champion! As always!"],
            0xc: ["Hup!", "Hah!", "Up!"],
            0xd: ["Hmph.", "Huh."],
            0xe: ["Spinning kick!", "Whirlwind kick!"],
            0xf: ["Light work!", "Mine now!", "Easy lift!"],
            0x10: ["Special delivery!", "Hyah!", "Catch this!"],
            0x16: ["Ignition!"],
            0x17: ["Yo!"],
            0x18: ["Full throttle!", "Out the way!", "Go, go!"],
            0x19: ["Let's go!"],
            0x1a: ["Hi-yah!"],
            0x1b: ["Yeah, baby!"],
            'lose': ["Rematch. Now!", "That was a warm-up!"],
            'draw': ["A draw? Overtime!"],
        },
    ),
}
NAMES = {2: 'taunt', 'hit': 'hit', 7: 'win', 0xc: 'jump', 0xd: 'land', 0xe: 'spin', 0xf: 'pickup', 0x10: 'throw',
         0x16: 'dash-start', 0x17: 'call', 0x18: 'dash', 0x19: 'cheer', 0x1a: 'burst', 0x1b: 'whoop',
         'lose': 'lose', 'draw': 'draw'}


def decode(path, rate, filters=None):
    command = ["ffmpeg", "-v", "error", "-i", str(path)]
    if filters:
        command += ["-af", filters]
    command += ["-ar", str(rate), "-ac", "1", "-f", "f32le", "-"]
    return np.frombuffer(subprocess.check_output(command), dtype="<f4").copy()


def active_rms(samples):
    envelope = np.sqrt(np.convolve(samples**2, np.ones(240) / 240, "same"))
    voiced = samples[envelope > .01]
    return np.sqrt(np.mean(voiced**2)) if len(voiced) else 0


def master(take, level):
    """Disc-call bandwidth and dynamics, trimmed to the voiced span and levelled to the stock cue."""
    samples = decode(take, DISC_RATE, (
        "highpass=f=72,afftdn=nr=10:nf=-42,equalizer=f=270:t=o:w=1.3:g=1.8,"
        "equalizer=f=2300:t=o:w=1.8:g=1.4,lowpass=f=5500,atempo=1.06,"
        "acompressor=threshold=0.28:ratio=2.5:attack=1:release=32:knee=2:detection=peak"
    ))
    envelope = np.sqrt(np.convolve(samples**2, np.ones(120) / 120, "same"))
    voiced = np.flatnonzero(envelope > .02 * envelope.max())
    samples = samples[max(0, voiced[0] - 90):voiced[-1] + 240].copy()
    samples[:48] *= np.linspace(0, 1, 48)
    samples[-120:] *= np.linspace(1, 0, 120)
    # Level to the stock cue, then hold peaks under -1 dBFS with a 5 ms look-ahead limiter. The stock takes are dense
    # (about 10 dB crest), so a peaky take would otherwise land under the cue's level.
    ceiling = 10**(-1 / 20)
    gain = 1.
    for _ in range(4):
        gain *= 10**(level / 20) / max(active_rms(limit(samples * gain, ceiling)), 1e-6)
    return limit(samples * gain, ceiling)


def limit(samples, ceiling):
    window = 61
    peaks = maximum_filter1d(np.abs(samples), window)
    reduction = np.minimum(1, ceiling / np.maximum(peaks, 1e-9))
    reduction = minimum_filter1d(reduction, window)
    reduction = np.convolve(reduction, np.hanning(window) / np.hanning(window).sum(), "same")
    return np.clip(samples * reduction, -ceiling, ceiling)


def encode(samples, output):
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(DISC_RATE), "-ac", "1", "-i", "-",
        "-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", "40k", str(output),
    ], input=samples.astype("<f4").tobytes(), check=True)


def words(text):
    return re.sub(r"[^a-z ]", "", text.lower().replace("-", " ")).split()


def score(text, heard, length, window, peak):
    """Higher is better: transcript fit first, then length inside the cue's window, then headroom."""
    fit = SequenceMatcher(None, " ".join(words(text)), " ".join(words(heard))).ratio()
    if len(words(text)) == 1 and words(heard):
        fit = max(fit, .6)  # Interjections transcribe loosely; any single voiced word will do.
    low, high = window
    spill = max(0, low - length, length - high)
    return fit - 2 * spill - (.3 if peak > .99 else 0)


def generate(only, wanted=None):
    from faster_whisper import WhisperModel
    asr = WhisperModel("small.en", device="cpu", compute_type="int8")
    design = load_model(DESIGN)
    references = {}
    with TemporaryDirectory() as temp:
        temp = Path(temp)
        for key in only:
            voice = VOICES[key]
            mx.random.seed(voice["seed"])
            result = next(design.generate(voice["reference"], instruct=voice["instruct"], lang_code="english",
                                          temperature=.8, max_tokens=400))
            path = temp / f"{key}-reference.wav"
            write(path, np.array(result.audio, dtype=np.float32), result.sample_rate)
            segments, _ = asr.transcribe(decode(path, 16000), beam_size=5, language="en")
            references[key] = path, " ".join(s.text.strip() for s in segments)
        del design
        clone = load_model(CLONE, revision=CLONE_REVISION)
        for key in only:
            voice = VOICES[key]
            reference, transcript = references[key]
            folder = AUDIO / "sfx/custom" / voice["folder"]
            folder.mkdir(parents=True, exist_ok=True)
            jobs = [(cue, index, text) for cue, texts in voice["lines"].items()
                    for index, text in enumerate(texts, 1)
                    if not wanted or f'{voice["folder"]}/{NAMES[cue]}-{index}' in wanted]
            best = {}
            # One batch holds every candidate of a few lines. Its sequences sample independently.
            for start in range(0, len(jobs), BATCH):
                batch = [job for job in jobs[start:start + BATCH] for _ in range(CANDIDATES)]
                mx.random.seed(voice["seed"] + start)
                for result in clone.batch_generate([text for _, _, text in batch], lang_code="english",
                                                   ref_audio=str(reference), ref_text=transcript,
                                                   max_tokens=60, temperature=.8):
                    cue, index, text = batch[result.sequence_idx]
                    take = temp / "take.wav"
                    write(take, np.array(result.audio, dtype=np.float32), result.sample_rate)
                    try:
                        samples = master(take, LEVEL[cue])
                    except IndexError:
                        continue
                    segments, _ = asr.transcribe(decode(take, 16000), beam_size=5, language="en")
                    heard = " ".join(s.text.strip() for s in segments)
                    value = score(text, heard, len(samples) / DISC_RATE, LENGTH[cue],
                                  np.abs(decode(take, DISC_RATE)).max())
                    if (cue, index) not in best or value > best[cue, index][0]:
                        best[cue, index] = value, heard, samples
            for cue, index, text in jobs:
                value, heard, samples = best[cue, index]
                name = f"{NAMES[cue]}-{index}.mp3"
                encode(samples, folder / name)
                print(f"{voice['folder']}/{name}\t{text}\theard {heard!r}\t"
                      f"{len(samples) / DISC_RATE:.2f}s\tscore {value:.2f}", flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", default="stein,topg")
    parser.add_argument("--takes", help="re-render only these takes, e.g. top-g/jump-2,big-stein/dash-3")
    args = parser.parse_args()
    generate(args.only.split(","), set(args.takes.split(",")) if args.takes else None)
