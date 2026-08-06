import test from 'node:test';
import assert from 'node:assert/strict';
import type { CredibilityScore, History, ScoredStudy, Study } from '../src/types.js';
import { dedupe, select } from '../src/select/selector.js';
import { keywordsOf } from '../src/select/history.js';

function study(over: Partial<Study> = {}): Study {
  return {
    id: over.doi ?? 'europepmc:1',
    title: 'Sleep duration and cardiovascular risk: a meta-analysis',
    abstract: 'x'.repeat(400),
    authors: ['A. Autor'],
    journal: 'Sleep',
    year: 2026,
    url: 'https://example.org/1',
    source: 'europepmc',
    topics: ['sleep'],
    design: 'meta-analysis',
    isPreprint: false,
    ...over,
  };
}

function score(total: number, over: Partial<CredibilityScore> = {}): CredibilityScore {
  return {
    total,
    breakdown: { design: 0, sampleSize: 0, citations: 0, venue: 0, recency: 0, replication: 0 },
    evidenceLabel: 'Metaanalyse',
    reasons: [],
    rejected: false,
    ...over,
  };
}

const scored = (s: Study, total: number): ScoredStudy => ({ study: s, score: score(total) });

const EMPTY: History = { entries: [] };

test('dedupe führt dieselbe DOI aus zwei Quellen zusammen', () => {
  const a = study({ id: 'europepmc:1', doi: '10.1/abc', abstract: 'kurz'.repeat(60) });
  const b = study({ id: 'crossref:9', doi: '10.1/ABC', abstract: 'lang'.repeat(200) });
  const out = dedupe([a, b]);
  assert.equal(out.length, 1);
  // Der Datensatz mit dem längeren Abstract gewinnt — davon lebt der Writer.
  assert.equal(out[0]!.abstract.length, b.abstract.length);
});

test('bereits verschickte Studien werden nie erneut ausgewählt', () => {
  const used = study({ id: 'europepmc:1', doi: '10.1/used' });
  const fresh1 = study({ id: 'europepmc:2', doi: '10.1/f1', title: 'Napping and memory consolidation' });
  const fresh2 = study({ id: 'europepmc:3', doi: '10.1/f2', title: 'Caffeine timing and alertness' });

  const history: History = {
    entries: [
      {
        id: 'europepmc:1',
        doi: '10.1/used',
        date: '2026-08-01',
        topic: 'sleep',
        title: used.title,
        role: 'lead',
        keywords: keywordsOf(used.title),
      },
    ],
  };

  const sel = select(
    [scored(used, 95), scored(fresh1, 90), scored(fresh2, 80)],
    history,
    'sleep',
    new Date('2026-08-07'),
  );
  assert.ok(sel);
  assert.notEqual(sel.lead.study.id, 'europepmc:1');
  assert.ok(!sel.shorts.some((s) => s.study.id === 'europepmc:1'));
});

test('Themensperre blockt eine zweite Studie zum selben Gegenstand', () => {
  const history: History = {
    entries: [
      {
        id: 'europepmc:1',
        date: '2026-08-01',
        topic: 'psychology',
        title: 'Shared neurogenetic substrates of nonplanning impulsivity and procrastination',
        role: 'lead',
        keywords: keywordsOf(
          'Shared neurogenetic substrates of nonplanning impulsivity and procrastination',
        ),
      },
    ],
  };

  const sameSubject = study({
    id: 'europepmc:2',
    doi: '10.1/again',
    title: 'Nonplanning impulsivity and procrastination: a neurogenetic replication',
    topics: ['psychology'],
  });
  const otherSubject = study({
    id: 'europepmc:3',
    doi: '10.1/other',
    title: 'Bilingualism and executive attention in older adults',
    topics: ['psychology'],
  });
  const thirdSubject = study({
    id: 'europepmc:4',
    doi: '10.1/third',
    title: 'Loneliness and inflammatory markers across the lifespan',
    topics: ['psychology'],
  });

  const sel = select(
    [scored(sameSubject, 95), scored(otherSubject, 88), scored(thirdSubject, 80)],
    history,
    'psychology',
    new Date('2026-08-07'),
  );

  assert.ok(sel);
  const picked = [sel.lead, ...sel.shorts].map((s) => s.study.id);
  assert.ok(!picked.includes('europepmc:2'), 'gleiches Thema hätte gesperrt sein müssen');
});

test('nach Ablauf der Sperrfrist ist das Thema wieder frei', () => {
  const history: History = {
    entries: [
      {
        id: 'europepmc:1',
        date: '2026-01-01', // weit vor der 42-Tage-Frist
        topic: 'psychology',
        title: 'Nonplanning impulsivity and procrastination',
        role: 'lead',
        keywords: keywordsOf('Nonplanning impulsivity and procrastination'),
      },
    ],
  };

  const sameSubject = study({
    id: 'europepmc:2',
    doi: '10.1/again',
    title: 'Nonplanning impulsivity and procrastination: a replication',
    topics: ['psychology'],
  });
  const filler = study({ id: 'europepmc:3', doi: '10.1/x', title: 'Loneliness and inflammation' });

  const sel = select(
    [scored(sameSubject, 95), scored(filler, 80)],
    history,
    'psychology',
    new Date('2026-08-07'),
  );
  assert.ok(sel);
  assert.equal(sel.lead.study.id, 'europepmc:2');
});

test('Stichwörter ignorieren Methoden-Floskeln', () => {
  // "systematic review and meta-analysis" steht in jedem zweiten Titel und darf
  // deshalb keine Themengleichheit begründen.
  const a = keywordsOf('A systematic review and meta-analysis of vitamin D and mortality');
  const b = keywordsOf('A systematic review and meta-analysis of screen time and myopia');
  const shared = a.filter((w) => b.includes(w));
  assert.deepEqual(shared, []);
});

test('ohne genügend Material wird lieber nichts verschickt', () => {
  const weak = study({ id: 'europepmc:9', doi: '10.1/weak' });
  assert.equal(select([scored(weak, 30)], EMPTY, 'sleep', new Date('2026-08-07')), null);
});
