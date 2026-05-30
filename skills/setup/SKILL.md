---
description: Průvodce nastavením content-pipeline pluginu — provede získáním a vyplněním API klíčů pro DataForSEO (keyword research), Google OAuth (Search Console + Analytics, jeden credential pro obojí) a Gemini (generování obrázků). INVOKE AUTOMATICALLY když (a) SessionStart hook hlásí nenastavené služby, (b) uživatel se ptá na setup/konfiguraci/onboarding content-pipeline, (c) volání DataForSEO/GSC/GA4 nástroje selže na chybějící env proměnné, nebo (d) uživatel právě nainstaloval plugin a chce některou službu rozchodit.
---

# content-pipeline — nastavení

## Pro Claude: jak řídit setup (přečti první)

Veď setup **interaktivně a po krocích**. Nevypisuj všechno najednou — zjisti, kterou službu chce uživatel zapnout, a projdi jen ji. Mezi hlavními kroky čekej na potvrzení.

Plugin obsahuje **tři nezávislé integrace** — uživatel může zapnout libovolnou podmnožinu:

| Služba | Co přináší | Co potřebuje | Povinné? |
|---|---|---|---|
| **DataForSEO** | keyword research, SERP scrape, content gap | login + API heslo | doporučeno (jádro researche) |
| **Google (GSC + GA4)** | vlastní pozice, decay, organic traffic | **1 sdílený OAuth** (client id + secret + refresh token) | volitelné |
| **Gemini** | generování obrázků (Nano Banana Pro) | API klíč | volitelné |

Bez kterékoli z nich pipeline jede dál (graceful degradation). **Klíčová výhoda:** GSC i GA4 sdílí jeden Google OAuth — uživatel ho nastavuje jednou.

**Orchestrace:**
1. **Zjisti stav.** Pokud SessionStart hook vložil info o chybějících službách, navaž na to. Jinak se zeptej, kterou službu chce zapnout.
2. **DataForSEO** (Sekce A) — nejjednodušší, jen 2 pole.
3. **Google OAuth** (Sekce B) — Google Cloud projekt → Desktop OAuth client → vygenerovat refresh token helperem. Token pokryje GSC i GA4 zároveň.
4. **Gemini** (Sekce C) — jeden API klíč.
5. **Vlož do Configure** (Sekce D) → `/plugin` → content-pipeline → Configure options.
6. **Restart** Claude Code (`/exit` + `claude`) — MCP servery startují při bootu.
7. **Ověř** přes `/mcp` a sample dotaz.

**Nevolej žádný `dataforseo` / GSC / GA4 nástroj, dokud uživatel nepotvrdí konfiguraci a restart** — servery bez povinných env proměnných nenaběhnou.

Když uživatel spouští OAuth helper, použij Bash:
```bash
GOOGLE_CLIENT_ID="<...>" GOOGLE_CLIENT_SECRET="<...>" node "${CLAUDE_PLUGIN_ROOT}/bin/google-oauth.js"
```
Helper otevře prohlížeč, naslouchá na localhostu a vytiskne refresh token na stdout (mezi `SUCCESS` bannery). Scopes: `webmasters.readonly` (GSC) + `analytics.readonly` (GA4).

---

## Pro uživatele: průvodce

Plugin **content-pipeline** umí pracovat se třemi službami. Zprovozni jen ty, které chceš — zbytek nech prázdný, pipeline poběží v omezeném režimu.

### Co budeš potřebovat (prerekvizity)

- **Node.js ≥ 18** (pro DataForSEO MCP přes `npx` a Google OAuth helper)
- **uv** (https://docs.astral.sh/uv/) — pro Python skripty pipeline
- Účet u služby, kterou chceš zapnout

---

## Sekce A — DataForSEO

1. Přihlas se na <https://app.dataforseo.com>.
2. V **API Dashboard** najdeš svůj **login** (email) a **API password** (NE heslo do webu — samostatné API heslo, najdeš/vygeneruješ ho v nastavení účtu).
3. Tyto dvě hodnoty vložíš později v Sekci D do polí `dataforseo_username` a `dataforseo_password`.

> DataForSEO je placené (kredity). Pipeline před každým placeným voláním hlásí odhad nákladů.

---

## Sekce B — Google (Search Console + Analytics, jeden OAuth)

### B1. Google Cloud projekt
1. Otevři <https://console.cloud.google.com/projectcreate>.
2. **Project name**: `content-pipeline` (nebo cokoliv). **Create**.

### B2. Povol API
V projektu povol obě API:
- Google Search Console API — <https://console.cloud.google.com/apis/library/searchconsole.googleapis.com>
- Google Analytics Data API — <https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com>

U každého klikni **Enable**.

### B3. OAuth consent screen
1. <https://console.cloud.google.com/auth/branding>.
2. **User Type**: **Internal** (Google Workspace) nebo External.
3. **App name**: `content-pipeline`, support + developer email = tvůj email. **Save**.
4. Pokud External, přidej se v **Test users**.

### B4. OAuth Desktop Client
1. <https://console.cloud.google.com/auth/clients> → **Create Client**.
2. **Application type**: **Desktop app** (důležité — ne Web!).
3. **Name**: `content-pipeline CLI`. **Create**.
4. Zkopíruj **Client ID** a **Client Secret**.

### B5. Vygeneruj refresh token
V terminálu (nebo nech Claude spustit přes Bash):
```bash
GOOGLE_CLIENT_ID="<tvuj-client-id>" GOOGLE_CLIENT_SECRET="<tvuj-secret>" \
  node "$(claude plugin path content-pipeline@animato)/bin/google-oauth.js"
```
1. Otevře se prohlížeč s Google consent screenem.
2. Přihlas se účtem, který má přístup k Search Console i Analytics.
3. Odsouhlas scopes (`webmasters.readonly` + `analytics.readonly`).
4. CLI vytiskne **refresh token** — zkopíruj si ho.

Tento jeden token pokrývá **GSC i GA4 zároveň**.

---

## Sekce C — Gemini (obrázky)

1. Otevři <https://ai.google.dev> → **Get API key**.
2. Vytvoř API klíč (v existujícím nebo novém Google Cloud projektu).
3. Hodnotu vložíš do pole `gemini_api_key`.

> Nano Banana Pro stojí orientačně ~$0.04 / obrázek 2K. Jeden klíč slouží všem klientům.

---

## Sekce D — Vlož hodnoty do pluginu

1. V Claude Code otevři `/plugin`.
2. **content-pipeline** → **Configure options**.
3. Vyplň podle toho, co chceš používat:

| Pole | Kdy nastavit |
|---|---|
| `dataforseo_username` | DataForSEO |
| `dataforseo_password` | DataForSEO |
| `google_client_id` | GSC nebo GA4 |
| `google_client_secret` | GSC nebo GA4 |
| `google_refresh_token` | GSC nebo GA4 (token z B5) |
| `gemini_api_key` | generování obrázků |

Co nepotřebuješ, nech prázdné.

## Sekce E — Restart a ověření

```
/exit
claude
```

Po restartu:
- `/mcp` — měl bys vidět `dataforseo`, `google-gsc`, `google-ga4` jako *connected* (jen ty, které jsi nastavil).
- **GSC test:** *"Které weby vidím v Google Search Console?"*
- **GA4 test:** *"Vypiš GA4 účty, ke kterým mám přístup."*
- **DataForSEO test:** *"Jaký je search volume pro 'běžecké boty' v Česku?"*

---

## Časté problémy

- **`Authentication failed`** (Google) → refresh token odvolán nebo starý. Zopakuj B5.
- **`API not enabled` (403)** → povolená API nejsou ve stejném projektu jako OAuth client. Zkontroluj B2.
- **`Permission denied` (403)** → Google účet nemá roli v dané property. Požádej majitele o přístup.
- **OAuth client je Web místo Desktop** → smaž a vytvoř znovu jako **Desktop** (B4).
- **Browser se neotevřel** (B5) → CLI vypíše URL, otevři ho ručně.
- **DataForSEO 401** → použil jsi heslo do webu místo API password. Vygeneruj API password v dashboardu.
- **Server po vyplnění není connected** → restartoval jsi Claude Code? Servery startují při bootu.

## Co dál

Po nastavení:
```
/client new muj-klient     # založ profil klienta (brand voice, web, jazyk)
/blog-post "téma článku"   # spusť pipeline
/audit-site https://web.cz # audit existujícího webu
```
