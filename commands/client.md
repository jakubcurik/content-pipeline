---
description: Správa klientských profilů — založ (new), přepni (switch) nebo vypiš (list) klienty. Každý klient = vlastní brand voice, SEO pravidla a napojení na web.
argument-hint: "new <slug> | switch <slug> | list"
---

# /client — správa klientských profilů

Argument: **$ARGUMENTS**

Klientské profily žijí v **projektu uživatele** (ne v pluginu), v adresáři `clients/<slug>/`. Aktivní klient je uložený v `.content-pipeline.json` v kořeni projektu. Všechny ostatní příkazy (`/blog-post`, `/audit-site`) pracují s aktivním klientem.

Šablony jsou v `${CLAUDE_PLUGIN_ROOT}/templates/client/`.

---

## Rozhodni podle prvního slova argumentu:

### `new <slug>` — založ nového klienta

1. **Validuj slug:** kebab-case, ASCII, bez mezer (např. `acme-eshop`). Když uživatel zadal jméno s diakritikou/mezerami, navrhni slug a potvrď.
2. **Zkontroluj kolizi:** pokud `clients/<slug>/` už existuje, zastav se a zeptej, jestli přepsat.
3. **Zkopíruj šablony** z `${CLAUDE_PLUGIN_ROOT}/templates/client/` do `clients/<slug>/` a přejmenuj:
   - `brand-voice.template.md` → `brand-voice.md`
   - `seo-rules.template.md` → `seo-rules.md`
   - `checklist.template.yaml` → `checklist.yaml`
   - `icp.template.md` → `icp.md`
   - `visual-style.template.md` → `visual-style.md`
   - `client.config.json` → `client.config.json`
   - `.env.example` → `.env.example`
   Použij Bash (`cp`) nebo Read+Write. Vytvoř i prázdnou strukturu per-klient artefaktů (každý klient má vlastní articles/ i data/, nesdílí se):
   ```
   clients/<slug>/references/
   clients/<slug>/data/{keyword-cache,serp-snapshots,db-insights}/
   clients/<slug>/articles/{01-briefs,02-drafts,03-ready,04-published}/
   clients/<slug>/audit/
   ```
   (např. `mkdir -p clients/<slug>/{references,data/keyword-cache,data/serp-snapshots,data/db-insights,articles/01-briefs,articles/02-drafts,articles/03-ready,articles/04-published,audit}`)
4. **Nahraď `{{CLIENT_NAME}}`** ve zkopírovaných .md souborech jménem klienta a v `client.config.json` nastav `name` na slug.
5. **Nastav aktivního klienta** — zapiš/aktualizuj `.content-pipeline.json` v kořeni projektu:
   ```json
   { "active_client": "<slug>" }
   ```
6. **Interaktivní onboarding** — proveď uživatele vyplněním základu přes AskUserQuestion nebo dotazy:
   - doména(y) webu + sitemap URL → zapiš do `client.config.json` (`site`)
   - jazyk + lokace (pro DataForSEO) → `locale` (např. cs / Czech / Czechia)
   - publikační cíl: `wordpress` nebo `markdown` → `publish.target`
   - když `wordpress`: SEO meta preset (`rankmath` / `yoast` / `custom` / `none`) a ať vyplní `clients/<slug>/.env` (zkopíruj z `.env.example`)
   - má klient vlastní unikátní data k citaci? → `features.own_data_citation`
7. **Připomeň** uživateli, ať doplní `brand-voice.md`, `icp.md` a `visual-style.md` (to je ruční práce — nabídni pomoc s draftem na základě webu klienta).
8. Shrň, co vzniklo, a jak spustit `/blog-post`.

### `switch <slug>` — přepni aktivního klienta

1. Ověř, že `clients/<slug>/` existuje. Když ne, vypiš dostupné klienty a zeptej se.
2. Aktualizuj `active_client` v `.content-pipeline.json`.
3. Potvrď: „Aktivní klient: <slug>" + stručně doména a jazyk z jeho `client.config.json`.

### `list` — vypiš klienty

1. Vyjmenuj adresáře v `clients/`.
2. U každého ukaž: slug, doménu (z `client.config.json`), jazyk, publish target. Aktivního označ.
3. Když `clients/` neexistuje nebo je prázdný, navrhni `/client new <slug>`.

### (žádný/neznámý argument)

Vypiš krátkou nápovědu se třemi režimy a aktuálně aktivního klienta.

---

## Pravidla

- **Nikdy nezapisuj do `templates/`** v pluginu — to jsou jen vzory (read-only).
- **`.env` klienta necommituj** — připomeň, že obsahuje hesla a je gitignored.
- Klientská data jsou v projektu uživatele, ne v pluginu — plugin zůstává čistý a sdílitelný.
