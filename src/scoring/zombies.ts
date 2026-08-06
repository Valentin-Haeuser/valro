/**
 * Zombie-Filter: bekannt widerlegte bzw. nicht replizierte Befunde.
 *
 * Warum das existiert: Schlaf, Produktivität, Psychologie, Ernährung und
 * Verhaltensökonomie sind genau die Felder, in denen die Replikationskrise
 * am härtesten zugeschlagen hat. Ein Fakt, den am Tisch jemand als "das ist
 * doch längst widerlegt" enttarnt, ist schlimmer als gar kein Fakt.
 *
 * Designentscheidungen:
 *  - Die Muster werden EINMAL beim Modul-Laden kompiliert (`new RegExp` ist
 *    teuer genug, dass man es nicht pro Studie machen will — die Pipeline
 *    bewertet pro Lauf hunderte Arbeiten gegen dutzende Zombies).
 *  - Kein `g`-Flag: globale Regexes tragen `lastIndex` mit sich herum und
 *    liefern bei wiederholtem `.test()` abwechselnd true/false. Nur `i`.
 *  - Geprüft wird gegen Titel + Abstract, NICHT gegen Autorennamen —
 *    sonst würde jede Arbeit einer Autorin namens Wakefield aussortiert.
 */

import { readFileSync } from 'node:fs';
import type { Study, ZombieClaim } from '../types';

/** Ort der Datenbasis, relativ zu dieser Datei (src/scoring → repo-root/data). */
const DATA_URL = new URL('../../data/zombies.json', import.meta.url);

interface CompiledZombie {
  claim: ZombieClaim;
  regexes: RegExp[];
}

function loadClaims(): ZombieClaim[] {
  const raw = readFileSync(DATA_URL, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('zombies.json: erwartet wurde ein Array von ZombieClaim-Objekten');
  }
  return parsed.map((entry, i) => {
    const claim = entry as Partial<ZombieClaim>;
    if (
      typeof claim.slug !== 'string' ||
      typeof claim.label !== 'string' ||
      typeof claim.why !== 'string' ||
      !Array.isArray(claim.patterns) ||
      claim.patterns.length === 0
    ) {
      throw new Error(`zombies.json: Eintrag #${i} ist unvollständig (slug/label/why/patterns)`);
    }
    return { slug: claim.slug, label: claim.label, why: claim.why, patterns: claim.patterns };
  });
}

function compile(claims: readonly ZombieClaim[]): CompiledZombie[] {
  const seen = new Set<string>();
  return claims.map((claim) => {
    if (seen.has(claim.slug)) {
      throw new Error(`zombies.json: doppelter slug "${claim.slug}"`);
    }
    seen.add(claim.slug);
    const regexes = claim.patterns.map((source) => {
      try {
        return new RegExp(source, 'i');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`zombies.json: ungültiges Pattern in "${claim.slug}": ${source} — ${msg}`);
      }
    });
    return { claim, regexes };
  });
}

/** Alle geladenen Einträge — nützlich für Tests, Logs und die Mail-Fußzeile. */
export const ZOMBIE_CLAIMS: readonly ZombieClaim[] = Object.freeze(loadClaims());

const COMPILED: readonly CompiledZombie[] = Object.freeze(compile(ZOMBIE_CLAIMS));

/** Was durchsucht wird: Titel und Abstract, sonst nichts. */
function haystackOf(study: Study): string {
  return `${study.title ?? ''}\n${study.abstract ?? ''}`;
}

/**
 * Liefert den ersten passenden Zombie-Eintrag oder `null`.
 *
 * Die Muster sind bewusst mehrwortig bzw. mit Wortgrenzen gebaut: ein Muster
 * wie `power` oder `sleep` würde massenhaft legitime Arbeiten wegwerfen, und
 * ein zu scharfer Filter ist genauso schädlich wie gar keiner.
 */
export function findZombieMatch(study: Study): ZombieClaim | null {
  const haystack = haystackOf(study);
  if (haystack.trim().length === 0) return null;
  for (const { claim, regexes } of COMPILED) {
    for (const re of regexes) {
      if (re.test(haystack)) return claim;
    }
  }
  return null;
}

/**
 * Wie `findZombieMatch`, gibt aber zusätzlich zurück, welches Muster gefeuert
 * hat. Für die Fehlersuche, wenn ein Muster zu aggressiv geraten ist.
 */
export function explainZombieMatch(
  study: Study,
): { claim: ZombieClaim; pattern: string } | null {
  const haystack = haystackOf(study);
  if (haystack.trim().length === 0) return null;
  for (const { claim, regexes } of COMPILED) {
    for (let i = 0; i < regexes.length; i++) {
      const re = regexes[i];
      if (re && re.test(haystack)) {
        return { claim, pattern: claim.patterns[i] ?? re.source };
      }
    }
  }
  return null;
}
