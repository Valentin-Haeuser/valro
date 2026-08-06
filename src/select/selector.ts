import type { History, ScoredStudy, Study, Topic } from '../types.js';
import { CONFIG, thresholdsFor } from '../config.js';
import { isSeen, keywordsOf, normalizeDoi, seenKeys } from './history.js';
import { everydayRelevance, matchesTopic } from '../scoring/relevance.js';

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
  today = new Date(),
): Selection | null {
  const seen = seenKeys(history);
  const recentTopics = recentKeywordSets(history, today);
  const limits = thresholdsFor(topic);

  const eligible = scored
    .filter((s) => !s.score.rejected)
    .filter((s) => !isSeen(s.study, seen))
    .filter((s) => s.score.total >= limits.pool)
    .filter((s) => !repeatsRecentSubject(s.study, recentTopics))
    // Die Suchanfragen müssen breit sein, um genug Material zu finden — dabei
    // rutscht regelmäßig Fachfremdes durch. Ein Diabetesmedikament ist kein
    // Psychologiefakt, auch wenn die Trefferliste es hergibt.
    .filter((s) => matchesTopic(s.study, topic))
    .map((s) => ({ ...s, relevance: everydayRelevance(s.study) }))
    .filter((s) => s.relevance.score >= limits.relevance)
    // Rang aus beiden Achsen: Ein makelloser Befund über eine seltene
    // Erkrankung nützt nichts, eine alltagsnahe Behauptung ohne Beleg
    // erst recht nicht.
    .sort((a, b) => rank(b) - rank(a));

  const lead = eligible.find(
    (s) => s.score.total >= limits.lead && s.relevance.score >= limits.relevanceLead,
  );
  if (!lead) return null;

  // Nachschläge sollen nicht dieselbe Studie und möglichst nicht dieselbe
  // Kernaussage wie der Hauptfakt bringen.
  const shorts = eligible
    .filter((s) => s.study.id !== lead.study.id)
    .filter((s) => !tooSimilar(s.study.title, lead.study.title))
    .slice(0, 2);

  if (shorts.length === 0) return null;
  return {
    lead: { study: lead.study, score: lead.score },
    shorts: shorts.map((s) => ({ study: s.study, score: s.score })),
  };
}

function rank(s: ScoredStudy & { relevance: { score: number } }): number {
  return (s.score.total / 100) * 0.55 + s.relevance.score * 0.45;
}

/**
 * Die Stichwörter aller Ausgaben innerhalb der Sperrfrist.
 *
 * Ältere Einträge bleiben in der History (dieselbe Studie kommt nie wieder),
 * sperren aber ihr Thema nicht auf ewig — sonst wären nach einem Jahr die
 * ergiebigsten Gebiete alle verbrannt.
 */
function recentKeywordSets(history: History, today: Date): Set<string>[] {
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - CONFIG.subjectCooldownDays);

  return history.entries
    .filter((e) => new Date(e.date) >= cutoff)
    .map((e) => new Set(e.keywords ?? keywordsOf(e.title)));
}

/**
 * Schlägt an, wenn der Gegenstand der Studie dem einer kürzlich verschickten
 * zu ähnlich ist — z. B. die dritte Prokrastinations-Metaanalyse in vier
 * Wochen. Der Schwellenwert ist bewusst hoch: lieber ein Thema zu viel
 * durchlassen als ein gutes Feld dauerhaft sperren.
 */
function repeatsRecentSubject(study: Study, recent: Set<string>[]): boolean {
  const words = new Set(keywordsOf(study.title));
  if (words.size === 0) return false;

  return recent.some((prev) => {
    if (prev.size === 0) return false;
    let shared = 0;
    for (const w of words) if (prev.has(w)) shared++;
    return shared / Math.min(words.size, prev.size) >= CONFIG.subjectOverlapLimit;
  });
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
