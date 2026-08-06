/**
 * Europe PMC — Volltextsuche über MEDLINE, PMC, Agricola und Preprint-Server.
 * Kein API-Key nötig. `resultType=core` liefert das Abstract gleich mit,
 * damit kein zweiter Roundtrip pro Treffer nötig ist.
 */

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
  requestJson,
  sinceIsoDate,
  toArray,
} from './_shared';

const SEARCH_URL = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';
const MAX_PAGE_SIZE = 100;

interface EpmcAuthor {
  fullName?: string;
  firstName?: string;
  lastName?: string;
}

interface EpmcResult {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  authorList?: { author?: EpmcAuthor[] };
  journalInfo?: {
    journal?: { title?: string; isoabbreviation?: string };
    yearOfPublication?: number;
  };
  pubYear?: string;
  abstractText?: string;
  pubTypeList?: { pubType?: string[] | string };
  citedByCount?: number;
  isOpenAccess?: string;
  firstPublicationDate?: string;
}

interface EpmcSearchResponse {
  hitCount?: number;
  resultList?: { result?: EpmcResult[] };
}

/**
 * Offene Obergrenze (`TO *`) statt "bis heute": Zeitschriften vergeben
 * Ausgabendaten in der Zukunft, ein harter oberer Rand würde genau die
 * frischesten Arbeiten wegfiltern.
 */
function buildQuery(topic: Topic, sinceDays: number): string {
  const terms = TOPIC_TERMS[topic].map((term) => `TITLE_ABS:"${term}"`).join(' OR ');
  const pubTypes = QUALITY_PUB_TYPES.map((type) => `PUB_TYPE:"${type}"`).join(' OR ');

  return [
    `(${terms})`,
    `AND (${pubTypes})`,
    'AND HAS_ABSTRACT:Y',
    'AND LANG:"eng"',
    `AND FIRST_PDATE:[${sinceIsoDate(sinceDays)} TO *]`,
    'NOT PUB_TYPE:"Retracted Publication"',
    'NOT PUB_TYPE:"Comment"',
  ].join(' ');
}

function authorsOf(result: EpmcResult): string[] {
  const listed = toArray(result.authorList?.author)
    .map((author) => author.fullName ?? [author.firstName, author.lastName].filter(Boolean).join(' '))
    .map((name) => name.trim())
    .filter(Boolean);
  if (listed.length > 0) return listed;

  return (result.authorString ?? '')
    .split(',')
    .map((name) => name.trim().replace(/\.$/, ''))
    .filter(Boolean);
}

function toStudy(result: EpmcResult, topic: Topic): Study | undefined {
  const nativeId = result.id?.trim();
  const title = cleanText(result.title ?? '');
  const abstract = cleanText(result.abstractText ?? '');
  if (!nativeId || !title || !hasUsableAbstract(abstract)) return undefined;

  const doi = normalizeDoi(result.doi);
  const pubTypes = toArray(result.pubTypeList?.pubType);
  const archive = (result.source ?? 'MED').toUpperCase();
  const year = Number.parseInt(result.pubYear ?? '', 10);

  return {
    id: buildStudyId('europepmc', nativeId, doi),
    doi,
    title,
    abstract,
    authors: authorsOf(result),
    journal: result.journalInfo?.journal?.title ?? result.journalInfo?.journal?.isoabbreviation,
    year: Number.isInteger(year) ? year : result.journalInfo?.yearOfPublication,
    publishedAt: result.firstPublicationDate,
    url: `https://europepmc.org/article/${archive}/${nativeId}`,
    source: 'europepmc',
    topics: [topic],
    design: inferDesign({ pubTypes, title, abstract }),
    sampleSize: extractSampleSize(title, abstract),
    citationCount: typeof result.citedByCount === 'number' ? result.citedByCount : undefined,
    // PPR ist der Preprint-Bestand von Europe PMC (bioRxiv, medRxiv, Research Square …)
    isPreprint: archive === 'PPR' || pubTypes.some((type) => type.toLowerCase() === 'preprint'),
    isOpenAccess:
      result.isOpenAccess === 'Y' ? true : result.isOpenAccess === 'N' ? false : undefined,
  };
}

export const europePmcSource: Source = {
  id: 'europepmc',
  label: 'Europe PMC',

  async fetch(opts: FetchOptions): Promise<Study[]> {
    const limit = Math.max(1, Math.floor(opts.limit));
    // Großzügig überabfragen: ein Teil der Treffer fällt gleich wieder
    // wegen zu kurzem Abstract raus.
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(25, limit * 3));

    const url = new URL(SEARCH_URL);
    url.searchParams.set('query', buildQuery(opts.topic, opts.sinceDays));
    url.searchParams.set('format', 'json');
    url.searchParams.set('resultType', 'core');
    url.searchParams.set('pageSize', String(pageSize));

    const payload = await requestJson<EpmcSearchResponse>(url, {
      label: 'Europe PMC',
      signal: opts.signal,
    });

    const sinceIso = sinceIsoDate(opts.sinceDays);
    const studies = toArray(payload.resultList?.result)
      .map((result) => toStudy(result, opts.topic))
      .filter((study): study is Study => study !== undefined && isWithinWindow(study.publishedAt, sinceIso));

    return dedupeById(studies).slice(0, limit);
  },
};
