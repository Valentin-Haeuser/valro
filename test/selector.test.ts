import test from 'node:test';
import assert from 'node:assert/strict';
import type { CredibilityScore, History, ScoredStudy, Study } from '../src/types.js';
import { dedupe, select } from '../src/select/selector.js';
import { keywordsOf } from '../src/select/history.js';

/**
 * Realistische Abstracts, kein Füllmaterial: Die Auswahl prüft inzwischen
 * Themenzugehörigkeit und Alltagsrelevanz am Text. Mit 'x'.repeat(400) würde
 * jeder Kandidat aussortiert, und die Tests würden das Gegenteil dessen
 * belegen, was sie belegen sollen.
 */
const SLEEP_ABSTRACT =
  'Short sleep duration has been linked to cardiovascular risk in observational research. ' +
  'We pooled 41 prospective cohort studies covering adults from twelve countries to estimate ' +
  'the association between habitual sleep duration and incident cardiovascular disease. ' +
  'Participants sleeping fewer than six hours per night showed higher risk than those sleeping ' +
  'seven to eight hours. Physical activity and diet were treated as covariates throughout.';

const PSYCH_ABSTRACT =
  'Procrastination is common and has been conceptualised as a byproduct of impulsivity. ' +
  'We examined whether nonplanning impulsivity predicts later procrastination, and tested ' +
  'the shared behavioural basis of both traits across three adult samples. Measures of ' +
  'self-control and decision making were collected at each wave, alongside perceived stress ' +
  'and weekly working hours.';

function study(over: Partial<Study> = {}): Study {
  return {
    id: over.doi ?? 'europepmc:1',
    title: 'Sleep duration and cardiovascular risk: a meta-analysis',
    abstract: SLEEP_ABSTRACT,
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
  const fresh1 = study({
    id: 'europepmc:2',
    doi: '10.1/f1',
    title: 'Daytime napping and memory consolidation in healthy adults',
  });
  const fresh2 = study({
    id: 'europepmc:3',
    doi: '10.1/f2',
    title: 'Caffeine timing, sleep quality and sustained attention',
  });

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
    title: 'Nonplanning impulsivity and procrastination: a behavioural replication',
    topics: ['psychology'],
    abstract: PSYCH_ABSTRACT,
  });
  const otherSubject = study({
    id: 'europepmc:3',
    doi: '10.1/other',
    title: 'Bilingualism and cognitive attention control in older adults',
    topics: ['psychology'],
    abstract:
      'Bilingual experience has been proposed to sharpen attention control. We compared ' +
      'monolingual and bilingual adults on measures of memory, attention and decision making ' +
      'to test whether everyday language switching carries over into general cognitive control.',
  });
  const thirdSubject = study({
    id: 'europepmc:4',
    doi: '10.1/third',
    title: 'Loneliness, stress and mood across the lifespan',
    topics: ['psychology'],
    abstract:
      'Loneliness is associated with poorer wellbeing. We tracked social contact, perceived ' +
      'stress and mood in a general adult population sample over four years to describe how ' +
      'everyday social behaviour relates to emotional health.',
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
    abstract: PSYCH_ABSTRACT,
  });
  const filler = study({
    id: 'europepmc:3',
    doi: '10.1/x',
    title: 'Loneliness, mood and everyday social contact',
    topics: ['psychology'],
    abstract:
      'We examined how everyday social contact relates to mood and perceived stress in a ' +
      'general adult population, using repeated behavioural and wellbeing measures.',
  });

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
