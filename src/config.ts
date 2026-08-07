import type { SourceId, Topic } from './types.js';

/**
 * Zwei-Wochen-Rotation über zehn Themen.
 *
 * Ohne feste Zuordnung landet man schnell mehrere Tage hintereinander beim
 * gleichen Gegenstand, weil manche Felder viel mehr publizieren als andere.
 * Zwei Wochen statt einer, damit zehn Themen Platz haben, ohne dass an einem
 * Tag zwei davon gegeneinander antreten.
 *
 * Index = Wochentag nach `Date.getDay()` (1 = Montag).
 * Am Wochenende kommt keine Mail — der Cron läuft nur Mo–Fr.
 */
export const ROTATION: readonly Record<number, Topic>[] = [
  {
    1: 'sleep',
    2: 'productivity',
    3: 'body',
    4: 'economics',
    5: 'psychology',
  },
  {
    1: 'learning',
    2: 'environment',
    3: 'nutrition',
    4: 'time',
    5: 'relationships',
  },
];

const DAY_MS = 86_400_000;

/**
 * Donnerstag der Woche, in der `d` liegt. Der Donnerstag bestimmt laut
 * ISO 8601, zu welchem Jahr und welcher Woche eine Woche gehört, und ist
 * damit ein eindeutiger Stempel für „diese Kalenderwoche".
 */
function isoThursday(d: Date): Date {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return date;
}

/** ISO-Kalenderwoche, 1–53. Nur zur Anzeige. */
export function isoWeek(d: Date): number {
  const thursday = isoThursday(d);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  return Math.ceil(((thursday.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
}

/**
 * Fortlaufender Wochenzähler seit einem festen Bezugspunkt.
 *
 * Naheliegend wäre, die Kalenderwoche selbst gerade/ungerade zu nehmen — das
 * war der erste Ansatz und er ist falsch. ISO-Jahre haben 52 ODER 53 Wochen,
 * und beim Sprung von KW 53 auf KW 1 bleibt die Parität gleich. Zum Jahres-
 * wechsel 2026/27 wäre dieselbe Wochenhälfte deshalb zweimal hintereinander
 * gelaufen: „Lernen & Gedächtnis" an zwei Montagen in Folge.
 *
 * Ein durchlaufender Zähler kennt diesen Sprung nicht. Der 1. Januar 1970 war
 * ein Donnerstag, deshalb geht der Abstand zum ISO-Donnerstag jeder Woche
 * immer glatt durch sieben auf.
 */
const EPOCH_THURSDAY = Date.UTC(1970, 0, 1);

export function weekIndex(d: Date): number {
  return Math.floor((isoThursday(d).getTime() - EPOCH_THURSDAY) / (7 * DAY_MS));
}

/**
 * Woche des ersten echten Laufs (KW 32/2026), die mit `ROTATION[0]` lief.
 *
 * Der Wechsel vom Paritätstrick auf den durchlaufenden Zähler hätte die
 * Zuordnung sonst um eine Woche verschoben — der bereits verschickte Freitag
 * wäre rückwirkend ein anderes Thema gewesen und der kommende Montag
 * ebenfalls. Der Anker hält die laufende Reihenfolge fest.
 */
const ANCHOR_WEEK = weekIndex(new Date(Date.UTC(2026, 7, 7)));

export function topicForDate(d: Date): Topic {
  const n = ROTATION.length;
  // Vor der Ankerwoche wird die Differenz negativ; `% n` allein liefert dann
  // in JavaScript einen negativen Index.
  const offset = (((weekIndex(d) - ANCHOR_WEEK) % n) + n) % n;
  return ROTATION[offset]![d.getDay()] ?? 'psychology';
}

/**
 * Welche Quellen zu welchem Thema befragt werden.
 *
 * Europe PMC und PubMed sind biomedizinische Datenbanken. Fragt man sie nach
 * "economics", liefern sie brav Gesundheitsökonomie: Kostenwirksamkeit von
 * Thrombolyse, Screening-Programme, Krankenhausqualität. Formal Wirtschaft,
 * aber nicht das, was jemand hören will, der etwas über Arbeitsmärkte oder
 * Verhaltensökonomie erfahren möchte. Für dieses Thema fragen wir deshalb nur
 * Quellen, die Wirtschaft tatsächlich abdecken.
 *
 * Themen ohne Eintrag befragen alle Quellen.
 */
export const SOURCES_BY_TOPIC: Partial<Record<Topic, readonly SourceId[]>> = {
  economics: ['nber', 'crossref', 'openalex'],
};

/**
 * Themenabhängige Mindestpunktzahl.
 *
 * Die Evidenzhierarchie der Medizin — Metaanalyse über RCT über Kohorte —
 * gibt es in der Wirtschaftsforschung so nicht. Makroökonomische Arbeiten
 * kommen praktisch nie als Metaanalyse daher. Mit der medizinischen Schwelle
 * bliebe der Donnerstag dauerhaft leer.
 */
export interface Thresholds {
  pool: number;
  lead: number;
  relevance: number;
  relevanceLead: number;
}

/**
 * Auch die Relevanzlatte liegt in der Wirtschaft niedriger: Ökonomische
 * Arbeiten reden über Steuern, Löhne und Märkte statt über Schlaf und Sport,
 * treffen den Leser aber genauso.
 */
const BY_TOPIC: Partial<Record<Topic, Thresholds>> = {
  economics: { pool: 42, lead: 52, relevance: 0.3, relevanceLead: 0.42 },
};

export function thresholdsFor(topic: Topic): Thresholds {
  return (
    BY_TOPIC[topic] ?? {
      pool: CONFIG.minCredibility,
      lead: CONFIG.minCredibilityLead,
      relevance: CONFIG.minRelevance,
      relevanceLead: CONFIG.minRelevanceLead,
    }
  );
}

export const CONFIG = {
  /** Mindest-Score, damit eine Studie überhaupt in den Auswahlpool kommt. */
  minCredibility: 55,

  /** Der Hauptfakt darf deutlich strenger sein als die Kurzfakten. */
  minCredibilityLead: 68,

  /**
   * Untergrenze der Alltagsrelevanz (0–1). Darunter ist ein Befund zu eng,
   * um jemanden zu interessieren, der nicht vom Fach ist.
   */
  minRelevance: 0.4,

  /**
   * Der Hauptfakt muss den Leser wirklich betreffen, nicht nur "auch Menschen".
   * 0,55 heißt praktisch: mindestens ein klar alltagsnaher Gegenstand, und
   * kein Abzug für klinische Enge. Der neutrale Ausgangswert liegt bei 0,45,
   * ein Treffer bringt 0,14 — die Schwelle sitzt bewusst dazwischen statt
   * knapp darüber, wo ein einzelner Punkt über die Ausgabe entscheiden würde.
   */
  minRelevanceLead: 0.55,

  /** Wie weit zurück gesucht wird. Großzügig, weil gute Metaanalysen selten sind. */
  sinceDays: 400,

  /** Treffer pro Quelle und Lauf. */
  limitPerSource: 25,

  /**
   * Sperrfrist für den GEGENSTAND einer Studie. Dieselbe Arbeit kommt nie
   * wieder (dafür sorgt die History), aber auch das Thema soll sich nicht
   * alle zwei Wochen wiederholen. Sechs Wochen sind lang genug, dass es sich
   * nicht wie eine Wiederholung anfühlt, und kurz genug, dass ergiebige
   * Felder nicht dauerhaft verbrannt sind.
   */
  subjectCooldownDays: 42,

  /**
   * Ab welcher Stichwort-Überschneidung zwei Studien als dasselbe Thema
   * gelten. Hoch angesetzt: lieber ein Thema zu viel durchlassen, als ein
   * ganzes Feld zu sperren.
   */
  subjectOverlapLimit: 0.5,

  /**
   * Modell für den Redakteur-Schritt. Der geschriebene Text IST das Produkt,
   * deshalb das stärkste Modell — der Unterschied macht im Monat unter einen
   * Euro aus.
   */
  model: 'claude-opus-5',

  /**
   * Muss großzügig sein: Auf Opus 5 denkt das Modell standardmäßig mit, und
   * `max_tokens` deckelt Denken UND Antwort gemeinsam. Zu knapp bemessen
   * bricht die JSON-Antwort mitten im Satz ab und der Lauf schlägt fehl.
   */
  maxTokens: 8000,

  /**
   * Der Redakteur-Schritt formuliert aus fertig gelieferten Abstracts — das
   * ist Schreibarbeit, keine tiefe Analyse. Mittlere Stufe reicht und spart
   * Zeit wie Geld.
   */
  effort: 'medium',

  /** Zeitzone für Datum und Betreff. */
  timezone: 'Europe/Berlin',
} as const;

export interface Env {
  anthropicApiKey: string;
  smtpUser: string;
  smtpPassword: string;
  smtpHost: string;
  smtpPort: number;
  mailTo: string;
  mailFromName: string;
}

/** Liest die Umgebung und sagt beim ersten fehlenden Wert klar, was fehlt. */
export function loadEnv(): Env {
  const missing: string[] = [];
  const need = (key: string): string => {
    const v = process.env[key]?.trim();
    if (!v) missing.push(key);
    return v ?? '';
  };

  const env: Env = {
    anthropicApiKey: need('ANTHROPIC_API_KEY'),
    smtpUser: need('SMTP_USER'),
    smtpPassword: need('SMTP_PASSWORD'),
    smtpHost: process.env.SMTP_HOST?.trim() || 'smtp.gmail.com',
    smtpPort: Number(process.env.SMTP_PORT ?? 465),
    mailTo: need('MAIL_TO'),
    mailFromName: process.env.MAIL_FROM_NAME?.trim() || 'Morgenbriefing',
  };

  if (missing.length > 0) {
    throw new Error(
      `Fehlende Secrets: ${missing.join(', ')}.\n` +
        `In GitHub eintragen unter Settings → Secrets and variables → Actions.\n` +
        `Details stehen in der README.`,
    );
  }
  return env;
}
