---
description: Kompletní pipeline tvorby nového článku pro aktivního klienta — research → osnova → draft → publikace. 3 human checkpointy.
argument-hint: <téma článku nebo seed keyword>
---

# /blog-post — nová tvorba

Téma: **$ARGUMENTS**

Tvoje role: orchestrátor pipeline. Postupuj přesně podle fází. **Žádnou fázi nepřeskakuj, žádný checkpoint nepřeskakuj.**

## Krok 0: Aktivní klient (přečti před startem)

1. Načti `.content-pipeline.json` z kořene projektu → `active_client`. Když chybí, vypiš dostupné klienty a navrhni `/client new` nebo `/client switch`.
2. Nastav `{CLIENT_DIR}` = `clients/<active_client>/`. Přečti:
   - `{CLIENT_DIR}/client.config.json` (doména, jazyk, lokace, publish target, features)
   - `{CLIENT_DIR}/brand-voice.md`, `{CLIENT_DIR}/seo-rules.md`, `{CLIENT_DIR}/icp.md`
   - `data/site-inventory.json` (pokud existuje — z `/audit-site`, pro interlinking)
3. Předávej `{CLIENT_DIR}` všem subagentům.

Skripty pluginu spouštěj přes `uv run "${CLAUDE_PLUGIN_ROOT}/scripts/<script>.py" …` (PEP 723 si doinstaluje závislosti).

---

## FÁZE 1: Data & výzkum

Deleguj `researcher` subagenta (předej téma + `{CLIENT_DIR}`). Provede keyword research, intent klasifikaci, SERP top 5 + features, content gap, vlastní pozice (pokud je GSC), případně vlastní data klienta (jen když `features.own_data_citation`).

Výstup: `data/keyword-cache/{slug}-{date}.json` + `data/serp-snapshots/{slug}-{date}.json` + research report.

⏸ **CHECKPOINT 1** → ukaž research report přes AskUserQuestion. Nabídni: pokračovat s navrženým target KW · vybrat jiný KW · upravit angle · zrušit.

---

## FÁZE 2: Osnova (brief)

Deleguj `outline-architect` subagenta (předej `{CLIENT_DIR}` + research data). Capsule-style osnova: target+supporting KW, H1+meta, H2/H3 jako otázky, angle/USP, interní odkazy (min. 5 z inventory), externí odkazy, návrhy obrázků, CTA, schema strategie.

Výstup: `articles/01-briefs/{slug}.md`.

⏸ **CHECKPOINT 2** → ukaž osnovu. Možnosti: schválit · úpravy (které sekce přidat/ubrat) · zrušit.

---

## FÁZE 3: Draft

Až po schválené osnově. Deleguj 3 subagenty (writer + image-art-director mohou běžet paralelně, fact-checker po dopsání):

1. **writer** (`{CLIENT_DIR}`) — píše sekci po sekci dle brand-voice + seo-rules klienta.
2. **image-art-director** (`{CLIENT_DIR}`) — obrázky dle `{CLIENT_DIR}/visual-style.md` (jen když `features.generate_images` a je Gemini klíč).
3. **fact-checker** — ověří tvrzení, statistiky, odkazy.

Po dokončení:
4. Vygeneruj `meta.json` (title, description, slug, target_keyword, schema JSON-LD, alt texty, category, featured_image).
5. Spusť validaci:
   ```bash
   uv run "${CLAUDE_PLUGIN_ROOT}/scripts/checklist_validate.py" articles/02-drafts/{slug} \
       --config {CLIENT_DIR}/client.config.json \
       --checklist {CLIENT_DIR}/checklist.yaml \
       --serp-avg-words <avg z researche>
   ```
   Vyžaduje `error: 0`. `review` položky posuď sám (brand voice, CTA, vlastní data) a oprav přes writer loop, pokud je třeba.

Výstup: `articles/02-drafts/{slug}/article.md`, `meta.json`, `images/*`.

⏸ **CHECKPOINT 3** → ukaž draft + checklist report. Možnosti: schválit → `articles/03-ready/` + publikace · revize konkrétních sekcí (loop do writer) · zrušit.

---

## FÁZE 4: Publikace

Podle `client.config.json` → `publish.target`:

**`wordpress`:**
```bash
uv run "${CLAUDE_PLUGIN_ROOT}/scripts/publish_wp.py" articles/03-ready/{slug} \
    --config {CLIENT_DIR}/client.config.json --dry-run    # nejdřív náhled
uv run "${CLAUDE_PLUGIN_ROOT}/scripts/publish_wp.py" articles/03-ready/{slug} \
    --config {CLIENT_DIR}/client.config.json               # vytvoří DRAFT
```
**Nikdy `--allow-publish` bez explicitního příkazu uživatele.** Default = draft, člověk klikne Publish v adminu.

**`markdown`:**
```bash
uv run "${CLAUDE_PLUGIN_ROOT}/scripts/publish_markdown.py" articles/03-ready/{slug} \
    --config {CLIENT_DIR}/client.config.json
```
Vyrobí přenosný `export/` (HTML + meta + schema + obrázky).

Nakonec: přesun do `articles/04-published/{date}-{slug}/`, reportuj URL/cestu.

---

## Pravidla

- **Nikdy nepokračuj přes checkpoint bez explicitního schválení.**
- **Vždy ukazuj odhad nákladů** (DataForSEO volání, Gemini kredity) před placenou fází.
- Slug = kebab-case, ASCII, max 60 znaků.
- Pokud uživatel řekne „zruš", ukliď rozpracované soubory.
- Pokud něco selže (404/401/timeout/safety filter), zastav se a zeptej — neobcházej chybu retry-loopem.
