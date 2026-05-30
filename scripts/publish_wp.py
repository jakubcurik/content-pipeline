# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx>=0.28", "markdown>=3.7", "python-dotenv>=1.0"]
# ///
"""Publikace hotového článku na WordPress přes REST API (theme-agnostic).

Nahraje obrázky do Media Library, převede `article.md` na HTML (přepíše cesty
obrázků na nahrané URL), volitelně vloží SEO meta podle presetu a vytvoří post.
**Default status `draft`** — `publish` projde jen s `--allow-publish`.

SEO meta preset (publish.seo_meta_preset v client.config.json nebo --seo-preset):
    rankmath | yoast | custom | none

Credentials z .env klienta (clients/<x>/.env): WP_URL, WP_USER, WP_APP_PASSWORD
(App Password — mezery ZACHOVÁVEJ, nestripuj).

Použití:
    uv run publish_wp.py <draft_dir> --config clients/<x>/client.config.json --dry-run
    uv run publish_wp.py <draft_dir> --config clients/<x>/client.config.json
    uv run publish_wp.py <draft_dir> --config clients/<x>/client.config.json --update 123
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

import httpx
import markdown as md_lib
from dotenv import load_dotenv

IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
H1_RE = re.compile(r"^#\s+.+?$", re.MULTILINE)
CONTENT_TYPES = {".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg",
                 ".jpeg": "image/jpeg", ".gif": "image/gif"}

# Preset → (title_key, description_key). FAQ meta jen u custom (RankMath/Yoast řeší FAQ bloky jinak).
SEO_PRESETS = {
    "rankmath": {"title": "rank_math_title", "description": "rank_math_description", "faqs": None},
    "yoast": {"title": "_yoast_wpseo_title", "description": "_yoast_wpseo_metadesc", "faqs": None},
    "none": {"title": None, "description": None, "faqs": None},
}


def load_config(path: str | None) -> dict:
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        sys.exit(f"Chyba: client config '{path}' neexistuje")
    # Načti .env klienta vedle configu (přepíše jen prázdné, ne existující env).
    load_dotenv(p.parent / ".env")
    return json.loads(p.read_text(encoding="utf-8"))


def seo_keys(config: dict, preset_override: str | None) -> dict:
    publish = config.get("publish", {})
    preset = preset_override or publish.get("seo_meta_preset", "none")
    if preset == "custom":
        ck = publish.get("custom_meta_keys", {})
        return {"title": ck.get("title") or None, "description": ck.get("description") or None,
                "faqs": ck.get("faqs") or None}
    return SEO_PRESETS.get(preset, SEO_PRESETS["none"])


def resolve_base_url(config: dict) -> str:
    base = os.environ.get("WP_URL") or config.get("site", {}).get("primary_url", "")
    if not base:
        sys.exit("Chyba: chybí WP_URL (.env klienta) ani site.primary_url (config).")
    return base.rstrip("/")


def make_client(base_url: str) -> httpx.Client:
    user = os.environ.get("WP_USER", "")
    pw = os.environ.get("WP_APP_PASSWORD", "")  # POZOR: mezery zachovat!
    if not user or not pw:
        sys.exit("Chyba: chybí WP_USER nebo WP_APP_PASSWORD v .env klienta.")
    return httpx.Client(base_url=f"{base_url}/wp-json/wp/v2", auth=httpx.BasicAuth(user, pw),
                        timeout=60.0, headers={"User-Agent": "content-pipeline-publisher/1.0"})


def load_article(target: str) -> tuple[Path, str, dict]:
    d = Path(target)
    if not d.is_dir():
        sys.exit(f"Chyba: '{target}' není adresář hotového článku.")
    article, meta_path = d / "article.md", d / "meta.json"
    if not article.exists() or not meta_path.exists():
        sys.exit(f"Chyba: v {d} chybí article.md nebo meta.json.")
    return d, article.read_text(encoding="utf-8"), json.loads(meta_path.read_text(encoding="utf-8"))


def alt_for(path: str, meta: dict) -> str:
    name = Path(path).name
    for img in meta.get("images", []):
        if Path(img.get("file", "")).name == name:
            return img.get("alt", "")
    return ""


def upload_image(client: httpx.Client, file: Path, alt: str) -> dict[str, Any]:
    ctype = CONTENT_TYPES.get(file.suffix.lower(), "application/octet-stream")
    resp = client.post("/media", content=file.read_bytes(),
                       headers={"Content-Type": ctype,
                                "Content-Disposition": f'attachment; filename="{file.name}"'})
    resp.raise_for_status()
    media = resp.json()
    if alt:
        client.post(f"/media/{media['id']}", json={"alt_text": alt, "title": alt[:60]})
    return media


def upload_all_images(client, draft_dir, md, meta) -> tuple[dict[str, str], int | None]:
    srcs = {src for _, src in IMG_RE.findall(md) if not src.startswith(("http://", "https://"))}
    featured_rel = meta.get("featured_image")
    if featured_rel:
        srcs.add(featured_rel)
    url_map, featured_id = {}, None
    for src in sorted(srcs):
        file = (draft_dir / src).resolve()
        if not file.exists():
            sys.exit(f"Chyba: obrázek '{src}' neexistuje na disku ({file}).")
        media = upload_image(client, file, alt_for(src, meta))
        url_map[src] = media["source_url"]
        print(f"  ↑ {src} → {media['source_url']} (media #{media['id']})")
        if featured_rel and src == featured_rel:
            featured_id = media["id"]
    return url_map, featured_id


LEAD_SUMMARY_RE = re.compile(
    r"\A\s*<p><strong>(?P<title>[^<]+)</strong></p>\s*(?P<list><[uo]l>.*?</[uo]l>)", re.DOTALL)


def wrap_lead_summary(html: str, css_class: str) -> str:
    if not css_class:
        return html

    def _repl(m: re.Match) -> str:
        return (f'<div class="{css_class}">'
                f'<p class="{css_class}__title">{m.group("title")}</p>'
                f'{m.group("list")}</div>')
    return LEAD_SUMMARY_RE.sub(_repl, html, count=1)


def render_html(md: str, meta: dict, url_map: dict[str, str], *, strip_featured: bool,
                summary_class: str, schema_mode: str) -> str:
    body = H1_RE.sub("", md, count=1).lstrip("\n")
    featured_rel = meta.get("featured_image")
    if strip_featured and featured_rel:
        body = re.sub(rf"!\[[^\]]*\]\({re.escape(featured_rel)}\)\s*\n?", "", body)
    for src, url in url_map.items():
        body = body.replace(f"]({src})", f"]({url})")
    html = md_lib.markdown(body, extensions=["extra", "sane_lists"])
    html = wrap_lead_summary(html, summary_class)
    if schema_mode == "all":
        for key in ("article", "faqpage", "breadcrumb"):
            node = meta.get("schema", {}).get(key)
            if node:
                html += f'\n<script type="application/ld+json">{json.dumps(node, ensure_ascii=False)}</script>'
    return html


def build_faq_meta(meta: dict) -> list[dict]:
    faqs = []
    for item in meta.get("schema", {}).get("faqpage", {}).get("mainEntity", []):
        q = item.get("name", "").strip()
        a = item.get("acceptedAnswer", {}).get("text", "").strip()
        if q and a:
            faqs.append({"q": q, "a": a})
    return faqs


def resolve_category(client, name, create=False) -> int | None:
    if not name:
        return None
    resp = client.get("/categories", params={"search": name, "per_page": 100})
    resp.raise_for_status()
    for cat in resp.json():
        if cat.get("name", "").strip().lower() == name.strip().lower():
            return cat["id"]
    if create:
        r = client.post("/categories", json={"name": name})
        if r.status_code >= 400:
            print(f"  ⚠ Kategorii '{name}' nelze vytvořit: {r.status_code}")
            return None
        return r.json()["id"]
    return None


def build_payload(meta, html, status, category_id, featured_id, keys: dict) -> dict:
    payload = {
        "title": meta.get("h1") or meta.get("title", ""),
        "slug": meta.get("slug", ""),
        "content": html,
        "excerpt": meta.get("description", ""),
        "status": status,
    }
    if category_id:
        payload["categories"] = [category_id]
    if featured_id:
        payload["featured_media"] = featured_id
    post_meta = {}
    if keys.get("title") and meta.get("title"):
        post_meta[keys["title"]] = meta["title"]
    if keys.get("description") and meta.get("description"):
        post_meta[keys["description"]] = meta["description"]
    if keys.get("faqs"):
        faqs = build_faq_meta(meta)
        if faqs:
            post_meta[keys["faqs"]] = faqs
    if post_meta:
        payload["meta"] = post_meta
    return payload


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description="Publikace článku na WordPress (default draft, theme-agnostic)")
    ap.add_argument("target", help="Adresář hotového článku (article.md + meta.json + images/)")
    ap.add_argument("--config", required=True, help="Cesta ke client.config.json")
    ap.add_argument("--seo-preset", choices=["rankmath", "yoast", "custom", "none"], default=None,
                    help="Override publish.seo_meta_preset z configu")
    ap.add_argument("--status", choices=["draft", "pending", "publish"], default="draft")
    ap.add_argument("--allow-publish", action="store_true", help="Nutné se --status publish")
    ap.add_argument("--update", type=int, metavar="POST_ID")
    ap.add_argument("--schema", choices=["none", "all"], default="none",
                    help="Vkládání JSON-LD do OBSAHU. Default none (řeší SEO plugin/theme). 'all' = escape-hatch.")
    ap.add_argument("--create-category", action="store_true")
    ap.add_argument("--keep-featured-inline", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.status == "publish" and not args.allow_publish:
        sys.exit("ODMÍTNUTO: status 'publish' vyžaduje --allow-publish. Default workflow je draft → člověk klikne Publish.")

    config = load_config(args.config)
    draft_dir, md, meta = load_article(args.target)
    base_url = resolve_base_url(config)
    keys = seo_keys(config, args.seo_preset)
    summary_class = config.get("publish", {}).get("summary_box_class", "")
    category = meta.get("category") or config.get("publish", {}).get("default_category", "")

    print(f"Cíl: {base_url} | status={args.status} | SEO meta: {keys}")
    print(f"Slug: {meta.get('slug')} | Titulek: {meta.get('h1') or meta.get('title')}")

    if args.dry_run:
        srcs = {s for _, s in IMG_RE.findall(md) if not s.startswith("http")}
        if meta.get("featured_image"):
            srcs.add(meta["featured_image"])
        placeholder = {s: f"{base_url}/wp-content/uploads/{Path(s).name}" for s in srcs}
        html = render_html(md, meta, placeholder, strip_featured=not args.keep_featured_inline,
                           summary_class=summary_class, schema_mode=args.schema)
        out = draft_dir / "rendered.html"
        out.write_text(html, encoding="utf-8")
        print(f"\n[DRY-RUN] Žádný zápis na server.")
        print(f"  Obrázky k uploadu ({len(srcs)}): {', '.join(sorted(Path(s).name for s in srcs))}")
        print(f"  Kategorie: {category or '— (žádná)'}")
        print(f"  Summary box class: {summary_class or '— (vyp)'}")
        print(f"  HTML délka: {len(html)} znaků → {out}")
        return

    client = make_client(base_url)
    with client:
        print("\nNahrávám obrázky…")
        url_map, featured_id = upload_all_images(client, draft_dir, md, meta)
        html = render_html(md, meta, url_map, strip_featured=not args.keep_featured_inline,
                           summary_class=summary_class, schema_mode=args.schema)
        category_id = resolve_category(client, category, create=args.create_category)
        if category and category_id is None:
            print(f"  ⚠ Kategorie '{category}' nenalezena — post bez kategorie (nebo přidej --create-category).")
        payload = build_payload(meta, html, args.status, category_id, featured_id, keys)
        resp = client.post(f"/posts/{args.update}" if args.update else "/posts", json=payload)
        if resp.status_code >= 400:
            sys.exit(f"WP REST chyba {resp.status_code}: {resp.text[:500]}")
        post = resp.json()

    print(f"\n✓ Hotovo. Post #{post['id']} — status '{post['status']}'")
    print(f"  Náhled: {post.get('link')}")
    print(f"  Editace: {base_url}/wp-admin/post.php?post={post['id']}&action=edit")
    if post["status"] != "publish":
        print("  → Publikaci dokonči ručně v adminu (Publish).")


if __name__ == "__main__":
    main()
