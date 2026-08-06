/**
 * Crossref — breite Metadaten-Abdeckung über alle fünf Themen.
 *
 * Stärke: `is-referenced-by-count` als Zitationszahl und saubere Journal-,
 * Autoren- und Datumsfelder. Schwäche: Abstracts liegen als JATS-XML vor und
 * viele Einträge haben gar keins — deshalb der `has-abstract`-Filter plus
 * großzügiger Reserve bei `rows`.
 */

import type { FetchOptions, Source, Study, StudyDesign, Topic } from '../types.js';

const API_URL = 'https://api.crossref.org/works';
const MAILTO = 'valentin@valro.de';
const TIMEOUT_MS = 25_000;
const MIN_ABSTRACT_CHARS = 200;

/** Nur die Felder anfordern, die wir wirklich abbilden — spart spürbar Payload. */
const SELECT_FIELDS = [
  'DOI',
  'title',
  'abstract',
  'author',
  'container-title',
  'issued',
  'published',
  'is-referenced-by-count',
  'URL',
  'type',
  'license',
].join(',');

const TOPIC_QUERIES: Record<Topic, string> = {
  sleep: 'sleep duration sleep quality insomnia circadian rhythm',
  productivity: 'work productivity focus attention cognitive performance workplace',
  body: 'physical activity exercise nutrition metabolic health cardiovascular',
  economics: 'behavioral economics labor market incentives household finance',
  psychology: 'psychology behaviour motivation decision making well-being',
  learning: 'retrieval practice spaced repetition memory consolidation learning',
  environment: 'air pollution noise exposure ambient temperature green space',
  nutrition: 'dietary pattern ultra-processed food sugar intake fasting nutrition',
  time: 'commuting time use urban environment active travel working time',
  relationships: 'social isolation loneliness social support social connection',
};

const TOPIC_HINTS: Record<Topic, RegExp> = {
  sleep: /\bsleep|insomnia|circadian|nap\b|shift work/i,
  productivity: /\bproductivit|performance|focus|attention|workplace|task|work from home|multitask/i,
  body: /\bexercise|physical activity|nutrition|diet|obesity|cardiovascular|metabolic|muscle|mortality/i,
  economics: /\beconomic|labor market|labour market|income|wage|price|incentive|market|financial/i,
  psychology: /\bpsycholog|behaviour|behavior|cognitive|emotion|motivat|depress|anxiety|well-being|wellbeing|stress/i,
  learning: /\blearn|memory|recall|retrieval|practice|education|academic|skill acquisition|training/i,
  environment: /\bpollut|particulate|noise|ambient temperature|heat exposure|green space|daylight|air quality|environmental/i,
  nutrition: /\bdiet|nutrition|food|eating|sugar|protein|fibre|fiber|fasting|vitamin|supplement/i,
  time: /\bcommut|time use|urban|city|cities|travel|transport|working time|leisure|neighbourhood|neighborhood/i,
  relationships: /\bloneli|social isolation|social support|social connection|marriage|marital|friendship|social network|relationship/i,
};

interface CrossrefItem {
  DOI?: string;
  title?: string[];
  abstract?: string;
  author?: { given?: string; family?: string; name?: string }[];
  'container-title'?: string[];
  issued?: { 'date-parts'?: (number | undefined)[][] };
  published?: { 'date-parts'?: (number | undefined)[][] };
  'is-referenced-by-count'?: number;
  URL?: string;
  type?: string;
  license?: { URL?: string }[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  deg: '°',
  plusmn: '±',
  times: '×',
  minus: '−',
  alpha: 'α',
  beta: 'β',
  micro: 'µ',
};

function fromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m: string, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * JATS-Abstracts sind verschachteltes XML. Zwischenüberschriften wie
 * "Objective"/"Methods" bleiben als Text erhalten, aber mit Doppelpunkt,
 * damit der Writer den Satzfluss nicht verliert.
 */
function cleanAbstract(raw: string | undefined): string {
  if (!raw) return '';
  let text = decodeEntities(raw);
  text = text.replace(/<jats:title>\s*([^<]*?)\s*<\/jats:title>/gi, (_m, inner: string) =>
    inner && !/^abstract$/i.test(inner.trim()) ? ` ${inner.trim().replace(/:$/, '')}: ` : ' ',
  );
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  return text.replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').trim();
}

function cleanTitle(raw: string | undefined): string {
  if (!raw) return '';
  return decodeEntities(decodeEntities(raw).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function deriveDesign(text: string): StudyDesign {
  const t = text.toLowerCase();
  if (/\bmeta-?analy/.test(t)) return 'meta-analysis';
  if (/\bsystematic (?:review|literature review)\b|\bscoping review\b/.test(t)) return 'systematic-review';
  if (/\brandomi[sz]ed[- ](?:controlled )?(?:clinical )?trial\b|\brcts?\b|\bdouble-blind\b|\bplacebo-controlled\b/.test(t)) {
    return 'rct';
  }
  if (/\bcohort\b|\blongitudinal\b|\bprospective(?:ly)? follow/.test(t)) return 'cohort';
  if (/\bcase[- ]control\b/.test(t)) return 'case-control';
  if (/\bcross-sectional\b/.test(t)) return 'cross-sectional';
  if (/\b(?:laboratory|lab|field|randomi[sz]ed|online) experiment\b|\bexperimental (?:study|design|evidence)\b|\bparticipants were assigned\b/.test(t)) {
    return 'experiment';
  }
  if (/\bsimulation model\b|\bagent-based model\b|\bmarkov model\b|\bmodelling study\b|\bmodeling study\b|\bcalibrated model\b/.test(t)) {
    return 'modelling';
  }
  if (/\bnarrative review\b|\bthis review\b|\bwe review\b|\bliterature review\b/.test(t)) return 'narrative-review';
  return 'unknown';
}

function extractSampleSize(text: string): number | undefined {
  const patterns = [
    /\bn\s*=\s*([\d.,]+)\s*(million|billion)?/i,
    /\b(?:total of|sample of|cohort of|included|enrolled|recruited|analy[sz]ed)\s+(?:more than\s+|over\s+|about\s+)?([\d.,]+)\s*(million|billion)?\s+(?:individuals|people|persons|patients|participants|subjects|adults|children|respondents|women|men|students|workers)/i,
    /\b([\d.,]+)\s*(million|billion)?\s+(?:individuals|people|persons|patients|participants|subjects|adults|children|respondents|women|men|students|workers)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const digits = match[1].replace(/,/g, '');
    let value = Number.parseFloat(digits);
    if (!Number.isFinite(value)) continue;
    const scale = match[2]?.toLowerCase();
    if (scale === 'million') value *= 1_000_000;
    if (scale === 'billion') value *= 1_000_000_000;
    value = Math.round(value);
    if (value >= 10 && value <= 500_000_000) return value;
  }
  return undefined;
}

function deriveTopics(text: string, primary: Topic): Topic[] {
  const topics = new Set<Topic>([primary]);
  for (const [topic, pattern] of Object.entries(TOPIC_HINTS) as [Topic, RegExp][]) {
    if (pattern.test(text)) topics.add(topic);
  }
  return [...topics];
}

/** Crossref liefert Datumsteile als [[jahr, monat, tag]] — Monat/Tag sind optional. */
function toIsoDate(parts: (number | undefined)[][] | undefined): { iso?: string; year?: number } {
  const first = parts?.[0];
  const year = first?.[0];
  if (typeof year !== 'number') return {};
  const month = typeof first?.[1] === 'number' ? first[1] : 1;
  const day = typeof first?.[2] === 'number' ? first[2] : 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { iso: `${year}-${pad(month)}-${pad(day)}`, year };
}

function normalizeDoi(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const doi = raw.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
  return doi.startsWith('10.') ? doi : undefined;
}

/**
 * Crossref drosselt Bursts mit 503. Zwei Nachschläge mit wachsender Pause
 * reichen erfahrungsgemäß; das Zeitbudget deckelt ohnehin `signal`.
 */
async function fetchWithRetry(url: string, signal: AbortSignal): Promise<Response> {
  const headers = {
    accept: 'application/json',
    'user-agent': `valro-briefing/1.0 (mailto:${MAILTO})`,
  };
  const backoffs = [1_000, 3_000];
  let res = await fetch(url, { signal, headers });
  for (const wait of backoffs) {
    if (res.status < 500) return res;
    const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    const delay = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 5_000) : wait;
    await new Promise((resolve) => setTimeout(resolve, delay));
    res = await fetch(url, { signal, headers });
  }
  return res;
}

export const crossrefSource: Source = {
  id: 'crossref',
  label: 'Crossref',

  async fetch(opts: FetchOptions): Promise<Study[]> {
    const signal = opts.signal ?? AbortSignal.timeout(TIMEOUT_MS);
    const since = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString().slice(0, 10);
    // Reserve, weil viele Treffer am Abstract-Mindestmaß scheitern.
    const rows = Math.min(100, Math.max(20, opts.limit * 3));

    const params = new URLSearchParams({
      'query.bibliographic': TOPIC_QUERIES[opts.topic],
      filter: `from-pub-date:${since},type:journal-article,has-abstract:true`,
      rows: String(rows),
      select: SELECT_FIELDS,
      mailto: MAILTO,
    });

    const res = await fetchWithRetry(`${API_URL}?${params.toString()}`, signal);
    if (res.status === 429) {
      throw new Error('Crossref: Rate Limit (HTTP 429) — später erneut versuchen');
    }
    if (!res.ok) {
      throw new Error(`Crossref: HTTP ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as { status?: string; message?: { items?: CrossrefItem[] } };
    if (body.status && body.status !== 'ok') {
      throw new Error(`Crossref: API-Status "${body.status}"`);
    }

    const items = body.message?.items ?? [];
    const studies: Study[] = [];

    for (const item of items) {
      const abstract = cleanAbstract(item.abstract);
      if (abstract.length < MIN_ABSTRACT_CHARS) continue;

      const title = cleanTitle(item.title?.[0]);
      if (!title) continue;

      const doi = normalizeDoi(item.DOI);
      const dates = toIsoDate(item.published?.['date-parts'] ?? item.issued?.['date-parts']);

      const authors = (item.author ?? [])
        .map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' '))
        .map((a) => a.trim())
        .filter((a) => a.length > 0);

      const haystack = `${title} ${abstract}`;
      const licenses = item.license ?? [];

      studies.push({
        id: doi ?? `crossref:${item.DOI ?? item.URL ?? title}`,
        doi,
        title,
        abstract,
        authors,
        journal: cleanTitle(item['container-title']?.[0]) || undefined,
        year: dates.year,
        publishedAt: dates.iso,
        url: item.URL ?? (doi ? `https://doi.org/${doi}` : API_URL),
        source: 'crossref',
        topics: deriveTopics(haystack, opts.topic),
        design: deriveDesign(haystack),
        sampleSize: extractSampleSize(haystack),
        citationCount: typeof item['is-referenced-by-count'] === 'number' ? item['is-referenced-by-count'] : undefined,
        isPreprint: item.type === 'posted-content',
        // Crossref kennt keinen OA-Status; eine CC-Lizenz ist der einzige belastbare Hinweis.
        isOpenAccess: licenses.some((l) => /creativecommons\.org/i.test(l.URL ?? '')) ? true : undefined,
      });

      if (studies.length >= opts.limit) break;
    }

    return studies;
  },
};
