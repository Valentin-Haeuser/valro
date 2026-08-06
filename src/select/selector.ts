import type { History, ScoredStudy, Study, Topic } from '../types.js';
import { CONFIG } from '../config.js';
import { isSeen, normalizeDoi, seenKeys } from './history.js';

export interface Selection {
  lead: ScoredStudy;
  shorts: ScoredStudy[];
}

/**
 * Entfernt Dubletten über Quellen hinweg. Dieselbe Arbeit kommt regelmäßig
 * über Europe PMC, PubMed und Crossref gleichzeitig herein; wir behalten
 * jeweils den Datensatz mit dem längsten Abstract, weil der Writer davon lebt.
 */
export function dedupe(studies: Study[]): Study[] {
  const best = new Map<string, Study>();
  for (const s of studies) {
    const key = s.doi ? normalizeDoi(s.doi) : s.id.toLowerCase();
    const existing = best.get(key);
    if (!existing || s.abstract.length > existing.abstract.length) best.set(key, s);
  }
  return [...best.values()];
}

/**
 * Wählt Hauptfakt und zwei Nachschläge.
 *
 * Der Hauptfakt muss die strengere Schwelle reißen: Er bekommt in der Mail
 * den vollen Aufbau samt Mechanismus, und genau dieser Fakt wird
 * weitererzählt. Bei den Kurzfakten reicht die normale Schwelle.
 *
 * Gibt `null` zurück, wenn nicht genug Material übrig ist — dann sendet die
 * Pipeline lieber nichts, als etwas Schwaches zu verschicken.
 */
export function select(
  scored: ScoredStudy[],
  history: History,
  topic: Topic,
): Selection | null {
  const seen = seenKeys(history);

  const eligible = scored
    .filter((s) => !s.score.rejected)
    .filter((s) => !isSeen(s.study, seen))
    .filter((s) => s.score.total >= CONFIG.minCredibility)
    .sort((a, b) => b.score.total - a.score.total);

  const lead = eligible.find((s) => s.score.total >= CONFIG.minCredibilityLead);
  if (!lead) return null;

  // Nachschläge sollen nicht dieselbe Studie und möglichst nicht dieselbe
  // Kernaussage wie der Hauptfakt bringen.
  const shorts = eligible
    .filter((s) => s.study.id !== lead.study.id)
    .filter((s) => !tooSimilar(s.study.title, lead.study.title))
    .slice(0, 2);

  if (shorts.length === 0) return null;
  return { lead, shorts };
}

/** Grobe Titelähnlichkeit über gemeinsame Inhaltswörter — reicht für den Zweck. */
function tooSimilar(a: string, b: string): boolean {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-zäöüß0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 4),
    );
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) > 0.6;
}
