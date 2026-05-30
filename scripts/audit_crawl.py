# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx>=0.28", "beautifulsoup4>=4.12"]
# ///
"""CMS-agnostický audit webu — robots.txt + sitemap + fetch stránek + parse HTML.

Funguje na JAKÉMKOLI webu / CMS (WordPress, Webflow, Ghost, statika…). Žádné SSH,
žádné WP-CLI. Vytáhne seznam URL ze sitemapy, stáhne každou stránku přes HTTP,
naparsuje SEO signály a vyrobí site-inventory.json + lidsky čitelný audit report.

Co kontroluje:
  - AI-bot crawlability z robots.txt (Googlebot, OAI-SearchBot, PerplexityBot, ClaudeBot)
  - per-URL: title, meta description, H1, H2/H3, word count, interní/externí odkazy,
    JSON-LD schema typy, canonical, hreflang, počet obrázků + ALT pokrytí
  - thin content, chybějící/duplicitní title (kanibalizace), chybějící H1/meta/schema
  - orphan stránky (nikam na ně nevede interní odkaz)

Použití:
    uv run audit_crawl.py https://example.com --out clients/<slug>/data/site-inventory.json --report clients/<slug>/audit/baseline.md
    uv run audit_crawl.py https://example.com --limit 100 --include /blog/
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import warnings

import httpx
from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning

# Sitemapy jsou XML, parsujeme je stdlib html.parserem (bez lxml závislosti) — warning je neškodný.
warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

UA = "content-pipeline-audit/1.0 (+https://github.com/jakubcurik/content-pipeline)"
AI_BOTS = ["Googlebot", "OAI-SearchBot", "PerplexityBot", "ClaudeBot", "GPTBot", "Google-Extended"]
THIN_WORDS = 600


def fetch(client: httpx.Client, url: str) -> httpx.Response | None:
    try:
        r = client.get(url, follow_redirects=True, timeout=20.0)
        return r
    except httpx.HTTPError as exc:
        sys.stderr.write(f"  ! fetch failed {url}: {exc}\n")
        return None


# ---------------------------------------------------------------------------
# robots.txt + AI bot crawlability
# ---------------------------------------------------------------------------

def parse_robots(text: str) -> dict:
    """Vrátí per-user-agent disallow pravidla + nalezené sitemapy."""
    agents: dict[str, list[str]] = {}
    sitemaps: list[str] = []
    current: list[str] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        key, _, val = line.partition(":")
        key, val = key.strip().lower(), val.strip()
        if key == "user-agent":
            current = agents.setdefault(val, [])
        elif key == "disallow" and current is not None:
            current.append(val)
        elif key == "sitemap":
            sitemaps.append(val)
    return {"agents": agents, "sitemaps": sitemaps}


def ai_crawlability(robots: dict) -> dict:
    """Pro každého AI bota: je blokovaný? (Disallow / na úrovni jeho UA nebo *.)"""
    agents = robots.get("agents", {})
    result = {}
    for bot in AI_BOTS:
        rules = None
        for ua, disallows in agents.items():
            if ua.lower() == bot.lower():
                rules = disallows
                break
        if rules is None:
            rules = agents.get("*", [])
        blocked_root = "/" in rules
        result[bot] = {"blocked_site": blocked_root, "disallow_rules": rules}
    return result


# ---------------------------------------------------------------------------
# sitemap (rekurzivně, podporuje sitemap index)
# ---------------------------------------------------------------------------

def collect_sitemap_urls(client: httpx.Client, sitemap_url: str, seen: set[str], depth: int = 0) -> list[str]:
    if depth > 5 or sitemap_url in seen:
        return []
    seen.add(sitemap_url)
    r = fetch(client, sitemap_url)
    if not r or r.status_code >= 400:
        return []
    soup = BeautifulSoup(r.text, "html.parser")
    # sitemap index → <sitemap><loc>
    nested = [s.get_text(strip=True) for s in soup.select("sitemap > loc")]
    if nested:
        urls: list[str] = []
        for n in nested:
            urls.extend(collect_sitemap_urls(client, n, seen, depth + 1))
        return urls
    return [u.get_text(strip=True) for u in soup.select("url > loc")]


# ---------------------------------------------------------------------------
# parse jedné stránky
# ---------------------------------------------------------------------------

def analyze_page(client: httpx.Client, url: str, host: str) -> dict | None:
    r = fetch(client, url)
    if not r or r.status_code >= 400 or "text/html" not in r.headers.get("content-type", ""):
        return None
    soup = BeautifulSoup(r.text, "html.parser")

    title = (soup.title.get_text(strip=True) if soup.title else "")
    meta_desc = ""
    md = soup.find("meta", attrs={"name": "description"})
    if md and md.get("content"):
        meta_desc = md["content"].strip()
    h1s = [h.get_text(strip=True) for h in soup.find_all("h1")]
    h2s = [h.get_text(strip=True) for h in soup.find_all(["h2", "h3"])]

    # main text word count (odstraň nav/script/style/footer/header)
    for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
        tag.decompose()
    main = soup.find("main") or soup.find("article") or soup.body or soup
    text = main.get_text(" ", strip=True) if main else ""
    word_count = len([w for w in re.split(r"\s+", text) if any(c.isalnum() for c in w)])

    internal, external = 0, 0
    targets: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.startswith(("mailto:", "tel:", "#", "javascript:")):
            continue
        absu = urljoin(url, href)
        netloc = urlparse(absu).netloc.lower()
        if not netloc or netloc == host:
            internal += 1
            targets.add(absu.split("#")[0].rstrip("/"))
        else:
            external += 1

    schema_types: list[str] = []
    for s in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            data = json.loads(s.string or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        for node in (data if isinstance(data, list) else [data]):
            if isinstance(node, dict):
                t = node.get("@type")
                if isinstance(t, list):
                    schema_types.extend(t)
                elif t:
                    schema_types.append(t)

    imgs = soup.find_all("img")
    with_alt = sum(1 for i in imgs if i.get("alt", "").strip())
    canonical = ""
    cl = soup.find("link", attrs={"rel": "canonical"})
    if cl and cl.get("href"):
        canonical = cl["href"].strip()
    hreflang = [l.get("hreflang") for l in soup.find_all("link", attrs={"rel": "alternate"}) if l.get("hreflang")]

    return {
        "url": url,
        "status": r.status_code,
        "title": title,
        "title_len": len(title),
        "meta_description": meta_desc,
        "meta_desc_len": len(meta_desc),
        "h1": h1s[0] if h1s else "",
        "h1_count": len(h1s),
        "h2s": h2s,
        "word_count": word_count,
        "internal_links": internal,
        "external_links": external,
        "_link_targets": sorted(targets),
        "schema_types": sorted(set(schema_types)),
        "image_count": len(imgs),
        "alt_coverage": round(with_alt / len(imgs), 2) if imgs else None,
        "canonical": canonical,
        "hreflang": hreflang,
    }


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------

def build_report(site: str, ai: dict, pages: list[dict], orphans: list[str]) -> str:
    n = len(pages)
    avg_words = round(sum(p["word_count"] for p in pages) / n) if n else 0
    with_schema = sum(1 for p in pages if p["schema_types"])
    thin = [p for p in pages if p["word_count"] < THIN_WORDS]
    no_title = [p for p in pages if not p["title"]]
    no_meta = [p for p in pages if not p["meta_description"]]
    no_h1 = [p for p in pages if p["h1_count"] == 0]
    multi_h1 = [p for p in pages if p["h1_count"] > 1]

    title_counts = Counter(p["title"].lower() for p in pages if p["title"])
    dup_titles = [t for t, c in title_counts.items() if c > 1]

    blocked = [b for b, v in ai.items() if v["blocked_site"]]
    lines = [
        f"# Audit webu — {site}",
        f"_Vygenerováno: {datetime.now(timezone.utc).isoformat(timespec='seconds')}_",
        "",
        "## Souhrn",
        f"- Stránek analyzováno: **{n}**",
        f"- Průměrná délka: **{avg_words} slov**",
        f"- Se schema.org: **{with_schema}/{n}**",
        f"- Thin content (< {THIN_WORDS} slov): **{len(thin)}**",
        "",
        "## AI-bot crawlability",
    ]
    if blocked:
        lines.append(f"- 🔴 **Blokované AI boti (Disallow /): {', '.join(blocked)}**")
    else:
        lines.append("- 🟢 Žádný klíčový AI bot není blokovaný na úrovni celého webu.")
    for bot, v in ai.items():
        mark = "🔴" if v["blocked_site"] else "🟢"
        lines.append(f"  - {mark} {bot}{' — Disallow /' if v['blocked_site'] else ''}")
    lines += [
        "",
        "## Nálezy (priorita shora)",
    ]
    if no_title:
        lines.append(f"- 🔴 Chybí `<title>`: {len(no_title)} stránek")
    if no_h1:
        lines.append(f"- 🔴 Chybí H1: {len(no_h1)} stránek")
    if multi_h1:
        lines.append(f"- 🟡 Více než jeden H1: {len(multi_h1)} stránek")
    if no_meta:
        lines.append(f"- 🟡 Chybí meta description: {len(no_meta)} stránek")
    if dup_titles:
        lines.append(f"- 🟡 Duplicitní title (kanibalizace): {len(dup_titles)} skupin")
        for t in dup_titles[:10]:
            lines.append(f"    - „{t[:70]}…"" ({title_counts[t]}×)")
    if (n - with_schema) > 0:
        lines.append(f"- 🟡 Bez schema.org: {n - with_schema} stránek")
    if orphans:
        lines.append(f"- 🟡 Orphan stránky (nikam nevede interní odkaz): {len(orphans)}")
        for u in orphans[:15]:
            lines.append(f"    - {u}")
    if thin:
        lines.append(f"- 🔵 Thin content k rozšíření: {len(thin)}")
        for p in sorted(thin, key=lambda x: x["word_count"])[:15]:
            lines.append(f"    - {p['url']} ({p['word_count']} slov)")
    lines += [
        "",
        "## Quick wins",
        "Top kandidáti na refresh = thin content + chybějící schema + 0 interních odkazů dovnitř.",
        "Kompletní data v `site-inventory.json`.",
    ]
    return "\n".join(lines)


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description="CMS-agnostický audit webu (sitemap + fetch + parse)")
    ap.add_argument("site", help="Base URL webu (https://example.com)")
    ap.add_argument("--out", default="data/site-inventory.json", help="Výstupní JSON")
    ap.add_argument("--report", default="audit/baseline.md", help="Výstupní markdown report")
    ap.add_argument("--limit", type=int, default=300, help="Max počet URL k analýze")
    ap.add_argument("--include", default="", help="Analyzuj jen URL obsahující tento substring (např. /blog/)")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    site = args.site.rstrip("/")
    host = urlparse(site).netloc.lower()
    client = httpx.Client(headers={"User-Agent": UA})

    print(f"1/4 robots.txt …")
    rr = fetch(client, f"{site}/robots.txt")
    robots = parse_robots(rr.text) if rr and rr.status_code < 400 else {"agents": {}, "sitemaps": []}
    ai = ai_crawlability(robots)

    print(f"2/4 sitemap …")
    sitemaps = robots.get("sitemaps") or [f"{site}/sitemap.xml"]
    seen: set[str] = set()
    urls: list[str] = []
    for sm in sitemaps:
        urls.extend(collect_sitemap_urls(client, sm, seen))
    urls = list(dict.fromkeys(urls))  # dedup, zachovej pořadí
    if args.include:
        urls = [u for u in urls if args.include in u]
    if not urls:
        print("  ⚠ Sitemap nenalezena / prázdná — analyzuju aspoň homepage.")
        urls = [site]
    urls = urls[: args.limit]
    print(f"  → {len(urls)} URL k analýze")

    print(f"3/4 fetch + parse ({args.workers} workers) …")
    pages: list[dict] = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(analyze_page, client, u, host): u for u in urls}
        for i, fut in enumerate(as_completed(futures), 1):
            res = fut.result()
            if res:
                pages.append(res)
            if i % 25 == 0:
                print(f"  … {i}/{len(urls)}")
    client.close()

    # Orphan detekce: stránka, na kterou nevede žádný interní odkaz z jiné stránky.
    all_targets: set[str] = set()
    for p in pages:
        all_targets.update(p["_link_targets"])
    orphans = [p["url"] for p in pages if p["url"].rstrip("/") not in all_targets and p["url"].rstrip("/") != site]

    pages_clean = [{k: v for k, v in p.items() if k != "_link_targets"} for p in pages]
    inventory = {
        "site": site,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ai_crawlability": ai,
        "sitemaps": sitemaps,
        "page_count": len(pages_clean),
        "posts": pages_clean,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding="utf-8")

    report = build_report(site, ai, pages, orphans)
    rep_path = Path(args.report)
    rep_path.parent.mkdir(parents=True, exist_ok=True)
    rep_path.write_text(report, encoding="utf-8")

    print(f"4/4 hotovo.")
    print(f"  Inventory: {out_path} ({len(pages_clean)} stránek)")
    print(f"  Report:    {rep_path}")
    blocked = [b for b, v in ai.items() if v['blocked_site']]
    if blocked:
        print(f"  🔴 Blokovaní AI boti: {', '.join(blocked)}")


if __name__ == "__main__":
    main()
