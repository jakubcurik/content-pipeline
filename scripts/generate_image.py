# /// script
# requires-python = ">=3.12"
# dependencies = ["google-genai>=2.7.0", "pillow>=12.0", "python-dotenv>=1.0"]
# ///
"""Generuje obrázky pro články přes Google Gemini (Nano Banana Pro).

Klíč se hledá v tomto pořadí:
  1. GEMINI_API_KEY (env / projektové .env)
  2. CLAUDE_PLUGIN_OPTION_GEMINI_API_KEY (z /plugin Configure, když je dostupné v env)

Použití:
    uv run generate_image.py <out.png> "<prompt>" [--aspect 16:9] [--resolution 2K]
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types

# Načti projektové .env (agenturní GEMINI_API_KEY), když existuje vedle cwd.
load_dotenv()

DEFAULT_MODEL = os.environ.get("GEMINI_IMAGE_MODEL", "gemini-3-pro-image-preview")
DEFAULT_ASPECT = "16:9"
DEFAULT_RESOLUTION = "2K"

SUPPORTED_ASPECTS = {"1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"}
SUPPORTED_RES = {"1K", "2K", "4K"}


def resolve_api_key() -> str | None:
    return (
        os.environ.get("GEMINI_API_KEY")
        or os.environ.get("CLAUDE_PLUGIN_OPTION_GEMINI_API_KEY")
        or os.environ.get("CLAUDE_PLUGIN_OPTION_gemini_api_key")
    )


def generate(out_path: Path, prompt: str, aspect: str, resolution: str, model: str) -> None:
    if aspect not in SUPPORTED_ASPECTS:
        sys.exit(f"Error: aspect '{aspect}' not in {sorted(SUPPORTED_ASPECTS)}")
    if resolution not in SUPPORTED_RES:
        sys.exit(f"Error: resolution '{resolution}' not in {sorted(SUPPORTED_RES)}")

    api_key = resolve_api_key()
    if not api_key:
        sys.exit(
            "Error: chybí GEMINI_API_KEY.\n"
            "  Nastav ho v /plugin → content-pipeline → Configure (gemini_api_key),\n"
            "  nebo do projektového .env jako GEMINI_API_KEY=..."
        )

    client = genai.Client(api_key=api_key)
    print(f"  Model: {model} | Aspect: {aspect} | Resolution: {resolution} | Output: {out_path}")
    print("Generating...")

    response = client.models.generate_content(
        model=model,
        contents=[prompt],
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE"],
            image_config=types.ImageConfig(aspect_ratio=aspect, image_size=resolution),
        ),
    )

    final = None
    for part in response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.data and not getattr(part, "thought", False):
            final = part.inline_data.data
            break

    if final is None:
        sys.exit("Error: Gemini nevrátil žádný obrázek (možná safety filter — zkus přeformulovat prompt).")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(final)
    print(f"  OK ({len(final) // 1024} KB)")


def main() -> None:
    ap = argparse.ArgumentParser(description="Generate image via Gemini (Nano Banana Pro)")
    ap.add_argument("out", type=Path, help="Output path (.png)")
    ap.add_argument("prompt", type=str, help="Text prompt")
    ap.add_argument("--aspect", default=DEFAULT_ASPECT, choices=sorted(SUPPORTED_ASPECTS))
    ap.add_argument("--resolution", default=DEFAULT_RESOLUTION, choices=sorted(SUPPORTED_RES))
    ap.add_argument("--model", default=DEFAULT_MODEL)
    args = ap.parse_args()
    generate(args.out, args.prompt, args.aspect, args.resolution, args.model)


if __name__ == "__main__":
    main()
