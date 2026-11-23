#!/usr/bin/env python3
"""Render the arena announcer calls with the Big Stein voice reference.

Use the Apple Silicon MLX dependencies from generate_big_stein_voice.py
and install the web dependencies to read the stage registry.
"""

import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

import numpy as np

from generate_big_stein_voice import (
    AUDIO, DISC_RATE, MODEL, REVISION, TRANSCRIPT, decode, load_model, make_reference, mx, write,
)


def stages() -> list[dict[str, str]]:
    web = AUDIO.parents[1] / "web"
    return json.loads(subprocess.check_output([
        "node_modules/.bin/tsx", "--eval", """
            import { GAMES } from './shared/registry';
            console.log(JSON.stringify(GAMES.flatMap(game => game.variants?.length
              ? game.variants.map(v => ({ key: game.id + '_' + v.id, name: v.name }))
              : [{ key: game.id, name: game.name }])));
        """,
    ], cwd=web))


def spoken_name(name: str) -> str:
    pronunciations = {"N.BALLISM": "N. Ballism", "DANTE'S DASH": "Dante's Dash"}
    return pronunciations.get(name, name.title()) + "!"


def encode(take: Path, output: Path):
    samples = decode(take, DISC_RATE, (
        "highpass=f=72,equalizer=f=270:t=o:w=1.3:g=1.8,"
        "equalizer=f=2300:t=o:w=1.8:g=1.4,lowpass=f=5500,"
        "atempo=1.12,acompressor=threshold=0.28:ratio=2.5:attack=1:release=32:knee=2:detection=peak"
    ))
    envelope = np.sqrt(np.convolve(samples**2, np.ones(120) / 120, "same"))
    voiced = np.flatnonzero(envelope > 0.012)
    if not len(voiced):
        raise ValueError(f"No speech in {output.name}")
    samples = samples[max(0, voiced[0] - 120):voiced[-1] + 300].copy()
    samples[:60] *= np.linspace(0, 1, 60)
    samples[-120:] *= np.linspace(1, 0, 120)
    rms, peak = np.sqrt(np.mean(samples**2)), np.max(np.abs(samples))
    gain = min(10**(-13.2 / 20) / rms, 10**(-0.9 / 20) / peak)
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(DISC_RATE), "-ac", "1", "-i", "-",
        "-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", "40k", str(output),
    ], input=(samples * gain).astype("<f4").tobytes(), check=True)
    print(f"{output.name}: {len(samples) / DISC_RATE:.2f}s", flush=True)


def generate():
    roster = stages()
    out = AUDIO / "sfx/custom/stages"
    out.mkdir(exist_ok=True, parents=True)
    with TemporaryDirectory() as temp:
        reference, take = (Path(temp) / name for name in ("reference.wav", "take.wav"))
        make_reference(reference)
        model = load_model(MODEL, revision=REVISION)

        def render(batch, seed, max_tokens, temperature):
            mx.random.seed(seed)
            for result in model.batch_generate(
                [phrase for _, phrase in batch], lang_code="english",
                ref_audio=str(reference), ref_text=TRANSCRIPT,
                max_tokens=max_tokens, temperature=temperature,
            ):
                key, _ = batch[result.sequence_idx]
                if key is not None:
                    write(take, np.array(result.audio, dtype=np.float32), result.sample_rate)
                    encode(take, out / f"{key}.mp3")

        for start in range(0, len(roster), 7):
            render([
                (stage["key"], spoken_name(stage["name"])) for stage in roster[start:start + 7]
            ], seed=5, max_tokens=60, temperature=0.65)

        # Keep the take order from the pronunciation pass. Batch position affects sampling.
        render([
            (None, "N, Ballism!"),
            (None, "En. Ball-ism!"),
            (None, "En Ball izm!"),
            (None, "Drain, Bash!"),
            ("crateToss_drain", "DRAIN BASH!"),
        ], seed=31, max_tokens=44, temperature=0.55)
        render([
            (None, "Dreyn Bash!"),
            ("tilePainter_agogo", "Pogo, a go-go!"),
            (None, "POGO A GO-GO!"),
            (None, "Pogo agogo!"),
        ], seed=31, max_tokens=44, temperature=0.55)
        render([
            (None, "Enn! BAL-lizm!"),
            (None, "EN, BAL-lizm!"),
            (None, "En: Ballism!"),
            ("ballDefence_nballism", "N! Ball-ism!"),
            (None, "N-BALLISM!"),
        ], seed=43, max_tokens=44, temperature=0.55)


if __name__ == "__main__":
    generate()
