#!/usr/bin/env node
/**
 * SessionStart hook pro content-pipeline.
 *
 * Spustí se na startu / resume / clear. Zkontroluje, které userConfig hodnoty
 * jsou nastavené, a pokud něco chybí, vloží do kontextu stručný přehled, co
 * je dostupné a co se kvůli chybějícím klíčům přeskočí (graceful degradation).
 *
 * Žádný klíč není striktně povinný — plugin jede i bez nich, jen v omezeném
 * režimu. Když je vše nastavené, hook mlčí (exit 0, žádný výstup).
 */

function hasValue(key) {
  // Claude Code vystavuje userConfig jako CLAUDE_PLUGIN_OPTION_<KEY>.
  // Case handling není zaručený — zkontroluj lower i upper variantu.
  const lower = process.env[`CLAUDE_PLUGIN_OPTION_${key}`];
  const upper = process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
  return Boolean((lower && lower.trim()) || (upper && upper.trim()));
}

const services = {
  dataforseo: {
    keys: ['dataforseo_username', 'dataforseo_password'],
    label: 'DataForSEO (keyword research, SERP, content gap)',
    degraded: 'research jede v omezeném režimu — keywords a SERP data zadáš ručně',
  },
  google: {
    keys: ['google_client_id', 'google_client_secret', 'google_refresh_token'],
    label: 'Google Search Console + Analytics (vlastní pozice, decay, traffic)',
    degraded: 'přeskočí se kroky "naše současné pozice / decay / traffic"',
  },
  gemini: {
    keys: ['gemini_api_key'],
    label: 'Gemini / Nano Banana Pro (generování obrázků)',
    degraded: 'přeskočí se generování obrázků — klient dodá vlastní',
  },
};

const ready = [];
const missing = [];

for (const svc of Object.values(services)) {
  const isReady = svc.keys.every(hasValue);
  if (isReady) {
    ready.push(svc.label);
  } else {
    missing.push(svc);
  }
}

if (missing.length === 0) {
  // Vše nastavené — mlč.
  process.exit(0);
}

const lines = [
  '# content-pipeline — stav konfigurace',
  '',
];

if (ready.length) {
  lines.push('**Připravené služby:**');
  ready.forEach((l) => lines.push(`- ✅ ${l}`));
  lines.push('');
}

lines.push('**Nenastavené (plugin pojede v omezeném režimu):**');
missing.forEach((svc) => {
  lines.push(`- ⚠️ ${svc.label} — ${svc.degraded}`);
});
lines.push('');
lines.push(
  'Tohle není chyba — pipeline funguje i bez nich. Pokud chce uživatel některou službu zapnout',
  'nebo se ptá na nastavení, vyvolej skill `/content-pipeline:setup` (provede ho krok za krokem).',
  'Hodnoty se vyplňují v `/plugin` → content-pipeline → Configure options a vyžadují restart.',
  '',
  'Nevolej DataForSEO / GSC / GA4 nástroje, dokud uživatel nepotvrdí, že je nastavil.',
);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  }),
);
process.exit(0);
