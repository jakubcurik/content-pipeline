# /// script
# requires-python = ">=3.12"
# dependencies = ["markdown>=3.7"]
# ///
"""Export hotového článku do přenosného balíčku BEZ WordPressu.

Pro klienty, kteří nepublikují přes WP REST. Vyrobí samostatné `export/`:
  - index.html  — kompletní HTML dokument (<head> meta + JSON-LD schema inline + tělo)
  - article.html — jen tělo článku (k vložení do existujícího CMS editoru)
  - meta.json    — title, description, slug, schema, alt texty
  - images/      — kopie obrázků (relativní cesty zachované)

Schema (Article/FAQPage/BreadcrumbList) se vkládá inline do <head>, protože tu
není žádný CMS/SEO plugin, který by ho emitoval.

Použití:
    uv run publish_markdown.py <draft_dir> --config clients/<x>/client.config.json
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from html import escape
from pathlib import Path

import markdown as md_lib

IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
H1_RE = re.compile(r"^#\s+.+?$", re.MULTILINE)


def load_config(path: str | None) -> dict:
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        sys.exit(f"Chyba: client config '{path}' neexistuje")
    return json.loads(p.read_text(encoding="utf-8"))


def load_article(target: str) -> tuple[Path, str, dict]:
    d = Path(target)
    if not d.is_dir():
        sys.exit(f"Chyba: '{target}' není adresář článku.")
    article, meta_path = d / "article.md", d / "meta.json"
    if not article.exists() or not meta_path.exists():
        sys.exit(f"Chyba: v {d} chybí article.md nebo meta.json.")
    return d, article.read_text(encoding="utf-8"), json.loads(meta_path.read_text(encoding="utf-8"))


def render_body(md: str) -> str:
    body = H1_RE.sub("", md, count=1).lstrip("\n")  # H1 dá <title>/hlavička dokumentu
    return md_lib.markdown(body, extensions=["extra", "sane_lists"])


def schema_scripts(meta: dict) -> str:
    out = []
    for key in ("article", "faqpage", "breadcrumb"):
        node = meta.get("schema", {}).get(key)
        if node:
            out.append(f'<script type="application/ld+json">{json.dumps(node, ensure_ascii=False)}</script>')
    return "\n".join(out)


def full_document(meta: dict, body_html: str, lang: str, canonical: str) -> str:
    title = meta.get("title") or meta.get("h1", "")
    desc = meta.get("description", "")
    h1 = meta.get("h1") or meta.get("title", "")
    head = [
        f'<meta charset="utf-8">',
        f'<meta name="viewport" content="width=device-width, initial-scale=1">',
        f"<title>{escape(title)}</title>",
        f'<meta name="description" content="{escape(desc)}">',
    ]
    if canonical:
        head.append(f'<link rel="canonical" href="{escape(canonical)}">')
        head.append(f'<meta property="og:url" content="{escape(canonical)}">')
    head.append(f'<meta property="og:title" content="{escape(title)}">')
    head.append(f'<meta property="og:description" content="{escape(desc)}">')
    if meta.get("featured_image"):
        head.append(f'<meta property="og:image" content="{escape(meta["featured_image"])}">')
    schema = schema_scripts(meta)
    return (
        f'<!doctype html>\n<html lang="{escape(lang)}">\n<head>\n'
        + "\n".join(head) + ("\n" + schema if schema else "")
        + f'\n</head>\n<body>\n<article>\n<h1>{escape(h1)}</h1>\n{body_html}\n</article>\n</body>\n</html>\n'
    )


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description="Export článku do přenosného HTML balíčku (bez WP)")
    ap.add_argument("target", help="Adresář článku (article.md + meta.json + images/)")
    ap.add_argument("--config", help="Cesta ke client.config.json (jazyk, canonical base)")
    args = ap.parse_args()

    config = load_config(args.config)
    draft_dir, md, meta = load_article(args.target)
    lang = config.get("locale", {}).get("language_code", "cs")
    base = config.get("site", {}).get("primary_url", "").rstrip("/")
    canonical = f"{base}/{meta.get('slug', '')}" if base and meta.get("slug") else ""

    export = draft_dir / "export"
    export.mkdir(parents=True, exist_ok=True)

    body_html = render_body(md)
    (export / "article.html").write_text(body_html, encoding="utf-8")
    (export / "index.html").write_text(full_document(meta, body_html, lang, canonical), encoding="utf-8")
    (export / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    # Zkopíruj obrázky
    src_images = draft_dir / "images"
    copied = 0
    if src_images.is_dir():
        dst_images = export / "images"
        dst_images.mkdir(exist_ok=True)
        for img in src_images.iterdir():
            if img.is_file():
                shutil.copy2(img, dst_images / img.name)
                copied += 1

    print(f"✓ Export hotový → {export}")
    print(f"  index.html (celý dokument se schema) + article.html (jen tělo) + meta.json")
    print(f"  Obrázky zkopírovány: {copied}")
    print(f"  Canonical: {canonical or '— (nenastaven primary_url v configu)'}")


if __name__ == "__main__":
    main()
