/**
 * Gemeinsame Bausteine der Literatur-Adapter (Europe PMC, PubMed).
 *
 * Alles hier ist quellenunabhängig: Textbereinigung, Design-Ableitung,
 * Stichprobenextraktion. API-Spezifika bleiben in den Adaptern selbst.
 */

import type { SourceId, StudyDesign, Study, Topic } from '../types';

/** Darunter trägt ein Abstract keinen belastbaren Absatz — die Studie fliegt raus. */
export const MIN_ABSTRACT_LENGTH = 200;

export const USER_AGENT = 'valro-briefing/1.0 (mailto:valentin@valro.de)';

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Suchbegriffe je Thema. Bewusst als Phrasen und nicht als Einzelwörter:
 * "attention" allein zieht die halbe ADHS-Literatur mit rein.
 * Die Adapter gießen die Liste in ihre eigene Feldsyntax.
 *
 * `economics` deckt nur Gesundheitsökonomie ab — die eigentliche
 * Wirtschaftsliteratur kommt aus einer anderen Quelle.
 */
export const TOPIC_TERMS: Record<Topic, readonly string[]> = {
  sleep: [
    'sleep duration',
    'sleep quality',
    'sleep deprivation',
    'sleep restriction',
    'chronotype',
    'circadian rhythm',
    'insomnia',
    'daytime napping',
    'shift work',
  ],
  productivity: [
    'cognitive performance',
    'sustained attention',
    'attentional control',
    'multitasking',
    'task switching',
    'working memory',
    'mental fatigue',
    'rest breaks',
    'working hours',
    'cognitive training',
  ],
  body: [
    'physical activity',
    'exercise training',
    'dietary intervention',
    'all-cause mortality',
    'longevity',
    'metabolic health',
    'cardiovascular risk',
    'weight loss',
    'sedentary behaviour',
    'sedentary behavior',
  ],
  psychology: [
    'decision making',
    'motivation',
    'memory consolidation',
    'episodic memory',
    'social cognition',
    'emotion regulation',
    'behaviour change',
    'behavior change',
    'cognitive bias',
    'habit formation',
  ],
  economics: [
    'cost-effectiveness',
    'health economics',
    'economic evaluation',
    'health care costs',
    'productivity loss',
    'return on investment',
  ],
  learning: [
    'retrieval practice',
    'testing effect',
    'spaced repetition',
    'distributed practice',
    'memory consolidation',
    'skill acquisition',
    'feedback on learning',
    'academic achievement',
  ],
  environment: [
    'air pollution',
    'particulate matter',
    'noise exposure',
    'ambient temperature',
    'heat exposure',
    'green space',
    'daylight exposure',
    'indoor air quality',
  ],
  nutrition: [
    'dietary pattern',
    'ultra-processed food',
    'added sugar',
    'dietary fibre',
    'dietary fiber',
    'protein intake',
    'mediterranean diet',
    'intermittent fasting',
    'micronutrient supplementation',
  ],
  time: [
    'commuting',
    'time use',
    'urban environment',
    'built environment',
    'active travel',
    'working time',
    'time poverty',
    'leisure time',
  ],
  relationships: [
    'social isolation',
    'loneliness',
    'social support',
    'social connection',
    'marital quality',
    'friendship',
    'social network',
    'interpersonal relationship',
  ],
};

/** Publikationstypen, die wir überhaupt haben wollen — hohe Evidenzstufen. */
export const QUALITY_PUB_TYPES = [
  'Meta-Analysis',
  'Systematic Review',
  'Randomized Controlled Trial',
] as const;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  deg: '°',
  plusmn: '±',
  times: '×',
  divide: '÷',
  micro: 'µ',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  le: '≤',
  ge: '≥',
  ne: '≠',
  minus: '−',
  copy: '©',
  reg: '®',
  trade: '™',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code < 1 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Block-Elemente werden durch ein Leerzeichen ersetzt (Europe PMC liefert
 * Zwischenüberschriften als `<h4>Methods</h4>`, die sonst am Fließtext kleben),
 * Inline-Elemente ersatzlos (`H<sub>2</sub>O` soll `H2O` bleiben).
 *
 * Nach `<` muss ein Buchstabe stehen, damit aus "a < b > c" nicht das " b "
 * herausgeschnitten wird.
 */
function stripTags(text: string): string {
  return text
    .replace(/<(script|style)\b[^<>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(?:h[1-6]|p|div|br|li|ul|ol|sec|title|abstract|abstracttext)\b[^<>]*>/gi, ' ')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, '');
}

/**
 * Entfernt JATS-/HTML-Auszeichnung und dekodiert Entities.
 *
 * Zwei Durchgänge, weil Europe PMC das Markup teils maskiert ausliefert
 * (`Juice Plus&lt;sup&gt;+&lt;/sup&gt;`) — dort entsteht das Tag erst durch
 * das Dekodieren.
 */
export function cleanText(raw: string): string {
  return stripTags(decodeEntities(stripTags(raw)))
    .replace(/\s+/g, ' ')
    .trim();
}

export function hasUsableAbstract(abstract: string): boolean {
  return abstract.length >= MIN_ABSTRACT_LENGTH;
}

// ---------------------------------------------------------------------------
// Identität
// ---------------------------------------------------------------------------

/** Normalisiert auf die nackte, kleingeschriebene DOI; gibt bei Unsinn undefined zurück. */
export function normalizeDoi(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const doi = String(raw)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
    .replace(/[.,;]+$/, '');
  return /^10\.\d{4,9}\/\S+$/.test(doi) ? doi : undefined;
}

export function buildStudyId(source: SourceId, nativeId: string, doi?: string): string {
  return doi ?? `${source}:${nativeId}`;
}

/** Eine Quelle kann dieselbe Arbeit mehrfach ausliefern (z. B. MED- und PMC-Datensatz). */
export function dedupeById(studies: Study[]): Study[] {
  const seen = new Set<string>();
  return studies.filter((study) => (seen.has(study.id) ? false : (seen.add(study.id), true)));
}

// ---------------------------------------------------------------------------
// Studiendesign
// ---------------------------------------------------------------------------

export interface DesignSignals {
  /** Publikationstypen der Quelle, in Originalschreibweise. */
  pubTypes?: readonly string[];
  title?: string;
  abstract?: string;
}

interface DesignRule {
  design: StudyDesign;
  /** Kleingeschrieben, exakter Vergleich. */
  pubTypes?: readonly string[];
  patterns?: readonly RegExp[];
}

/**
 * Reihenfolge = Priorität, stärkste Evidenz zuerst.
 * "Systematic review and meta-analysis" soll als Metaanalyse zählen,
 * nicht als Review — deshalb wird nicht der beste, sondern der erste Treffer genommen.
 */
const DESIGN_RULES: readonly DesignRule[] = [
  {
    design: 'meta-analysis',
    pubTypes: ['meta-analysis'],
    patterns: [
      /\bmeta[-\s]?analy(?:sis|ses|tic|zed|sed)\b/i,
      /\bpooled analysis\b/i,
      /\bindividual (?:participant|patient) data\b/i,
    ],
  },
  {
    design: 'systematic-review',
    pubTypes: ['systematic review', 'systematic review and meta-analysis'],
    patterns: [
      /\bsystematic(?:ally)? (?:literature )?(?:review|searched)\b/i,
      /\b(?:scoping|umbrella|rapid) review\b/i,
      /\bprisma\b/i,
      /\bcochrane review\b/i,
    ],
  },
  {
    design: 'rct',
    pubTypes: [
      'randomized controlled trial',
      'randomised controlled trial',
      'controlled clinical trial',
      'pragmatic clinical trial',
      'equivalence trial',
      'clinical trial, phase iii',
      'clinical trial, phase iv',
    ],
    patterns: [
      /\brandomi[sz]ed[ -](?:controlled[ -])?(?:clinical[ -])?trial\b/i,
      /\bcluster[ -]randomi[sz]ed\b/i,
      /\brandomly (?:assigned|allocated)\b/i,
      /\bdouble[ -]blind\b/i,
      /\bplacebo[ -]controlled\b/i,
      /\bRCTs?\b/,
    ],
  },
  {
    design: 'cohort',
    pubTypes: ['observational study'],
    patterns: [
      /\bcohort (?:study|studies|analysis)\b/i,
      /\b(?:prospective|retrospective|longitudinal|birth) cohort\b/i,
      /\bprospective(?:ly)? (?:study|followed|recruited)\b/i,
      /\buk biobank\b/i,
      /\bmendelian randomi[sz]ation\b/i,
    ],
  },
  {
    design: 'case-control',
    patterns: [/\b(?:nested )?case[ -]control\b/i],
  },
  {
    design: 'cross-sectional',
    patterns: [
      /\bcross[ -]sectional\b/i,
      /\b(?:population|nationally representative)[ -]based survey\b/i,
    ],
  },
  {
    design: 'experiment',
    patterns: [
      /\b(?:laboratory|lab|behaviou?ral|online|field|preregistered) experiment\b/i,
      /\bexperiments? (?:1|2|one|two)\b/i,
      /\b(?:within|between)[ -]subjects?\b/i,
      /\bcross[ -]?over (?:trial|study|design)\b/i,
    ],
  },
  {
    design: 'modelling',
    patterns: [
      /\b(?:micro)?simulation (?:model|study|analysis)\b/i,
      /\bagent[ -]based model\b/i,
      /\bmarkov model\b/i,
      /\bmodell?ing study\b/i,
      /\bcost[ -]effectiveness (?:model|analysis)\b/i,
    ],
  },
  {
    design: 'narrative-review',
    pubTypes: ['review', 'narrative review'],
    patterns: [/\bnarrative review\b/i, /\bthis review (?:summari[sz]es|discusses|examines)\b/i],
  },
];

export function inferDesign(signals: DesignSignals): StudyDesign {
  const pubTypes = new Set((signals.pubTypes ?? []).map((type) => type.trim().toLowerCase()));
  const text = `${signals.title ?? ''} ${signals.abstract ?? ''}`;

  for (const rule of DESIGN_RULES) {
    if (rule.pubTypes?.some((type) => pubTypes.has(type))) return rule.design;
    if (rule.patterns?.some((pattern) => pattern.test(text))) return rule.design;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Stichprobengröße
// ---------------------------------------------------------------------------

const MIN_SAMPLE = 3;
const MAX_SAMPLE = 100_000_000;

/** Tausendertrennung explizit erlauben, aber nur in Dreiergruppen — sonst frisst das Muster Jahreszahlen. */
const COUNT = String.raw`\d{1,3}(?:[,   ]\d{3})+|\d+`;

/** `(?![-\w])` verhindert Treffer auf "person-years" oder "patient-months". */
const PEOPLE = String.raw`(?:participants?|patients?|subjects?|adults?|children|adolescents?|individuals?|women|men|respondents?|volunteers?|infants?|students?|workers?|persons?|people)(?![-\w])`;

const SAMPLE_PATTERNS: readonly RegExp[] = [
  // Explizite Gesamtangabe — die verlässlichste Form
  new RegExp(
    String.raw`\b(?:a total of|totall?ing|involving|comprising|including|enrolled|recruited|randomi[sz]ed|analy[sz]ed|pooled|followed(?: up)?)\s+(?:more than |over |approximately |about |~\s?)?(${COUNT})\s+${PEOPLE}`,
    'gi',
  ),
  new RegExp(String.raw`\b(${COUNT})\s+${PEOPLE}`, 'gi'),
  new RegExp(String.raw`\bN\s*=\s*(${COUNT})\b(?![.,]\d)`, 'gi'),
];

/**
 * Liefert nur eine Zahl, wenn sie klar an einer Personenangabe hängt.
 * Innerhalb eines Musters gewinnt der größte Wert: Abstracts nennen erst die
 * Gesamtzahl und danach Untergruppen. Im Zweifel undefined — raten ist schlimmer.
 */
export function extractSampleSize(...texts: (string | undefined)[]): number | undefined {
  const text = texts.filter((part): part is string => Boolean(part)).join(' ');
  if (!text) return undefined;

  for (const pattern of SAMPLE_PATTERNS) {
    let best: number | undefined;
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      if (!raw) continue;
      const value = Number.parseInt(raw.replace(/[,   ]/g, ''), 10);
      if (!Number.isInteger(value) || value < MIN_SAMPLE || value > MAX_SAMPLE) continue;
      if (best === undefined || value > best) best = value;
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Zeit & Netz
// ---------------------------------------------------------------------------

/** Untergrenze des Publikationsfensters als `YYYY-MM-DD`. */
export function sinceIsoDate(sinceDays: number, now: Date = new Date()): string {
  const days = Number.isFinite(sinceDays) && sinceDays > 0 ? Math.floor(sinceDays) : 1;
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Nachkontrolle zum Serverfilter: PubMed filtert auf das Heftdatum, wir melden
 * aber das (frühere) Datum der Erstveröffentlichung. Ein im Oktober vorab
 * erschienener Artikel im August-Heft ist nicht neu und fliegt hier raus.
 * Keine Obergrenze — Hefte tragen regelmäßig Datumsangaben in der Zukunft.
 */
export function isWithinWindow(publishedAt: string | undefined, sinceIso: string): boolean {
  return publishedAt === undefined || publishedAt >= sinceIso;
}

export function toArray<T>(value: T | readonly T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? [...value] : [value as T];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Kombiniert das Abbruchsignal der Pipeline mit einem eigenen Timeout. */
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export interface RequestOptions {
  /** Taucht in Fehlermeldungen auf, damit die Pipeline weiß, welche Quelle klemmt. */
  label: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  accept?: string;
}

export async function requestText(url: URL | string, opts: RequestOptions): Promise<string> {
  const response = await fetch(url, {
    signal: requestSignal(opts.signal, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    headers: {
      'user-agent': USER_AGENT,
      accept: opts.accept ?? '*/*',
    },
  });
  if (!response.ok) {
    throw new Error(`${opts.label}: HTTP ${response.status} ${response.statusText}`);
  }
  return response.text();
}

export async function requestJson<T>(url: URL | string, opts: RequestOptions): Promise<T> {
  const body = await requestText(url, { accept: 'application/json', ...opts });
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${opts.label}: Antwort war kein gültiges JSON`);
  }
}
