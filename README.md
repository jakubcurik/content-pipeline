# content-pipeline

Autonomní pipeline pro tvorbu SEO/AEO článků pro **jakýkoli web a jakéhokoli klienta**, jako plugin pro Claude Code. Research → osnova → draft → publikace, se 3 human checkpointy.

> Status: **Fáze 0 — kostra.** Plugin zatím není funkční, staví se po fázích (viz blueprint).

## Co to umí (cílový stav)

- `/client new <jméno>` — založí profil klienta (brand voice, SEO pravidla, ICP, napojení na web)
- `/blog-post "<téma>"` — kompletní pipeline tvorby článku s 3 checkpointy
- `/audit-site <url>` — CMS-agnostický audit webu (sitemap + fetch + parse), výstup pro interlinking
- `/content-pipeline:setup` — průvodce nastavením API klíčů

## Tři vrstvy konfigurace

| Vrstva | Co | Kde | Frekvence |
|---|---|---|---|
| Agenturní nástroje | DataForSEO, Google OAuth (GSC+GA4), Gemini | `/plugin → Configure` | 1× / počítač |
| Připojení klienta | WordPress, doména, jazyk, lokace | `clients/<x>/.env` | 1× / klient |
| DNA klienta | brand voice, SEO, ICP, vizuál | `clients/<x>/*.md` | 1× / klient |

## Napojení na externí služby

Plugin **nekopíruje cizí kód** — jen veze spouštěcí recepty. Klíče si dodá každý uživatel jednou do Configure.

| Služba | Typ | Auth | Povinné? |
|---|---|---|---|
| DataForSEO | MCP (`npx dataforseo-mcp-server`) | login + heslo | doporučeno |
| Google Search Console | MCP (vendored) | **1 sdílený Google OAuth** | volitelné |
| Google Analytics 4 | MCP (vendored, stejný OAuth) | tentýž OAuth | volitelné |
| Gemini (obrázky) | Python skript | API klíč | volitelné |

Bez kteréhokoli z nich pipeline jede dál v omezeném režimu (graceful degradation).

## Instalace (cílově)

```
/plugin marketplace add <animato-marketplace>
/plugin install content-pipeline@animato
/content-pipeline:setup          # vyplň DataForSEO + Google + Gemini
/client new muj-klient           # nastav brand voice a web
/blog-post "téma článku"
```

## Licence

UNLICENSED — interní nástroj Animato.
