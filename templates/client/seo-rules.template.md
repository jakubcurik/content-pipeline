# SEO rules — {{CLIENT_NAME}}

> Pravidla, která musí každý článek splňovat. Strojově validuje `checklist_validate.py` proti `checklist.yaml`. Většina pravidel je univerzální (AEO/GEO 2026) — uprav jen klientské části označené {{...}}.

## 1. Title & meta description

- **Title:** 50–60 znaků včetně mezer. Target keyword v první polovině.
- **Meta description:** 140–160 znaků. Aktivní sloveso, končí výzvou k akci.
- Title nesmí kopírovat H1 — H1 je delší a popisnější, title kratší a „klikatelný".

## 2. URL slug

- Kebab-case, jen ASCII, bez stop-slov. Target keyword v slug. Max 60 znaků.

## 3. Struktura nadpisů (Capsule method)

> **Klíčové pro AI search engines** (Google AI Overviews, ChatGPT Search, Perplexity).

- H1 = popisný název článku, obsahuje target keyword.
- **H2/H3 jako otázky** (≥ 80 % nadpisů).
- **První věta odstavce přímo odpovídá na otázku v nadpisu** — bez úvodu, jasná odpověď.
- Definice klíčového pojmu do 40 slov od H1.

## 4. Délka

- Cíl = max(1500 slov, průměr top-5 SERP × 1.1).
- Žádné výplňové odstavce. Sekce bez konkrétní informace = zruš.

## 5. Interlinking

- Min. **5 interních odkazů** na ostatní obsah webu.
- Žádný H2 „orphan" — z každé sekce min. 1 odkaz.
- Anchor text = přirozená věta, nikdy „klikněte zde".

## 6. Externí odkazy

- 3–5 odkazů na **autoritativní zdroje** relevantní pro obor klienta. Komerční s `rel="nofollow noopener"`.
- {{Vyplň seznam autorit pro tohoto klienta — regulátor, ministerstvo, oborové autority. Viz external_links_authorities v client.config.json.}}

## 7. Obrázky

- Min. **3 unikátní obrázky** (ne stock).
- ALT 80–125 znaků, popisuje obsah, target keyword pokud relevantní.
- Featured image 16:9 (min. 1200×675). Lazy loading default.

## 8. Schema.org / structured data

Každý článek:
- **Article** schema (datum publikace, **`dateModified`**, headline, image). `dateModified` drž aktuální — freshness je reálný citační faktor.
- **BreadcrumbList** (Home → Blog → Kategorie → Článek).

Volitelně:
- **FAQPage** (z H2/H3 otázek). Pozn.: FAQ rich result je od 5/2026 deprecován — generuj jako strukturu, ne kvůli SERP featuře.
- **HowTo** pro návody, **NewsArticle** pro aktuality.

> {{Pozn. k publikaci: jak se schema dostane na web, závisí na publish.target a seo_meta_preset v client.config.json. U WordPressu s Yoast/Rank Math schema řeší plugin; nevkládej JSON-LD `<script>` do těla článku (kses ho smaže).}}

## 9. CTA

Min. **1 explicitní CTA** vedoucí na klíčovou akci/stránku klienta:
- {{Definuj hlavní CTA — kam vede a jakým anchorem.}}

## 10. AI search optimalizace (AEO/GEO)

- **Definice na začátku** (~40 slov): co je téma, pro koho, co se čtenář dozví. ~44 % citací ChatGPT je z první třetiny textu — odpověz hned.
- **Query fan-out:** Google i LLM rozkládají dotaz na sub-otázky a hodnotí relevanci na úrovni pasáže. Pokrý víc sub-otázek (každá = vlastní H2/H3).
- **Srovnávací tabulky:** kde článek srovnává, použij HTML tabulku — LLM ji extrahují spolehlivěji než prózu.
- **Strukturované odpovědi:** seznamy, číslované kroky, tabulky.
- **TL;DR** 3–5 odrážek na začátku.
- **Žádný keyword stuffing.** Hustota target keywordu pod ~2,5 % (stuffing v GEO studii −8,7 % viditelnosti). Optimalizuj na entity, ne frekvenci.
- **Freshness:** `dateModified` aktuální + viditelné datum aktualizace. AI enginy citují obsah ~25 % čerstvější.
- Žádný fluff / AI slop bez přidané hodnoty.

## 11. Brand voice

Viz `brand-voice.md`. Brand-voice guard musí projít před checkpointem 3.

## 12. E-E-A-T

> Pokud je téma YMYL (zdraví, peníze, bezpečnost, právo), jsou E-E-A-T signály pro citovatelnost i ranking zásadní.

- **Experience:** {{Čím klient dokládá přímou zkušenost? Vlastní data? Case studies? Pokud má unikátní data, zapni own_data_citation v client.config.json.}}
- **Authoritativeness:** odkazy na primární autority (Cite Sources je v GEO studii silný signál, +28 %).
- **Trust:** tvrzení podložená zdrojem, definitivní tón (ne hedging), HTTPS, dohledatelný provozovatel.
- **Autorská identita:** {{Řešíš jmenovaného autora + Person schema, nebo ne? Default šablony: neřeší.}}
