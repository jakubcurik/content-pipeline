---
description: CMS-agnostický audit webu — sitemap + fetch stránek + parse HTML. Inventář, AI-bot crawlability, thin content, kanibalizace, orphany, chybějící schema. Funguje na jakémkoli CMS. Bez checkpointů.
argument-hint: "[url] (jinak vezme web aktivního klienta)"
---

# /audit-site — audit webu

Argument: **$ARGUMENTS**

Tvoje role: provést kompletní audit webu a vyrobit `data/site-inventory.json` (vstup pro interlinking v `/blog-post`) + lidsky čitelný report. **Žádné checkpointy** — celý audit běží naráz a vrátíš finální shrnutí.

## Krok 0: Zjisti cílový web

- Pokud je v argumentu URL, použij ji.
- Jinak načti aktivního klienta z `.content-pipeline.json` → `clients/<slug>/client.config.json` → `site.primary_url`.
- Když ani jedno, zeptej se uživatele na URL.

## Krok 1: Spusť crawler

Skript je v pluginu (PEP 723, `uv run` si doinstaluje závislosti):

```bash
uv run "${CLAUDE_PLUGIN_ROOT}/scripts/audit_crawl.py" <URL> \
    --out data/site-inventory.json \
    --report audit/{YYYY-MM-DD}-baseline.md \
    --limit 300
```

Pro velký web zúž scope `--include /blog/`. Ohlas, kolik URL sitemap vrátila.

Crawler sám naparsuje: title, meta, H1, H2/H3, word count, interní/externí odkazy, JSON-LD schema, canonical, hreflang, ALT pokrytí, AI-bot crawlability z robots.txt, thin content, duplicitní title (kanibalizace), orphany.

## Krok 2: (volitelně) obohať o GSC/DataForSEO

Pokud je připojený Google (`google-gsc` server) a web je v Search Console:
- Pro top URL vytáhni clicks/impressions/CTR/position za 90 dní (`gsc_query_search_analytics`).
- Spáruj s URL v inventory → **decay watchlist** (klesající pozice) a **quick wins** (vysoké impressions, nízké CTR).

Pokud je DataForSEO a chceš hlubší pohled, `dataforseo_labs_google_relevant_pages` na doménu → na co která URL rankuje.

## Krok 3: Shrnutí v chatu (≤ 250 slov)

- Počet stránek, průměrná délka, schema pokrytí.
- **🔴 AI-bot crawlability** — blokuje robots.txt některého z Googlebot / OAI-SearchBot / PerplexityBot / ClaudeBot? (blokace = neviditelnost v daném AI vyhledávači). Pozor: `GPTBot` (training) ≠ `OAI-SearchBot` (search) — hlídej hlavně search boty.
- Top 5–10 quick wins (thin content + chybějící schema + orphany).
- Kanibalizace (duplicitní/podobné title).
- Odkaz na plný report.

## Output

- `data/site-inventory.json` — machine-readable, vstup pro `/blog-post` interlinking.
- `audit/{YYYY-MM-DD}-baseline.md` — lidský report.
- Stručné shrnutí v chatu.

## Pravidla

- **Nic nezapisuje na web ani do žádné DB** — jen čte přes HTTP a generuje lokální reporty.
- Žádné SSH ani WP-CLI — audit je čistě HTTP, funguje na libovolném CMS.
- Respektuj velikost webu — u velkých webů použij `--limit` / `--include`, ať fetch netrvá věčnost, a ohlas, co jsi vynechal.
