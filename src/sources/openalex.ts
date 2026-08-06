/**
 * OpenAlex — Breitenabdeckung über alle fünf Themen, inklusive Zitationszahlen
 * und Open-Access-Status.
 *
 * Besonderheit: OpenAlex liefert Abstracts nicht als Text, sondern als
 * `abstract_inverted_index` (Wort → Positionen). Ohne Rückumwandlung hätten
 * wir gar kein Abstract — siehe `invertAbstract`.
 *
 * Der Endpunkt ist frei, aber budgetiert: 429/403 werden hier ausdrücklich
 * als solche gemeldet, damit die Pipeline sie von echten Bugs unterscheiden kann.
 */

import type { FetchOptions, Source, Study, StudyDesign, Topic } from '../types.js';

const API_URL = 'https://api.openalex.org/works';
const MAILTO = 'valentin@valro.de';
const TIMEOUT_MS = 25_000;
const MIN_ABSTRACT_CHARS = 200;

/** Ab diesem Zeitfenster hatten Arbeiten realistisch Zeit, zitiert zu werden. */
const CITATION_FILTER_MIN_DAYS = 120;

const TOPIC_SEARCH: Record<Topic, string> = {
  sleep: 'sleep duration sleep quality insomnia circadian',
  productivity: 'productivity focus attention cognitive performance workplace',
  body: 'physical activity exercise nutrition metabolic health',
  economics: 'behavioral economics labor market incentives',
  psychology: 'psychology behaviour motivation decision making well-being',
};

const TOPIC_HINTS: Record<Topic, RegExp> = {
  sleep: /\bsleep|insomnia|circadian|nap\b|shift work/i,
  productivity: /\bproductivit|performance|focus|attention|workplace|task|work from home|multitask/i,
  body: /\bexercise|physical activity|nutrition|diet|obesity|cardiovascular|metabolic|muscle|mortality/i,
  economics: /\beconomic|labor market|labour market|income|wage|price|incentive|market|financial/i,
  psychology: /\bpsycholog|behaviour|behavior|cognitive|emotion|motivat|depress|anxiety|well-being|wellbeing|stress/i,
};

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number;
  publication_date?: string;
  cited_by_count?: number;
  abstract_inverted_index?: Record<string, number[]> | null;
  primary_location?: {
    source?: { display_name?: string | null; is_oa?: boolean } | null;
    version?: string | null;
    landing_page_url?: string | null;
  } | null;
  type?: string;
  authorships?: { author?: { display_name?: string | null } | null; raw_author_name?: string | null }[];
  open_access?: { is_oa?: boolean } | null;
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

function cleanText(raw: string | null | undefined): string {
  if (!raw) return '';
  return decodeEntities(decodeEntities(raw).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `{"Sleep": [0], "matters": [1]}` → "Sleep matters".
 * Positionen können sich überlappen oder Lücken haben; wir schreiben in ein
 * dünn besetztes Array und lassen leere Stellen beim Join einfach weg.
 */
function invertAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return '';
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      if (typeof pos !== 'number' || !Number.isInteger(pos) || pos < 0 || pos > 100_000) continue;
      words[pos] = word;
    }
  }
  const text = words.filter((w) => typeof w === 'string' && w.length > 0).join(' ');
  return cleanText(text);
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

function normalizeDoi(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const doi = raw.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '');
  return doi.startsWith('10.') ? doi : undefined;
}

/** "https://openalex.org/W2741809807" → "W2741809807" */
function nativeId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return id.split('/').pop() || undefined;
}

/** Nur 5xx wiederholen — 429/403 sind Kontingentgrenzen, da hilft kein Nachschlag. */
async function fetchWithRetry(url: string, signal: AbortSignal): Promise<Response> {
  const headers = {
    accept: 'application/json',
    'user-agent': `valro-briefing/1.0 (mailto:${MAILTO})`,
  };
  const res = await fetch(url, { signal, headers });
  if (res.status < 500) return res;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return fetch(url, { signal, headers });
}

export const openAlexSource: Source = {
  id: 'openalex',
  label: 'OpenAlex',

  async fetch(opts: FetchOptions): Promise<Study[]> {
    const signal = opts.signal ?? AbortSignal.timeout(TIMEOUT_MS);
    const since = new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString().slice(0, 10);

    const filters = [
      `from_publication_date:${since}`,
      'type:article',
      'has_abstract:true',
      'is_paratext:false',
      'language:en',
    ];
    // Bei frischen Fenstern wäre ein Zitations-Filter tödlich — neue Arbeiten
    // haben schlicht noch keine Zitate.
    if (opts.sinceDays >= CITATION_FILTER_MIN_DAYS) filters.push('cited_by_count:>0');

    const params = new URLSearchParams({
      filter: filters.join(','),
      search: TOPIC_SEARCH[opts.topic],
      // Reserve, weil Treffer am Abstract-Mindestmaß scheitern können.
      'per-page': String(Math.min(200, Math.max(25, opts.limit * 3))),
      mailto: MAILTO,
    });

    const res = await fetchWithRetry(`${API_URL}?${params.toString()}`, signal);

    if (res.status === 429 || res.status === 403) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(
        `OpenAlex: Rate Limit / Zugriff verweigert (HTTP ${res.status}). ` +
          `Kein Code-Fehler — Kontingent erschöpft oder Proxy blockt. Antwort: ${detail}`,
      );
    }
    if (!res.ok) {
      throw new Error(`OpenAlex: HTTP ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as { results?: OpenAlexWork[]; error?: string; message?: string };
    // OpenAlex meldet Budget-Fehler teils mit HTTP 200 und Fehlerobjekt.
    if (body.error) {
      throw new Error(`OpenAlex: API-Fehler "${body.error}"${body.message ? ` — ${body.message}` : ''}`);
    }

    const results = body.results ?? [];
    const studies: Study[] = [];

    for (const work of results) {
      const abstract = invertAbstract(work.abstract_inverted_index);
      if (abstract.length < MIN_ABSTRACT_CHARS) continue;

      const title = cleanText(work.title ?? work.display_name);
      if (!title) continue;

      const doi = normalizeDoi(work.doi);
      const native = nativeId(work.id);
      const haystack = `${title} ${abstract}`;

      const authors = (work.authorships ?? [])
        .map((a) => cleanText(a.author?.display_name ?? a.raw_author_name))
        .filter((a) => a.length > 0);

      const url =
        work.primary_location?.landing_page_url ??
        (doi ? `https://doi.org/${doi}` : work.id ?? API_URL);

      studies.push({
        id: doi ?? `openalex:${native ?? title}`,
        doi,
        title,
        abstract,
        authors,
        journal: cleanText(work.primary_location?.source?.display_name) || undefined,
        year: typeof work.publication_year === 'number' ? work.publication_year : undefined,
        publishedAt: work.publication_date,
        url,
        source: 'openalex',
        topics: deriveTopics(haystack, opts.topic),
        design: deriveDesign(haystack),
        sampleSize: extractSampleSize(haystack),
        citationCount: typeof work.cited_by_count === 'number' ? work.cited_by_count : undefined,
        isPreprint: work.type === 'preprint' || work.primary_location?.version === 'submittedVersion',
        isOpenAccess: typeof work.open_access?.is_oa === 'boolean' ? work.open_access.is_oa : undefined,
      });

      if (studies.length >= opts.limit) break;
    }

    return studies;
  },
};
