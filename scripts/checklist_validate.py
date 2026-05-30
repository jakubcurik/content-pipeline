# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml>=6.0", "rich>=13.0"]
# ///
"""Strojová validace draftu článku podle checklist.yaml aktivního klienta.

Spouští se před Checkpointem 3 v `/blog-post` pipeline. Spočítá deterministické
metriky přímo z `article.md` + `meta.json`, ověří je proti pravidlům v checklistu
a vrátí report. `severity: error` blokuje publikaci (nenulový exit), `warn` flagne.

Klientská konfigurace:
- `--config <client.config.json>` dodá interní domény (links.is_internal) a feature
  flagy (pravidla s `requires_feature` se přeskočí, když feature není zapnutá).
- `--checklist <path>` cesta ke konkrétnímu checklist.yaml klienta.

AI-judge pravidla (`type: ai_judge`) vrací `review` — posoudí je orchestrátor (Claude).
Pro `own_data_citation_present` a `cta_present` běží lehká heuristika, jinak review.

Použití:
    uv run checklist_validate.py <draft_dir|article.md> --config clients/<x>/client.config.json --checklist clients/<x>/checklist.yaml
    uv run checklist_validate.py <dir> --serp-avg-words 1850
    uv run checklist_validate.py <dir> --json
    uv run checklist_validate.py <dir> --strict

Exit kódy: 0 = žádný error · 1 = ≥1 error (nebo warn při --strict) · 2 = chyba vstupu.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from rich.console import Console
from rich.table import Table

PASS, FAIL, REVIEW, SKIP = "pass", "fail", "review", "skip"


# ---------------------------------------------------------------------------
# Načtení vstupů
# ---------------------------------------------------------------------------

def resolve_inputs(target: str) -> tuple[Path, Path]:
    p = Path(target)
    if p.is_dir():
        article, meta = p / "article.md", p / "meta.json"
    elif p.is_file() and p.name.endswith(".md"):
        article, meta = p, p.parent / "meta.json"
    else:
        sys.exit(f"Chyba: '{target}' není adresář draftu ani article.md")
    if not article.exists():
        sys.exit(f"Chyba: chybí {article}")
    if not meta.exists():
        sys.exit(f"Chyba: chybí {meta}")
    return article, meta


def load_client_config(path: str | None) -> dict:
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        sys.exit(f"Chyba: client config '{path}' neexistuje")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit(f"Chyba: nevalidní client.config.json — {exc}")


# ---------------------------------------------------------------------------
# Parsing markdownu
# ---------------------------------------------------------------------------

IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
LINK_RE = re.compile(r"(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
H2_RE = re.compile(r"^##\s+(?!#)(.+?)\s*$", re.MULTILINE)

SUMMARY_LABEL_RE = re.compile(
    r"^(?:\*\*\s*)?(?:TL;DR|Ve zkratce|Shrnutí|Co je důležité|Rychlý přehled|In short|Summary)(?:\s*\*\*)?\s*:?\s*$",
    re.IGNORECASE,
)

_DEF_VERBS = r"(je|jsou|znamená|označuje|nazýváme|rozumíme|je to|představuje|is|are|means|refers to)"


@dataclass
class Section:
    heading: str
    body: str


def strip_tldr(md: str) -> str:
    lines = md.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if SUMMARY_LABEL_RE.match(line.strip()) or \
           re.match(r"^#{2,6}\s+(TL;DR|Ve zkratce|Shrnutí|Summary)", line.strip(), re.IGNORECASE):
            i += 1
            while i < len(lines) and (not lines[i].strip() or lines[i].lstrip().startswith(("-", "*", "+"))):
                i += 1
            continue
        out.append(line)
        i += 1
    return "\n".join(out)


def split_sections(md: str) -> list[Section]:
    sections: list[Section] = []
    matches = list(H2_RE.finditer(md))
    for idx, m in enumerate(matches):
        start = m.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(md)
        sections.append(Section(heading=m.group(1).strip(), body=md[start:end]))
    return sections


def make_is_internal(domains: list[str]):
    """Interní = relativní odkaz nebo odkaz na některou z domén klienta."""
    dom = [d.strip().lower() for d in domains if d.strip()]

    def is_internal(href: str) -> bool:
        href = href.strip().lower()
        if href.startswith(("http://", "https://")):
            return any(d in href for d in dom)
        if href.startswith(("mailto:", "tel:", "#")):
            return False
        return True  # relativní

    return is_internal


def count_words(md: str) -> int:
    text = IMG_RE.sub("", md)
    text = LINK_RE.sub(r"\1", text)
    text = re.sub(r"[#>*_`\-|]", " ", text)
    return len([w for w in text.split() if any(c.isalnum() for c in w)])


def build_context(article: Path, meta: dict, serp_avg_words: float | None, config: dict) -> dict[str, Any]:
    md = article.read_text(encoding="utf-8")
    domains = config.get("site", {}).get("domains", [])
    is_internal = make_is_internal(domains)

    title = meta.get("title", "")
    description = meta.get("description", "")
    slug = meta.get("slug", "")

    h2s = [m.strip() for m in H2_RE.findall(md)]
    h2_q = sum(1 for h in h2s if h.rstrip().endswith("?"))
    h2_ratio = (h2_q / len(h2s)) if h2s else 0.0

    images = IMG_RE.findall(md)
    img_alts = [alt.strip() for alt, _ in images]
    if not img_alts and meta.get("images"):
        img_alts = [img.get("alt", "") for img in meta["images"]]
        image_count = len(meta["images"])
    else:
        image_count = len(images)

    links = LINK_RE.findall(md)
    internal = [h for _, h in links if is_internal(h)]

    return {
        "_md": md,
        "content": md,
        "_domains": domains,
        "_features": config.get("features", {}),
        "_heuristics": config.get("checklist_heuristics", {}),
        "meta": {
            "title_chars": len(title),
            "description_chars": len(description),
            "slug": slug,
            "target_keyword": meta.get("target_keyword", ""),
        },
        "structure": {"h2_question_ratio": round(h2_ratio, 4), "h2_count": len(h2s)},
        "links": {"internal_count": len(internal)},
        "media": {"image_count": image_count, "alts": img_alts},
        "content_word_count": count_words(md),
        "serp": {"avg_words": serp_avg_words},
        "_meta_raw": meta,
        "_sections": split_sections(md),
    }


def dotted(ctx: dict, path: str) -> Any:
    cur: Any = ctx
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur


@dataclass
class Result:
    rule_id: str
    severity: str
    status: str
    message: str
    detail: str = ""


# ---------------------------------------------------------------------------
# Heuristiky pro ai_judge pravidla (jazykově neutrální + konfigurovatelné)
# ---------------------------------------------------------------------------

_NUMBER_RE = re.compile(r"\b\d{1,3}(?:[  ]\d{3})+\b|\b\d{2,}\b")


def judge_own_data(ctx: dict) -> Result:
    """Vlastní data: ≥1 citace unikátní statistiky klienta. Jazykově neutrální heuristika:
    hledá číslo poblíž self-reference patternu (z client.config.json → checklist_heuristics.
    self_reference_patterns). Bez patternů → review (posoudí orchestrátor)."""
    md = ctx["_md"]
    patterns = ctx["_heuristics"].get("self_reference_patterns", [])
    has_number = bool(_NUMBER_RE.search(md))
    if patterns:
        ctx_re = re.compile("|".join(patterns), re.IGNORECASE)
        for sent in re.split(r"(?<=[.!?])\s+", md):
            if ctx_re.search(sent) and _NUMBER_RE.search(sent):
                return Result("", "", PASS, "Citace vlastních dat nalezena (číslo + self-reference ve větě).")
        return Result("", "", REVIEW, "Self-reference i čísla přítomny, ale ne ve stejné větě — ověř ručně.")
    if has_number:
        return Result("", "", REVIEW,
                      "Feature own_data_citation zapnutá, ale nejsou nastavené self_reference_patterns — posuď ručně.")
    return Result("", "", FAIL, "Žádná konkrétní statistika (číslo) v textu — chybí citace vlastních dat.")


def judge_cta(ctx: dict) -> Result:
    """CTA: ≥1 odkaz na vlastní doménu klienta (klíčová akce/stránka). Bez domén → review."""
    md = ctx["_md"]
    domains = [d.strip().lower() for d in ctx["_domains"] if d.strip()]
    if not domains:
        return Result("", "", REVIEW, "Nejsou nastavené domény klienta — CTA posuď ručně.")
    for _, href in LINK_RE.findall(md):
        h = href.strip().lower()
        if any(d in h for d in domains):
            return Result("", "", PASS, "CTA nalezeno (odkaz na doménu klienta).")
    return Result("", "", REVIEW, "Nenalezen odkaz na doménu klienta — ověř, že je v textu jasné CTA.")


AI_JUDGE_HEURISTICS = {
    "own_data_citation_present": judge_own_data,
    "cta_present": judge_cta,
}


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

def run_rule(rule: dict, ctx: dict) -> Result:
    rid = rule["id"]
    sev = rule.get("severity", "warn")
    check = rule.get("check", {})
    ctype = check.get("type")
    desc = rule.get("description", "")

    # Feature gating
    feat = rule.get("requires_feature")
    if feat and not ctx["_features"].get(feat):
        return Result(rid, sev, SKIP, f"{desc}: přeskočeno (feature '{feat}' není zapnutá).")

    try:
        dispatch = {
            "range": _check_range, "regex": _check_regex, "regex_absent": _check_regex_absent,
            "ratio": _check_ratio, "dynamic_threshold": _check_dynamic_threshold,
            "word_window": _check_definition, "schema_present": _check_schema,
            "foreach_range": _check_foreach_range, "structural": _check_structural,
            "density": _check_density, "keyword_density": _check_keyword_density,
            "ai_judge": _check_ai_judge,
        }
        fn = dispatch.get(ctype)
        if not fn:
            return Result(rid, sev, SKIP, f"Neznámý typ checku: {ctype}")
        return fn(rid, sev, check, ctx, desc)
    except Exception as exc:  # noqa: BLE001
        return Result(rid, sev, FAIL, f"Chyba při vyhodnocení: {exc}")


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _check_range(rid, sev, check, ctx, desc) -> Result:
    val = _num(dotted(ctx, check["field"]))
    lo, hi = check.get("min"), check.get("max")
    if val is None:
        return Result(rid, sev, FAIL, f"{desc}: hodnota '{check['field']}' chybí.")
    if lo is not None and val < lo:
        return Result(rid, sev, FAIL, f"{desc}: {val:g} < {lo}.")
    if hi is not None and val > hi:
        return Result(rid, sev, FAIL, f"{desc}: {val:g} > {hi}.")
    return Result(rid, sev, PASS, f"{desc}: {val:g} OK.")


def _check_regex(rid, sev, check, ctx, desc) -> Result:
    val = dotted(ctx, check["field"]) or ""
    if re.match(check["pattern"], str(val)):
        return Result(rid, sev, PASS, f"{desc}: '{val}' OK.")
    return Result(rid, sev, FAIL, f"{desc}: '{val}' neodpovídá {check['pattern']}.")


def _check_regex_absent(rid, sev, check, ctx, desc) -> Result:
    content = ctx["content"].lower()
    hits = [p for p in check["patterns"] if re.search(p, content, re.IGNORECASE)]
    if hits:
        return Result(rid, sev, FAIL, f"{desc}: nalezeno {len(hits)} zakázaných frází.", detail="; ".join(hits))
    return Result(rid, sev, PASS, f"{desc}: žádné zakázané fráze.")


def _check_ratio(rid, sev, check, ctx, desc) -> Result:
    val = _num(dotted(ctx, check["field"]))
    lo = check.get("min", 0)
    if val is None:
        return Result(rid, sev, FAIL, f"{desc}: hodnota chybí.")
    if val >= lo:
        return Result(rid, sev, PASS, f"{desc}: {val:.0%} OK.")
    return Result(rid, sev, FAIL, f"{desc}: {val:.0%} < {lo:.0%}.")


def _check_dynamic_threshold(rid, sev, check, ctx, desc) -> Result:
    words = ctx["content_word_count"]
    abs_min = check.get("absolute_min", 0)
    src = _num(dotted(ctx, check["source"]))
    mult = check.get("multiplier", 1.0)
    threshold, basis = abs_min, f"absolutní minimum {abs_min}"
    if src is not None:
        dyn = src * mult
        threshold = max(abs_min, dyn)
        basis = f"max({abs_min}, SERP avg {src:g}×{mult}={dyn:.0f})"
    if words >= threshold:
        return Result(rid, sev, PASS, f"{desc}: {words} slov ≥ {threshold:.0f} ({basis}).")
    return Result(rid, sev, FAIL, f"{desc}: {words} slov < {threshold:.0f} ({basis}).")


def _check_definition(rid, sev, check, ctx, desc) -> Result:
    max_words = check.get("max_words", 40)
    kw = ctx["meta"]["target_keyword"].strip()
    body = strip_tldr(ctx["_md"])
    body = H1_RE.sub("", body, count=1)
    body = IMG_RE.sub("", body)
    body = LINK_RE.sub(r"\1", body)
    words = [w for w in re.split(r"\s+", body.strip()) if w]
    window = " ".join(words[: max_words + 8])
    stem = re.escape(kw.split()[0]) if kw else r"\w+"
    pat = re.compile(rf"\b{stem}\w*\b.{{0,80}}?\b{_DEF_VERBS}\b", re.IGNORECASE | re.DOTALL)
    if pat.search(window):
        return Result(rid, sev, PASS, f"{desc}: definice '{kw}' nalezena v úvodu.")
    return Result(rid, sev, FAIL, f"{desc}: v prvních ~{max_words} slovech není definiční věta pro '{kw}'.")


def _check_schema(rid, sev, check, ctx, desc) -> Result:
    schema = ctx["_meta_raw"].get("schema", {})
    type_name = check["type_name"]
    key_map = {"Article": "article", "FAQPage": "faqpage", "BreadcrumbList": "breadcrumb"}
    node = schema.get(key_map.get(type_name, type_name.lower()))
    if not node:
        return Result(rid, sev, FAIL, f"{desc}: schema {type_name} chybí.")
    if node.get("@type") != type_name:
        return Result(rid, sev, FAIL, f"{desc}: @type je '{node.get('@type')}', čeká se '{type_name}'.")
    min_items = check.get("min_items")
    if min_items is not None:
        items = node.get("mainEntity") or node.get("itemListElement") or []
        if len(items) < min_items:
            return Result(rid, sev, FAIL, f"{desc}: jen {len(items)} položek < {min_items}.")
        return Result(rid, sev, PASS, f"{desc}: {len(items)} položek OK.")
    return Result(rid, sev, PASS, f"{desc}: OK.")


def _check_foreach_range(rid, sev, check, ctx, desc) -> Result:
    items = dotted(ctx, check["field"]) or []
    lo, hi = check.get("min"), check.get("max")
    bad: list[str] = []
    for it in items:
        n = len(str(it))
        if (lo is not None and n < lo) or (hi is not None and n > hi):
            bad.append(f"{n}: „{str(it)[:40]}…")
    if not items:
        return Result(rid, sev, FAIL, f"{desc}: žádné položky k ověření.")
    if bad:
        return Result(rid, sev, FAIL, f"{desc}: {len(bad)}/{len(items)} mimo rozsah {lo}–{hi}.", detail=" | ".join(bad))
    return Result(rid, sev, PASS, f"{desc}: všech {len(items)} v rozsahu {lo}–{hi}.")


def _check_density(rid, sev, check, ctx, desc) -> Result:
    pattern = check["pattern"]
    per = check.get("max_per_words", 400)
    words = ctx["content_word_count"] or 1
    hits = len(re.findall(pattern, ctx["content"]))
    allowed = max(1, round(words / per))
    if hits <= allowed:
        return Result(rid, sev, PASS, f"{desc}: {hits}× na {words} slov (limit {allowed}).")
    return Result(rid, sev, FAIL, f"{desc}: {hits}× na {words} slov > limit {allowed}.")


def _check_keyword_density(rid, sev, check, ctx, desc) -> Result:
    """Hustota target keywordu pod max_ratio (anti-stuffing)."""
    kw = (dotted(ctx, check["field"]) or "").strip()
    max_ratio = check.get("max_ratio", 0.025)
    words = ctx["content_word_count"] or 1
    if not kw:
        return Result(rid, sev, SKIP, f"{desc}: target_keyword není v meta.json.")
    hits = len(re.findall(re.escape(kw), ctx["content"], re.IGNORECASE))
    ratio = hits / words
    if ratio <= max_ratio:
        return Result(rid, sev, PASS, f"{desc}: {ratio:.1%} ≤ {max_ratio:.1%} ({hits}× / {words} slov).")
    return Result(rid, sev, FAIL, f"{desc}: {ratio:.1%} > {max_ratio:.1%} ({hits}× / {words} slov) — stuffing.")


def _check_structural(rid, sev, check, ctx, desc) -> Result:
    if check.get("rule") == "no_orphan_h2":
        orphans = [s.heading for s in ctx["_sections"] if not LINK_RE.search(s.body)]
        if orphans:
            return Result(rid, sev, FAIL, f"{desc}: {len(orphans)} H2 bez odkazu.", detail="; ".join(orphans))
        return Result(rid, sev, PASS, f"{desc}: každý H2 má odkaz.")
    return Result(rid, sev, SKIP, f"Neznámé structural pravidlo: {check.get('rule')}")


def _check_ai_judge(rid, sev, check, ctx, desc) -> Result:
    heuristic = AI_JUDGE_HEURISTICS.get(check.get("prompt", ""))
    if heuristic:
        res = heuristic(ctx)
        res.rule_id, res.severity = rid, sev
        if not res.message.startswith(desc):
            res.message = f"{desc}: {res.message}"
        return res
    return Result(rid, sev, REVIEW, f"{desc}: vyžaduje AI-judge posouzení orchestrátorem (prompt '{check.get('prompt')}').")


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

ICON = {PASS: "[green]✓[/]", FAIL: "[red]✗[/]", REVIEW: "[yellow]?[/]", SKIP: "[dim]–[/]"}


def print_report(results: list[Result], console: Console) -> None:
    table = Table(title="Checklist validation", show_lines=False, header_style="bold")
    table.add_column("", justify="center", width=3)
    table.add_column("Rule", style="cyan", no_wrap=True)
    table.add_column("Sev", width=6)
    table.add_column("Zpráva")
    for r in results:
        sev_style = "red" if r.severity == "error" else "yellow"
        msg = r.message + (f"\n[dim]{r.detail}[/]" if r.detail else "")
        table.add_row(ICON[r.status], r.rule_id, f"[{sev_style}]{r.severity}[/]", msg)
    console.print(table)


def summarize(results: list[Result]) -> dict[str, int]:
    return {
        "error": sum(1 for r in results if r.severity == "error" and r.status == FAIL),
        "warn": sum(1 for r in results if r.severity == "warn" and r.status == FAIL),
        "review": sum(1 for r in results if r.status == REVIEW),
        "pass": sum(1 for r in results if r.status == PASS),
        "skip": sum(1 for r in results if r.status == SKIP),
        "total": len(results),
    }


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description="Validace draftu článku podle checklist.yaml")
    ap.add_argument("target", help="Adresář draftu nebo cesta k article.md")
    ap.add_argument("--config", help="Cesta ke client.config.json (domény + feature flagy)")
    ap.add_argument("--checklist", required=True, help="Cesta k checklist.yaml klienta")
    ap.add_argument("--serp-avg-words", type=float, default=None)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--strict", action="store_true", help="Warn fail blokuje stejně jako error")
    args = ap.parse_args()

    article, meta_path = resolve_inputs(args.target)
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        sys.exit(f"Chyba: nevalidní meta.json — {exc}")
    try:
        checklist = yaml.safe_load(Path(args.checklist).read_text(encoding="utf-8"))
    except (yaml.YAMLError, OSError) as exc:
        sys.exit(f"Chyba: nevalidní checklist — {exc}")

    config = load_client_config(args.config)
    ctx = build_context(article, meta, args.serp_avg_words, config)
    results = [run_rule(rule, ctx) for rule in checklist.get("rules", [])]
    summary = summarize(results)

    console = Console(legacy_windows=False)
    if args.json:
        print(json.dumps({"target": str(article), "summary": summary,
                          "results": [vars(r) for r in results]}, ensure_ascii=False, indent=2))
    else:
        print_report(results, console)
        console.print(
            f"\n[bold]Souhrn:[/] [green]{summary['pass']} pass[/] · [red]{summary['error']} error[/] · "
            f"[yellow]{summary['warn']} warn[/] · [yellow]{summary['review']} review[/] · [dim]{summary['skip']} skip[/]"
        )
        if summary["review"]:
            console.print("[dim]review = posoudí orchestrátor (brand voice, věcná odpověď, CTA, vlastní data).[/]")

    blocking = summary["error"] + (summary["warn"] if args.strict else 0)
    sys.exit(1 if blocking else 0)


if __name__ == "__main__":
    main()
