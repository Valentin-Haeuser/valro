/**
 * NBER Working Papers — unsere primäre Wirtschaftsquelle.
 *
 * Der Feed `new.xml` enthält ausschließlich den aktuellen Veröffentlichungs-
 * Jahrgang (NBER gibt wöchentlich, montags, eine Charge frei). Er trägt keine
 * `pubDate`-Elemente, deshalb leiten wir das Erscheinungsdatum aus dem
 * `Last-Modified`-Header ab — der entspricht bei diesem Feed exakt dem
 * Freigabetag der Charge.
 *
 * Working Papers durchlaufen kein Peer-Review → immer `isPreprint: true`.
 */

import { XMLParser } from 'fast-xml-parser';
import type { FetchOptions, Source, Study, StudyDesign, Topic } from '../types.js';

const FEED_URL = 'https://back.nber.org/rss/new.xml';
const TIMEOUT_MS = 20_000;
const MIN_ABSTRACT_CHARS = 200;

interface RssItem {
  title?: unknown;
  description?: unknown;
  link?: unknown;
  guid?: unknown;
}

/** Named Entities, die in NBER-Abstracts real vorkommen. */
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
  euro: '€',
  pound: '£',
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

/** Doppelt kodierte Markup-Reste kommen im Feed vor: erst dekodieren, dann Tags entfernen. */
function cleanText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let text = decodeEntities(raw);
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  return text.replace(/\s+/g, ' ').trim();
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Ökonomische Arbeitspapiere sind fast immer Modell- oder Schätzarbeiten.
 * Nur wenn das Abstract ein stärkeres Design ausdrücklich nennt, gewinnt das.
 */
function deriveDesign(text: string): StudyDesign {
  const t = text.toLowerCase();
  if (/\bmeta-?analy/.test(t)) return 'meta-analysis';
  if (/\bsystematic review\b/.test(t)) return 'systematic-review';
  if (/\brandomi[sz]ed controlled trial\b|\brcts?\b|\bplacebo-controlled\b/.test(t)) return 'rct';
  if (/\brandomi[sz]ed (?:field |lab(?:oratory)? |online )?experiment\b|\bfield experiment\b|\blab(?:oratory)? experiment\b|\bwe randomi[sz]e\b/.test(t)) {
    return 'experiment';
  }
  if (/\bcohort\b|\blongitudinal\b|\bpanel (?:data|survey)\b|\bfollow(?:ed|-up) (?:over|for)\b/.test(t)) return 'cohort';
  if (/\bcase-control\b/.test(t)) return 'case-control';
  if (/\bcross-sectional\b/.test(t)) return 'cross-sectional';
  if (/\bwe (?:survey|review) the literature\b|\bthis (?:paper )?review(?:s|ing)? (?:the )?(?:literature|evidence)\b|\bwe review\b/.test(t)) {
    return 'narrative-review';
  }
  return 'modelling';
}

/** Nur übernehmen, was plausibel eine Fallzahl ist — lieber nichts als eine falsche Zahl. */
function extractSampleSize(text: string): number | undefined {
  const patterns = [
    /\bN\s*=\s*([\d.,]+)\s*(million|billion)?/i,
    /\b(?:sample|dataset|data)\s+(?:of|on|covering)\s+(?:more than\s+|over\s+|about\s+|roughly\s+)?([\d.,]+)\s*(million|billion)?\s+(?:individuals|people|persons|workers|firms|households|students|patients|participants|respondents|adults|children)/i,
    /\b([\d.,]+)\s*(million|billion)?\s+(?:individuals|people|persons|workers|firms|households|students|patients|participants|respondents|adults|children)\b/i,
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
    if (value >= 20 && value <= 500_000_000) return value;
  }
  return undefined;
}

/** Nebenthemen, die NBER regelmäßig bedient — economics ist immer dabei. */
const TOPIC_HINTS: Record<Exclude<Topic, 'economics'>, RegExp> = {
  sleep: /\bsleep|insomnia|circadian|shift work|sleep deprivation/i,
  productivity: /\bproductivit|labor supply|hours worked|remote work|work from home|automation|human capital|management practice|training|education|attention|multitask/i,
  body: /\bhealth|mortality|obesity|nutrition|diet|medicare|medicaid|hospital|physician|disease|smoking|exercise|physical activity|insurance coverage|opioid|vaccin/i,
  psychology: /\bbehavioral|behaviour|belief|preference|cognitive|mental health|depression|anxiety|stress|motivat|bias|nudge|risk aversion|time preference|well-being|wellbeing/i,
};

function deriveTopics(text: string): Topic[] {
  const topics: Topic[] = ['economics'];
  for (const [topic, pattern] of Object.entries(TOPIC_HINTS) as [Topic, RegExp][]) {
    if (pattern.test(text)) topics.push(topic);
  }
  return topics;
}

/** "Titel -- by A, B and C" → Titel + Autorenliste. */
function splitTitleAndAuthors(raw: string): { title: string; authors: string[] } {
  const parts = raw.split(/\s+--\s+by\s+/i);
  if (parts.length < 2) return { title: raw.trim(), authors: [] };
  const authorPart = parts[parts.length - 1] ?? '';
  const title = parts.slice(0, -1).join(' -- by ').trim();
  const authors = authorPart
    .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
    .map((a) => a.trim())
    .filter((a) => a.length > 1);
  return { title, authors };
}

/** Aus /papers/w35538 wird die NBER-DOI 10.3386/w35538 — stabile Ableitung, kein Raten. */
function paperNumber(link: string): string | undefined {
  return /\/papers\/(w\d+)/i.exec(link)?.[1]?.toLowerCase();
}

function parseFeedDate(header: string | null): Date {
  if (header) {
    const parsed = new Date(header);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

/** Das CDN vor dem Feed wirft gelegentlich 5xx — ein Nachschlag genügt. */
async function fetchFeed(signal: AbortSignal): Promise<Response> {
  const headers = {
    accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
    'user-agent': 'valro-briefing/1.0 (mailto:valentin@valro.de)',
  };
  const res = await fetch(FEED_URL, { signal, headers });
  if (res.status < 500) return res;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return fetch(FEED_URL, { signal, headers });
}

export const nberSource: Source = {
  id: 'nber',
  label: 'NBER Working Papers',

  async fetch(opts: FetchOptions): Promise<Study[]> {
    const signal = opts.signal ?? AbortSignal.timeout(TIMEOUT_MS);

    const res = await fetchFeed(signal);
    if (!res.ok) {
      throw new Error(`NBER: HTTP ${res.status} ${res.statusText} für ${FEED_URL}`);
    }

    // Der Feed trägt kein Item-Datum; das Charge-Datum steckt im Header.
    const releasedAt = parseFeedDate(res.headers.get('last-modified'));
    const cutoff = Date.now() - opts.sinceDays * 86_400_000;
    if (releasedAt.getTime() < cutoff) return [];

    const xml = await res.text();
    const parser = new XMLParser({
      ignoreAttributes: true,
      trimValues: true,
      processEntities: true,
      parseTagValue: false,
    });

    let parsed: unknown;
    try {
      parsed = parser.parse(xml);
    } catch (err) {
      throw new Error(`NBER: RSS nicht parsebar — ${err instanceof Error ? err.message : String(err)}`);
    }

    const channel = (parsed as { rss?: { channel?: { item?: RssItem | RssItem[] } } })?.rss?.channel;
    const items = toArray(channel?.item);
    if (items.length === 0) {
      throw new Error('NBER: Feed enthält keine <item>-Elemente');
    }

    const publishedAt = releasedAt.toISOString().slice(0, 10);
    const year = releasedAt.getUTCFullYear();
    const studies: Study[] = [];

    for (const item of items) {
      const abstract = cleanText(item.description);
      if (abstract.length < MIN_ABSTRACT_CHARS) continue;

      const { title, authors } = splitTitleAndAuthors(cleanText(item.title));
      if (!title) continue;

      const url = cleanText(item.link) || cleanText(item.guid);
      const native = paperNumber(url);
      const doi = native ? `10.3386/${native}` : undefined;

      const haystack = `${title} ${abstract}`;
      const topics = deriveTopics(haystack);
      // economics bekommt die volle Charge; für Nebenthemen muss das Papier passen.
      if (opts.topic !== 'economics' && !topics.includes(opts.topic)) continue;

      studies.push({
        id: doi ?? `nber:${native ?? url}`,
        doi,
        title,
        abstract,
        authors,
        journal: 'NBER Working Paper Series',
        year,
        publishedAt,
        url: url || (native ? `https://www.nber.org/papers/${native}` : FEED_URL),
        source: 'nber',
        topics,
        design: deriveDesign(haystack),
        sampleSize: extractSampleSize(haystack),
        isPreprint: true,
        isOpenAccess: false,
      });

      if (studies.length >= opts.limit) break;
    }

    return studies;
  },
};
