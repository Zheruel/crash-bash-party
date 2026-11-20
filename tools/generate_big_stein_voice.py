#!/usr/bin/env python3
"""Regenerate the Big Stein announcer MP3 from the disc's rendered SFX.

On Apple Silicon, run with mlx-audio==0.6.6, mlx==0.32.4, and ffmpeg
with libmp3lame. The Qwen3-TTS checkpoint is loaded from the local HF cache.
"""

import argparse
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

os.environ["HF_HUB_OFFLINE"] = "1"

import mlx.core as mx
from mlx_audio.audio_io import write
from mlx_audio.tts.utils import load_model
import numpy as np


AUDIO = Path(__file__).resolve().parents[1] / "assets" / "audio"
MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16"
REVISION = "a6eb4f68e4b056f1215157bb696209bc82a6db48"
MODEL_RATE = 24000
DISC_RATE = 12000
TRANSCRIPT = "Coco. Cortex. Tiny. Wins."


def decode(path, rate, filters=None):
    command = ["ffmpeg", "-v", "error", "-i", str(path)]
    if filters:
        command += ["-af", filters]
    command += ["-ar", str(rate), "-ac", "1", "-f", "f32le", "-"]
    return np.frombuffer(subprocess.check_output(command), dtype="<f4")


def make_reference(path):
    voices = json.loads((AUDIO / "voices.json").read_text())
    family = voices["families"]["c"]
    # The first ID in each 50-ID block is the announcer's character call.
    clips = [voices["ids"][family[block]][str(block * 50 + 1)] for block in (1, 2, 6)]
    clips.append("sfx/0278/14.mp3")
    segments = []
    for clip in clips:
        samples = decode(AUDIO / clip, MODEL_RATE)
        rms = np.sqrt(np.convolve(samples**2, np.ones(240) / 240, "same"))
        voiced = np.flatnonzero(rms > 0.011)
        segments.extend([
            samples[max(0, voiced[0] - 384):voiced[-1] + 384],
            np.zeros(1800, dtype=np.float32),
        ])
    write(path, np.concatenate(segments), MODEL_RATE)


def generate(output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output.parent) as temp:
        reference = Path(temp) / "reference.wav"
        take = Path(temp) / "take.wav"
        encoded = Path(temp) / "big-stein.mp3"
        make_reference(reference)

        model = load_model(MODEL, revision=REVISION)
        mx.random.seed(5)
        result = next(model.generate(
            "Big Stein!", lang_code="english", ref_audio=str(reference),
            ref_text=TRANSCRIPT, max_tokens=48, temperature=0.75,
        ))
        write(take, np.array(result.audio, dtype=np.float32), result.sample_rate)

        # Match the disc calls' bandwidth, cadence, and limited peak dynamics.
        samples = decode(take, DISC_RATE, (
            "highpass=f=72,equalizer=f=270:t=o:w=1.3:g=1.8,"
            "equalizer=f=2300:t=o:w=1.8:g=1.4,lowpass=f=5500,"
            "atempo=1.12,acompressor=threshold=0.28:ratio=2.5:attack=1:release=32:knee=2:detection=peak,"
            "afade=t=in:d=0.005,afade=t=out:st=1.085:d=0.055"
        ))
        rms = np.sqrt(np.mean(samples**2))
        peak = np.max(np.abs(samples))
        gain = min(10**(-13.2 / 20) / rms, 10**(-0.9 / 20) / peak)
        subprocess.run([
            "ffmpeg", "-v", "error", "-f", "f32le", "-ar", str(DISC_RATE),
            "-ac", "1", "-i", "-", "-map_metadata", "-1",
            "-c:a", "libmp3lame", "-b:a", "40k", str(encoded),
        ], input=(samples * gain).astype("<f4").tobytes(), check=True)
        encoded.replace(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=AUDIO / "sfx/custom/big-stein.mp3")
    generate(parser.parse_args().output)
