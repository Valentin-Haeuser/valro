/**
 * PubMed über die NCBI E-utilities: `esearch` liefert PMIDs,
 * `efetch` das vollständige MEDLINE-XML inklusive Abstract und
 * Publikationstypen. Kein API-Key nötig, dafür ein enges Ratenlimit.
 */

import { XMLParser } from 'fast-xml-parser';

import type { FetchOptions, Source, Study, Topic } from '../types';
import {
  QUALITY_PUB_TYPES,
  TOPIC_TERMS,
  buildStudyId,
  cleanText,
  dedupeById,
  extractSampleSize,
  hasUsableAbstract,
  inferDesign,
  isWithinWindow,
  normalizeDoi,
  requestText,
  sinceIsoDate,
  sleep,
  toArray,
} from './_shared';

const ESEARCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const EFETCH_URL = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

/** NCBI erlaubt ohne API-Key 3 Anfragen/Sekunde; 380 ms lassen etwas Luft. */
const MIN_REQUEST_GAP_MS = 380;

let ncbiChain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

/**
 * Serialisiert *alle* NCBI-Aufrufe des Prozesses. Die Pipeline darf mehrere
 * Themen parallel abrufen — ohne gemeinsame Schlange reißt das sofort das Limit.
 */
function throttled<T>(task: () => Promise<T>): Promise<T> {
  const run = ncbiChain.then(async () => {
    const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return task();
  });
  ncbiChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Von NCBI gefordert, damit sie bei Auffälligkeiten jemanden anschreiben können. */
function eutilsUrl(base: string, params: Record<string, string>): URL {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('tool', 'valro-briefing');
  url.searchParams.set('email', 'valentin@valro.de');
  return url;
}

function buildTerm(topic: Topic): string {
  const terms = TOPIC_TERMS[topic].map((term) => `"${term}"[tiab]`).join(' OR ');
  const pubTypes = QUALITY_PUB_TYPES.map((type) => `"${type}"[pt]`).join(' OR ');

  return [
    `(${terms})`,
    `AND (${pubTypes})`,
    'AND hasabstract',
    'AND english[la]',
    'NOT ("retracted publication"[pt] OR "comment"[pt] OR "editorial"[pt])',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

/**
 * `stopNodes` gibt Titel und Abstract als rohes XML zurück, statt Inline-Tags
 * (`<i>`, `<sup>`) in Kindknoten zu zerlegen — dabei ginge die Wortreihenfolge
 * verloren. Das Aufräumen macht `cleanText` einheitlich für beide Quellen.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  stopNodes: ['*.ArticleTitle', '*.AbstractText', '*.VernacularTitle'],
});

type XmlValue = unknown;

function node(value: XmlValue, key: string): XmlValue {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function textOf(value: XmlValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(' ');
  return textOf((value as Record<string, unknown>)['#text']);
}

function attr(value: XmlValue, name: string): string {
  return textOf(node(value, `@_${name}`));
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function isoDate(dateNode: XmlValue): string | undefined {
  const year = textOf(node(dateNode, 'Year')).trim();
  if (!/^\d{4}$/.test(year)) return undefined;

  const rawMonth = textOf(node(dateNode, 'Month')).trim().toLowerCase();
  const month = MONTHS[rawMonth.slice(0, 3)] ?? (/^\d{1,2}$/.test(rawMonth) ? rawMonth.padStart(2, '0') : undefined);
  if (!month) return `${year}-01-01`;

  const rawDay = textOf(node(dateNode, 'Day')).trim();
  const day = /^\d{1,2}$/.test(rawDay) ? rawDay.padStart(2, '0') : '01';
  return `${year}-${month}-${day}`;
}

function articleIds(article: XmlValue): Map<string, string> {
  const ids = new Map<string, string>();
  const fromIdList = toArray(node(node(article, 'PubmedData'), 'ArticleIdList'))
    .flatMap((list) => toArray(node(list, 'ArticleId')));
  for (const id of fromIdList) {
    const type = attr(id, 'IdType').toLowerCase();
    if (type && !ids.has(type)) ids.set(type, textOf(id).trim());
  }

  const citation = node(article, 'MedlineCitation');
  for (const eloc of toArray(node(node(citation, 'Article'), 'ELocationID'))) {
    const type = attr(eloc, 'EIdType').toLowerCase();
    if (type && !ids.has(type)) ids.set(type, textOf(eloc).trim());
  }
  return ids;
}

function abstractOf(articleNode: XmlValue): string {
  const parts = toArray(node(node(articleNode, 'Abstract'), 'AbstractText'))
    .map((part) => cleanText(textOf(part)))
    .filter(Boolean);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function authorsOf(articleNode: XmlValue): string[] {
  return toArray(node(node(articleNode, 'AuthorList'), 'Author'))
    .map((author) => {
      const collective = cleanText(textOf(node(author, 'CollectiveName')));
      if (collective) return collective;
      const last = cleanText(textOf(node(author, 'LastName')));
      const fore =
        cleanText(textOf(node(author, 'ForeName'))) || cleanText(textOf(node(author, 'Initials')));
      return [fore, last].filter(Boolean).join(' ');
    })
    .filter(Boolean);
}

function toStudy(article: XmlValue, topic: Topic): Study | undefined {
  const citation = node(article, 'MedlineCitation');
  const articleNode = node(citation, 'Article');
  const pmid = textOf(node(citation, 'PMID')).trim();

  const title = cleanText(textOf(node(articleNode, 'ArticleTitle')));
  const abstract = abstractOf(articleNode);
  if (!pmid || !title || !hasUsableAbstract(abstract)) return undefined;

  const ids = articleIds(article);
  const doi = normalizeDoi(ids.get('doi'));

  const pubTypes = toArray(node(node(articleNode, 'PublicationTypeList'), 'PublicationType'))
    .map((type) => textOf(type).trim())
    .filter(Boolean);

  const journalNode = node(articleNode, 'Journal');
  const pubDate = node(node(journalNode, 'JournalIssue'), 'PubDate');
  // ArticleDate ist das elektronische Erstveröffentlichungsdatum und damit
  // genauer als das oft nur monatsgenaue Heftdatum.
  const publishedAt = isoDate(toArray(node(articleNode, 'ArticleDate'))[0]) ?? isoDate(pubDate);
  const year = Number.parseInt(publishedAt?.slice(0, 4) ?? textOf(node(pubDate, 'MedlineDate')).slice(0, 4), 10);

  return {
    id: buildStudyId('pubmed', pmid, doi),
    doi,
    title,
    abstract,
    authors: authorsOf(articleNode),
    journal:
      cleanText(textOf(node(journalNode, 'Title'))) ||
      cleanText(textOf(node(journalNode, 'ISOAbbreviation'))) ||
      undefined,
    year: Number.isInteger(year) ? year : undefined,
    publishedAt,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    source: 'pubmed',
    topics: [topic],
    design: inferDesign({ pubTypes, title, abstract }),
    sampleSize: extractSampleSize(title, abstract),
    // Zitationszahlen und Open-Access-Status liefert PubMed nicht — lieber
    // undefined lassen, als sie aus der PMC-ID zu erfinden.
    isPreprint: pubTypes.some((type) => type.toLowerCase() === 'preprint'),
  };
}

// ---------------------------------------------------------------------------
// Abruf
// ---------------------------------------------------------------------------

interface ESearchResponse {
  esearchresult?: { idlist?: string[]; ERROR?: string };
  ERROR?: string;
}

async function searchIds(opts: FetchOptions): Promise<string[]> {
  const sinceDays = Number.isFinite(opts.sinceDays) && opts.sinceDays > 0 ? Math.floor(opts.sinceDays) : 1;
  const limit = Math.max(1, Math.floor(opts.limit));

  const url = eutilsUrl(ESEARCH_URL, {
    db: 'pubmed',
    retmode: 'json',
    term: buildTerm(opts.topic),
    // reldate + datetype filtern serverseitig aufs Publikationsdatum
    datetype: 'pdat',
    reldate: String(sinceDays),
    sort: 'relevance',
    retmax: String(Math.min(200, Math.max(25, limit * 3))),
  });

  const body = await throttled(() => requestText(url, { label: 'PubMed esearch', signal: opts.signal }));
  let payload: ESearchResponse;
  try {
    payload = JSON.parse(body) as ESearchResponse;
  } catch {
    throw new Error('PubMed esearch: Antwort war kein gültiges JSON');
  }

  const error = payload.esearchresult?.ERROR ?? payload.ERROR;
  if (error) throw new Error(`PubMed esearch: ${error}`);

  return toArray(payload.esearchresult?.idlist).filter((id) => /^\d+$/.test(id));
}

async function fetchArticles(ids: string[], opts: FetchOptions): Promise<XmlValue[]> {
  const url = eutilsUrl(EFETCH_URL, {
    db: 'pubmed',
    retmode: 'xml',
    rettype: 'abstract',
    id: ids.join(','),
  });

  const xml = await throttled(() =>
    requestText(url, { label: 'PubMed efetch', signal: opts.signal, accept: 'application/xml' }),
  );
  const parsed = parser.parse(xml) as Record<string, unknown>;
  return toArray(node(parsed['PubmedArticleSet'], 'PubmedArticle'));
}

export const pubmedSource: Source = {
  id: 'pubmed',
  label: 'PubMed',

  async fetch(opts: FetchOptions): Promise<Study[]> {
    const limit = Math.max(1, Math.floor(opts.limit));
    const ids = await searchIds(opts);
    if (ids.length === 0) return [];

    const articles = await fetchArticles(ids, opts);
    const sinceIso = sinceIsoDate(opts.sinceDays);
    const studies = articles
      .map((article) => toStudy(article, opts.topic))
      .filter((study): study is Study => study !== undefined && isWithinWindow(study.publishedAt, sinceIso));

    return dedupeById(studies).slice(0, limit);
  },
};
