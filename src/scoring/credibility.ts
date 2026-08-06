/**
 * Glaubwürdigkeits-Scoring — das Qualitätsherz der Pipeline.
 *
 * WARUM DIESE GEWICHTUNG (Summe 100):
 *
 *   design        30  Der mit Abstand stärkste Einzelfaktor. Ob ein Befund aus
 *                     einer Metaanalyse oder aus einem Einzelexperiment mit 40
 *                     Studierenden stammt, entscheidet mehr über seine
 *                     Haltbarkeit als alles andere. Genau hier ist die
 *                     Replikationskrise entstanden: bei kleinen, einmaligen,
 *                     nicht präregistrierten Experimenten.
 *   sampleSize    20  Zweitstärkster Faktor, aber logarithmisch: der Sprung von
 *                     50 auf 500 Personen ist gewaltig, der von 50.000 auf
 *                     500.000 fast bedeutungslos. Fehlt die Angabe, gibt es den
 *                     neutralen Mittelwert — "unbekannt" ist nicht "null".
 *   venue         15  Ein Signal für Peer-Review-Härte, kein Wahrheitsbeweis.
 *                     Preprints werden deutlich abgewertet, aber nicht
 *                     automatisch verworfen (das übernimmt die Rejection-Regel
 *                     in Kombination mit schwachem Design).
 *   replication   13  Präregistrierung, Multi-Labor-Designs, Registered
 *                     Reports, explizite Replikationen. Bewusst höher gewichtet
 *                     als Zitationen: ein präregistriertes Multi-Site-Design ist
 *                     ein besseres Haltbarkeitsversprechen als Popularität.
 *   citations     12  Immer relativ zum Alter der Arbeit — eine Studie von
 *                     letztem Monat hatte noch keine Chance auf Zitationen und
 *                     darf dafür nicht bestraft werden.
 *   recency       10  Bewusst der kleinste Faktor. Aktualität ist nett, aber
 *                     eine 2016er-Metaanalyse schlägt ein frisches Preprint.
 *
 * Der Score ist eine Vorsortierung, keine Wahrheitsmessung. Die harten
 * Ausschlüsse (Zombie-Liste, Preprint + schwaches Design, Score unter der
 * Schwelle) tragen deutlich mehr zur Qualität bei als die letzten fünf Punkte
 * Feinjustierung.
 */

import type { CredibilityScore, Study, StudyDesign } from '../types';
import { findZombieMatch } from './zombies';

/** Maximale Punktzahl je Kategorie. Summe = 100. */
const MAX = {
  design: 30,
  sampleSize: 20,
  venue: 15,
  replication: 13,
  citations: 12,
  recency: 10,
} as const;

/** Ab hier landet eine Studie im Pool. Darunter: harte Ablehnung. */
export const CREDIBILITY_THRESHOLD = 55;

/**
 * Absolute Untergrenze für die Verwertbarkeit — unabhängig vom Thema.
 *
 * Die Bewertung kennt das Thema des Tages nicht und darf deshalb nicht selbst
 * über die Tagesschwelle entscheiden: Die liegt in der Wirtschaftsausgabe
 * niedriger als in der Medizin, weil es dort schlicht keine Metaanalysen gibt.
 * Hier fliegt nur raus, was in keinem Fach trägt.
 */
export const CREDIBILITY_FLOOR = 38;

/** Designs, die allein nicht tragen — in Kombination mit Preprint disqualifizierend. */
const WEAK_DESIGNS: ReadonlySet<StudyDesign> = new Set<StudyDesign>([
  'cross-sectional',
  'experiment',
  'modelling',
  'narrative-review',
  'unknown',
]);

const DESIGN_POINTS: Record<StudyDesign, number> = {
  'meta-analysis': 30,
  'systematic-review': 28,
  rct: 25,
  cohort: 20,
  'case-control': 16,
  'cross-sectional': 13,
  experiment: 11,
  modelling: 7,
  'narrative-review': 4,
  unknown: 2,
};

const DESIGN_LABELS: Record<StudyDesign, string> = {
  'meta-analysis': 'Metaanalyse',
  'systematic-review': 'systematische Übersichtsarbeit',
  rct: 'randomisierte kontrollierte Studie',
  cohort: 'Langzeit-Beobachtungsstudie',
  'case-control': 'Fall-Kontroll-Studie',
  'cross-sectional': 'Momentaufnahme-Erhebung',
  experiment: 'Einzelexperiment',
  modelling: 'Modellrechnung',
  'narrative-review': 'Übersichtsartikel ohne systematische Suche',
  unknown: 'Studie unklaren Typs',
};

/** Erstklassige Journals: strenges Review, hohe Retraction-Sichtbarkeit. */
const TIER1_VENUES: readonly RegExp[] = [
  /\bnature\b/i,
  /^science$/i,
  /\bscience advances\b|\bscience translational medicine\b/i,
  /^cell\b|\bcell\s(?:metabolism|reports)\b/i,
  /\bthe lancet\b|\blancet\b/i,
  /new england journal of medicine|\bnejm\b/i,
  /\bjama\b/i,
  /\bbmj\b|british medical journal/i,
  /\bpnas\b|proceedings of the national academy/i,
  /cochrane database/i,
  /annals of internal medicine/i,
  /\bcirculation\b|european heart journal/i,
  /psychological (?:science|bulletin|review)/i,
  /perspectives on psychological science/i,
  /journal of personality and social psychology/i,
  /american economic review|quarterly journal of economics|econometrica/i,
  /journal of political economy|review of economic studies/i,
];

/** Solide, etablierte Fachjournals der fünf Themenfelder. */
const TIER2_VENUES: readonly RegExp[] = [
  /\bsleep\b|journal of sleep research|sleep medicine/i,
  /\bplos (?:medicine|biology|one)\b/i,
  /\belife\b/i,
  /molecular psychiatry|biological psychiatry|jama psychiatry/i,
  /american journal of clinical nutrition|british journal of nutrition/i,
  /\bnutrients\b|\bobesity\b|diabetes care/i,
  /international journal of epidemiology|american journal of epidemiology/i,
  /journal of experimental psychology|cognition\b|psychonomic/i,
  /journal of applied psychology|organizational behavior/i,
  /american economic journal|journal of economic perspectives/i,
  /journal of labor economics|journal of public economics/i,
  /bmc \w+|bmj open/i,
  /journal of the american heart association|hypertension\b/i,
  /neuroscience|neurology\b|brain\b/i,
];

/** Positive Signale für Robustheit im Volltext von Titel + Abstract. */
const REPLICATION_POSITIVE: readonly { re: RegExp; points: number; reason: string }[] = [
  { re: /\bpre[- ]?registered\b|\bpreregistration\b|\bregistered report\b/i, points: 3, reason: 'vorab registriert' },
  { re: /\bmulti[- ]?(?:lab|site|centre|center|national)\b|\bconsortium\b/i, points: 3, reason: 'Multi-Labor- bzw. Multi-Center-Design' },
  { re: /\breplicat(?:ion|ed|es|ing)\b/i, points: 2, reason: 'Replikation berichtet' },
  { re: /\bdouble[- ]blind(?:ed)?\b|\bplacebo[- ]controlled\b/i, points: 2, reason: 'doppelblind bzw. placebokontrolliert' },
  { re: /\bopen data\b|\bdata (?:are|is) (?:publicly )?available\b|\bosf\.io\b/i, points: 1, reason: 'Daten offen verfügbar' },
  { re: /\bindependent (?:sample|cohort|validation)\b|\bexternal validation\b|\bheld[- ]out\b/i, points: 2, reason: 'unabhängige Validierung' },
  { re: /\bsensitivity analys(?:is|es)\b|\bpre[- ]specified\b/i, points: 1, reason: 'Sensitivitätsanalysen' },
];

/** Warnsignale für dünne, leicht zerbrechende Befunde. */
const REPLICATION_NEGATIVE: readonly { re: RegExp; points: number; reason: string }[] = [
  { re: /\bpilot (?:study|trial)\b|\bproof[- ]of[- ]concept\b/i, points: 2, reason: 'Pilotstudie' },
  { re: /\bexploratory\b|\bpost[- ]hoc\b|\bsecondary analysis\b/i, points: 2, reason: 'explorativ bzw. Post-hoc-Auswertung' },
  { re: /\bconvenience sample\b|\bmechanical turk\b|\bmturk\b|\bprolific\b/i, points: 2, reason: 'Gelegenheitsstichprobe' },
  { re: /\bundergraduate(?:s| students)\b|\bpsychology students\b/i, points: 1, reason: 'reine Studierendenstichprobe' },
  { re: /\bsingle[- ](?:arm|centre|center|site)\b/i, points: 1, reason: 'Einzelzentrum ohne Kontrolle' },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Deutsche Zahlformatierung, alltagstauglich gerundet. */
function formatPeople(n: number): string {
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    const digits = millions < 10 ? 1 : 0;
    return `${millions.toLocaleString('de-DE', { maximumFractionDigits: digits })} Mio.`;
  }
  return n.toLocaleString('de-DE');
}

/**
 * Logarithmische Stichprobenbewertung.
 * n=50 → ~2, n=500 → ~7, n=5.000 → ~12, n=50.000 → ~17, ab ~200.000 → volle Punktzahl.
 * Fehlende Angabe → neutraler Mittelwert (entspricht grob n≈2.000).
 */
const NEUTRAL_SAMPLE = MAX.sampleSize / 2;
const LOG_FLOOR = Math.log10(20);
const LOG_CEIL = Math.log10(200_000);

function scoreSampleSize(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return NEUTRAL_SAMPLE;
  const normalized = (Math.log10(n) - LOG_FLOOR) / (LOG_CEIL - LOG_FLOOR);
  return clamp(normalized * MAX.sampleSize, 0, MAX.sampleSize);
}

const NEUTRAL_CITATIONS = MAX.citations / 2;

function ageInYears(study: Study, now: Date): number {
  if (study.publishedAt) {
    const then = Date.parse(study.publishedAt);
    if (Number.isFinite(then)) {
      return Math.max(0, (now.getTime() - then) / (365.25 * 24 * 3600 * 1000));
    }
  }
  if (typeof study.year === 'number' && Number.isFinite(study.year)) {
    return Math.max(0, now.getUTCFullYear() - study.year);
  }
  return Number.NaN;
}

/**
 * Zitationen immer relativ zum Alter. Arbeiten unter ~18 Monaten bekommen
 * mindestens den neutralen Wert — sie hatten schlicht noch keine Chance.
 */
function scoreCitations(study: Study, age: number): { points: number; reason: string } {
  if (study.citationCount === undefined || !Number.isFinite(study.citationCount)) {
    return { points: NEUTRAL_CITATIONS, reason: 'Zitationszahl unbekannt — neutral gewertet' };
  }
  if (Number.isNaN(age)) {
    return { points: NEUTRAL_CITATIONS, reason: 'Erscheinungsjahr unbekannt — Zitationen neutral gewertet' };
  }
  const yearsAvailable = Math.max(0.5, age);
  const perYear = study.citationCount / yearsAvailable;
  const normalized = Math.log10(1 + perYear) / Math.log10(1 + 50);
  let points = clamp(normalized * MAX.citations, 0, MAX.citations);

  if (age < 1.5 && points < NEUTRAL_CITATIONS) {
    return {
      points: NEUTRAL_CITATIONS,
      reason: 'frisch erschienen — Zitationen noch nicht aussagekräftig, neutral gewertet',
    };
  }
  points = Math.round(points * 10) / 10;
  const rounded = Math.round(perYear * 10) / 10;
  return {
    points,
    reason:
      perYear >= 10
        ? `stark rezipiert (rund ${rounded.toLocaleString('de-DE')} Zitationen pro Jahr)`
        : perYear >= 2
          ? `solide rezipiert (rund ${rounded.toLocaleString('de-DE')} Zitationen pro Jahr)`
          : 'bislang kaum zitiert',
  };
}

/**
 * In der Medizin ist ein Preprint ein Warnsignal. In der Wirtschaftsforschung
 * ist die Working-Paper-Reihe dagegen das übliche Publikationsformat: NBER-
 * Papiere werden redaktionell geprüft, breit zitiert und zirkulieren oft
 * jahrelang, bevor eine Zeitschriftenfassung erscheint. Würden wir sie wie
 * beliebige Preprints behandeln, fiele die gesamte Donnerstagsausgabe durch
 * das Raster.
 */
function isWorkingPaperSeries(study: Study): boolean {
  return study.source === 'nber';
}

function scoreVenue(study: Study): { points: number; reason: string } {
  if (isWorkingPaperSeries(study)) {
    return {
      points: 10,
      reason: 'NBER Working Paper — in der Wirtschaftsforschung das übliche Format, redaktionell geprüft',
    };
  }
  if (study.isPreprint) {
    return { points: 3, reason: 'Preprint — noch nicht begutachtet' };
  }
  const journal = study.journal?.trim();
  if (!journal) {
    return { points: 5, reason: 'Publikationsort unbekannt' };
  }
  if (TIER1_VENUES.some((re) => re.test(journal))) {
    return { points: MAX.venue, reason: `erschienen in einem Spitzenjournal (${journal})` };
  }
  if (TIER2_VENUES.some((re) => re.test(journal))) {
    return { points: 12, reason: `erschienen in einem etablierten Fachjournal (${journal})` };
  }
  return { points: 8, reason: `erschienen in ${journal}` };
}

function scoreRecency(age: number): { points: number; reason: string } {
  if (Number.isNaN(age)) {
    return { points: MAX.recency / 2, reason: 'Erscheinungsjahr unbekannt — neutral gewertet' };
  }
  const points = clamp(MAX.recency - age * 0.5, 1, MAX.recency);
  if (age <= 2) return { points, reason: 'aktuelle Arbeit' };
  if (age <= 7) return { points, reason: 'einige Jahre alt, aber noch aktuell' };
  if (age <= 15) return { points, reason: 'älterer Befund' };
  return { points, reason: 'deutlich älterer Befund' };
}

function scoreReplication(study: Study): { points: number; reasons: string[] } {
  const haystack = `${study.title}\n${study.abstract}`;
  let points = MAX.replication / 2;
  const reasons: string[] = [];

  if (study.design === 'meta-analysis' || study.design === 'systematic-review') {
    points += 3;
    reasons.push('fasst mehrere Studien zusammen');
  }
  for (const signal of REPLICATION_POSITIVE) {
    if (signal.re.test(haystack)) {
      points += signal.points;
      reasons.push(signal.reason);
    }
  }
  for (const signal of REPLICATION_NEGATIVE) {
    if (signal.re.test(haystack)) {
      points -= signal.points;
      reasons.push(`Vorbehalt: ${signal.reason}`);
    }
  }
  return { points: clamp(points, 0, MAX.replication), reasons };
}

/**
 * Alltagssprachliche Einordnung — landet 1:1 in der Mail.
 * Keine p-Werte, keine Effektstärken, kein Fachjargon.
 */
function buildEvidenceLabel(study: Study, total: number): string {
  const designLabel = DESIGN_LABELS[study.design];
  const n = study.sampleSize;

  let core: string;
  if (n !== undefined && Number.isFinite(n) && n > 0) {
    const people = formatPeople(n);
    switch (study.design) {
      case 'meta-analysis':
      case 'systematic-review':
        core = `${designLabel} mit insgesamt ${people} Menschen`;
        break;
      case 'rct':
        core = `${designLabel} mit ${people} Teilnehmenden`;
        break;
      case 'cohort':
        core = `${designLabel} über ${people} Menschen`;
        break;
      case 'experiment':
        core = `${designLabel} mit ${people} Teilnehmenden`;
        break;
      default:
        core = `${designLabel} mit ${people} Menschen`;
    }
  } else {
    core = `${designLabel} (Teilnehmerzahl nicht angegeben)`;
  }

  const suffixes: string[] = [];
  if (study.isPreprint) suffixes.push('noch ohne Fachbegutachtung');
  const small = n !== undefined && n > 0 && n < 100;
  if (small || total < CREDIBILITY_THRESHOLD + 10) {
    suffixes.push('mit Vorsicht zu genießen');
  }
  return suffixes.length > 0 ? `${core} — ${suffixes.join(', ')}` : core;
}

/**
 * Bewertet eine Studie. Reine Funktion, keine Seiteneffekte, kein Netzwerk.
 */
export function scoreStudy(study: Study): CredibilityScore {
  const now = new Date();
  const age = ageInYears(study, now);

  const designPoints = DESIGN_POINTS[study.design] ?? DESIGN_POINTS.unknown;
  const samplePoints = scoreSampleSize(study.sampleSize);
  const citations = scoreCitations(study, age);
  const venue = scoreVenue(study);
  const recency = scoreRecency(age);
  const replication = scoreReplication(study);

  const breakdown = {
    design: Math.round(designPoints * 10) / 10,
    sampleSize: Math.round(samplePoints * 10) / 10,
    citations: Math.round(citations.points * 10) / 10,
    venue: Math.round(venue.points * 10) / 10,
    recency: Math.round(recency.points * 10) / 10,
    replication: Math.round(replication.points * 10) / 10,
  };

  const total = clamp(
    Math.round(
      breakdown.design +
        breakdown.sampleSize +
        breakdown.citations +
        breakdown.venue +
        breakdown.recency +
        breakdown.replication,
    ),
    0,
    100,
  );

  const reasons: string[] = [`Studiendesign: ${DESIGN_LABELS[study.design]}`];
  if (study.sampleSize !== undefined && study.sampleSize > 0) {
    reasons.push(`Datenbasis: ${formatPeople(study.sampleSize)} Menschen`);
  } else {
    reasons.push('Teilnehmerzahl nicht angegeben — neutral gewertet');
  }
  reasons.push(venue.reason, citations.reason, recency.reason, ...replication.reasons);

  const evidenceLabel = buildEvidenceLabel(study, total);

  // ---- harte Ausschlüsse -------------------------------------------------
  const zombie = findZombieMatch(study);
  if (zombie) {
    return {
      total,
      breakdown,
      evidenceLabel,
      reasons: [`Widerlegter Klassiker: ${zombie.label}`, zombie.why, ...reasons],
      rejected: true,
      rejectionReason: `Zombie-Befund "${zombie.label}" (${zombie.slug}): ${zombie.why}`,
    };
  }

  if (study.isPreprint && WEAK_DESIGNS.has(study.design) && !isWorkingPaperSeries(study)) {
    return {
      total,
      breakdown,
      evidenceLabel,
      reasons,
      rejected: true,
      rejectionReason: `Preprint ohne belastbares Design (${DESIGN_LABELS[study.design]}) — doppelt ungeprüft`,
    };
  }

  if (total < CREDIBILITY_FLOOR) {
    return {
      total,
      breakdown,
      evidenceLabel,
      reasons,
      rejected: true,
      rejectionReason: `Gesamtscore ${total} liegt unter der Untergrenze von ${CREDIBILITY_FLOOR}`,
    };
  }

  return { total, breakdown, evidenceLabel, reasons, rejected: false };
}
