/**
 * Gemeinsamer Vertrag für die gesamte Pipeline.
 *
 * Jedes Quell-Modul liefert `Study[]`, der Scorer bewertet sie, der Selector
 * wählt eine aus, der Writer macht daraus ein `Briefing`. Nichts in dieser
 * Datei kennt eine konkrete API — das ist Absicht.
 */

/** Themen der Wochenrotation. */
export type Topic = 'sleep' | 'productivity' | 'body' | 'economics' | 'psychology';

export const TOPICS: readonly Topic[] = [
  'sleep',
  'productivity',
  'body',
  'economics',
  'psychology',
] as const;

/** Deutsche Anzeigenamen — landen in Betreffzeile und Mail-Kopf. */
export const TOPIC_LABELS: Record<Topic, string> = {
  sleep: 'Schlaf',
  productivity: 'Produktivität & Fokus',
  body: 'Körper & Gesundheit',
  economics: 'Wirtschaft',
  psychology: 'Psychologie',
};

/**
 * Studiendesign, absteigend nach Aussagekraft.
 * Der Scorer gewichtet danach — das ist der wichtigste Einzelfaktor.
 */
export type StudyDesign =
  | 'meta-analysis'
  | 'systematic-review'
  | 'rct'
  | 'cohort'
  | 'case-control'
  | 'cross-sectional'
  | 'experiment'
  | 'modelling'
  | 'narrative-review'
  | 'unknown';

export type SourceId = 'europepmc' | 'pubmed' | 'openalex' | 'crossref' | 'nber';

/**
 * Eine Studie, normalisiert über alle Quellen hinweg.
 * `id` ist der Dedupe-Schlüssel: bevorzugt die DOI, sonst `${source}:${nativeId}`.
 */
export interface Study {
  id: string;
  doi?: string;
  title: string;
  /** Volltext des Abstracts. Ohne Abstract wird die Studie verworfen — der Writer darf nicht raten. */
  abstract: string;
  authors: string[];
  journal?: string;
  year?: number;
  /** ISO-Datum, falls die Quelle eines liefert. */
  publishedAt?: string;
  url: string;
  source: SourceId;
  topics: Topic[];
  design: StudyDesign;
  /** Teilnehmerzahl, wenn aus Titel/Abstract sicher extrahierbar. */
  sampleSize?: number;
  citationCount?: number;
  isPreprint: boolean;
  isOpenAccess?: boolean;
}

export interface FetchOptions {
  topic: Topic;
  /** Nur Arbeiten aus den letzten N Tagen berücksichtigen. */
  sinceDays: number;
  limit: number;
  signal?: AbortSignal;
}

export interface Source {
  id: SourceId;
  label: string;
  /** Muss bei Fehlern werfen; die Pipeline fängt ab und läuft mit den übrigen Quellen weiter. */
  fetch(opts: FetchOptions): Promise<Study[]>;
}

/**
 * Ergebnis der Glaubwürdigkeitsprüfung.
 * `rejected` ist ein hartes Aus — z. B. Treffer auf der Zombie-Liste.
 */
export interface CredibilityScore {
  /** 0–100. Schwelle für die Aufnahme in den Pool steht in der Config. */
  total: number;
  breakdown: {
    design: number;
    sampleSize: number;
    citations: number;
    venue: number;
    recency: number;
    replication: number;
  };
  /** Alltagssprachliche Einordnung, z. B. "Metaanalyse über 200.000 Menschen". */
  evidenceLabel: string;
  /** Begründungen für die Bewertung, fürs Log und die Mail-Fußzeile. */
  reasons: string[];
  rejected: boolean;
  rejectionReason?: string;
}

export interface ScoredStudy {
  study: Study;
  score: CredibilityScore;
}

/** Kurzreferenz auf die Quelle, wie sie in der Mail auftaucht. */
export interface StudyRef {
  title: string;
  journal?: string;
  year?: number;
  url: string;
  doi?: string;
  evidenceLabel: string;
}

/**
 * Der Hauptfakt. Die sechs Felder sind die Erzählstruktur —
 * `caveat` und `dinnerLine` sind das, was den Unterschied zwischen
 * Nachplappern und Kompetenz macht.
 */
export interface LeadFact {
  /** Frage, bei der man kurz selbst überlegt. */
  hook: string;
  /** Der Befund inklusive konkreter, merkbarer Zahl. */
  finding: string;
  /** Warum das so ist — hier entsteht der Aha-Moment. */
  mechanism: string;
  /** Evidenzstärke in Alltagssprache, keine p-Werte. */
  evidence: string;
  /** Was die Studie ausdrücklich NICHT sagt. */
  caveat: string;
  /** Ein Satz, den man abends tatsächlich sagen kann. */
  dinnerLine: string;
  study: StudyRef;
}

/** Nachschlag: zwei kurze Fakten ohne den vollen Aufbau. */
export interface ShortFact {
  finding: string;
  evidence: string;
  study: StudyRef;
}

export interface Briefing {
  /** ISO-Datum der Ausgabe, z. B. "2026-08-07". */
  date: string;
  topic: Topic;
  /** Betreffzeile der Mail. */
  subject: string;
  lead: LeadFact;
  shorts: ShortFact[];
  /** ISO-Zeitstempel der Generierung. */
  generatedAt: string;
}

/** Ein bereits ausgespielter Fakt — verhindert Wiederholungen. */
export interface HistoryEntry {
  id: string;
  doi?: string;
  date: string;
  topic: Topic;
  title: string;
  role: 'lead' | 'short';
}

export interface History {
  entries: HistoryEntry[];
}

/**
 * Ein bekannt widerlegter Befund. Treffer darauf führen zu hartem Ausschluss.
 * `patterns` sind case-insensitive Regex-Quellen gegen Titel + Abstract.
 */
export interface ZombieClaim {
  slug: string;
  label: string;
  /** Warum der Befund nicht mehr trägt — landet im Log. */
  why: string;
  patterns: string[];
}

export interface DeliveryResult {
  ok: boolean;
  provider: string;
  id?: string;
  error?: string;
}

export interface Mailer {
  name: string;
  send(msg: { to: string; subject: string; html: string; text: string }): Promise<DeliveryResult>;
}
