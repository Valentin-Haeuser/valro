import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Briefing, History, HistoryEntry, Study } from '../types.js';

const HISTORY_PATH = new URL('../../data/history.json', import.meta.url).pathname;

export async function loadHistory(): Promise<History> {
  try {
    const raw = await readFile(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<History>;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (err) {
    // Erster Lauf: Datei existiert noch nicht. Alles andere soll auffallen.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] };
    throw err;
  }
}

export async function saveHistory(history: History): Promise<void> {
  await mkdir(dirname(HISTORY_PATH), { recursive: true });
  await writeFile(HISTORY_PATH, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}

/**
 * Dedupe-Schlüssel. Die DOI ist stabil über Quellen hinweg — dieselbe Arbeit
 * taucht sonst über Europe PMC UND Crossref auf und käme zweimal dran.
 */
function keysFor(study: Pick<Study, 'id' | 'doi'>): string[] {
  const keys = [study.id.toLowerCase()];
  if (study.doi) keys.push(normalizeDoi(study.doi));
  return keys;
}

export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:/, '');
}

export function seenKeys(history: History): Set<string> {
  const set = new Set<string>();
  for (const e of history.entries) {
    set.add(e.id.toLowerCase());
    if (e.doi) set.add(normalizeDoi(e.doi));
  }
  return set;
}

export function isSeen(study: Pick<Study, 'id' | 'doi'>, seen: Set<string>): boolean {
  return keysFor(study).some((k) => seen.has(k));
}

/**
 * Wörter, die in Studientiteln überall vorkommen und deshalb nichts über den
 * Gegenstand aussagen. Ohne diese Liste würde die Themensperre bei jedem
 * zweiten Titel anschlagen, weil fast alle "systematic review and
 * meta-analysis" im Namen tragen.
 */
const STOPWORDS = new Set([
  'systematic', 'review', 'meta', 'analysis', 'metaanalysis', 'randomized', 'randomised',
  'controlled', 'trial', 'study', 'studies', 'effect', 'effects', 'association', 'associations',
  'associated', 'relationship', 'between', 'among', 'across', 'evidence', 'results', 'outcomes',
  'patients', 'adults', 'children', 'people', 'human', 'humans', 'clinical', 'population',
  'based', 'using', 'towards', 'toward', 'role', 'impact', 'analyses', 'cohort', 'prospective',
  'cross', 'sectional', 'longitudinal', 'comparison', 'versus', 'with', 'from', 'that', 'this',
  'their', 'které', 'multilevel', 'protocol', 'update', 'umbrella', 'narrative', 'pooled',
]);

/** Inhaltswörter eines Titels — Grundlage für Dublettenerkennung auf Themenebene. */
export function keywordsOf(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(/[^a-zäöüß\s-]/g, ' ')
        .split(/[\s-]+/)
        .filter((w) => w.length > 4 && !STOPWORDS.has(w)),
    ),
  ];
}

/** Trägt alles ein, was in dieser Ausgabe vorkam — Hauptfakt wie Nachschläge. */
export function recordBriefing(history: History, briefing: Briefing, studies: Study[]): History {
  const byUrl = new Map(studies.map((s) => [s.url, s]));
  const entries: HistoryEntry[] = [];

  const push = (url: string, title: string, role: HistoryEntry['role']) => {
    const study = byUrl.get(url);
    entries.push({
      id: study?.id ?? url,
      doi: study?.doi,
      date: briefing.date,
      topic: briefing.topic,
      title,
      role,
      keywords: keywordsOf(study?.title ?? title),
    });
  };

  push(briefing.lead.study.url, briefing.lead.study.title, 'lead');
  for (const s of briefing.shorts) push(s.study.url, s.study.title, 'short');

  return { entries: [...history.entries, ...entries] };
}
