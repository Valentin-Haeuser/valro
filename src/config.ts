import type { Topic } from './types.js';

/**
 * Wochenrotation. Ohne feste Zuordnung landet man schnell fünf Tage
 * hintereinander beim gleichen Thema, weil manche Felder viel mehr
 * publizieren als andere.
 *
 * Index = Wochentag nach `Date.getDay()` (0 = Sonntag).
 * Am Wochenende kommt keine Mail — der Cron läuft nur Mo–Fr.
 */
export const WEEKDAY_TOPICS: Record<number, Topic> = {
  1: 'sleep',
  2: 'productivity',
  3: 'body',
  4: 'economics',
  5: 'psychology',
};

export function topicForDate(d: Date): Topic {
  return WEEKDAY_TOPICS[d.getDay()] ?? 'psychology';
}

export const CONFIG = {
  /** Mindest-Score, damit eine Studie überhaupt in den Auswahlpool kommt. */
  minCredibility: 55,

  /** Der Hauptfakt darf deutlich strenger sein als die Kurzfakten. */
  minCredibilityLead: 68,

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

  /** Modell für den Redakteur-Schritt. */
  model: 'claude-sonnet-5',

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
