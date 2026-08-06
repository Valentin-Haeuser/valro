import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Study, StudyDesign, Topic } from '../src/types';
import { CREDIBILITY_FLOOR, CREDIBILITY_THRESHOLD, scoreStudy } from '../src/scoring/credibility';
import { ZOMBIE_CLAIMS, explainZombieMatch, findZombieMatch } from '../src/scoring/zombies';

const THIS_YEAR = new Date().getUTCFullYear();

function makeStudy(overrides: Partial<Study> = {}): Study {
  const base: Study = {
    id: 'doi:10.0000/test',
    title: 'Sleep duration and cardiovascular outcomes',
    abstract:
      'We examined the association between habitual sleep duration and incident cardiovascular disease in a prospective cohort followed for twelve years.',
    authors: ['Musterfrau, A.'],
    journal: 'Sleep',
    year: THIS_YEAR - 2,
    url: 'https://example.org/study',
    source: 'europepmc',
    topics: ['sleep'] as Topic[],
    design: 'cohort' as StudyDesign,
    sampleSize: 12_000,
    citationCount: 40,
    isPreprint: false,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Zwanzig realistische, absolut unbedenkliche Arbeiten aus den fünf Themen-
// feldern. Wenn hier ein Zombie-Muster feuert, ist das Muster kaputt — nicht
// die Studie. Genau diese Fehlalarme sind der teuerste Fehler des Filters.
// ---------------------------------------------------------------------------
const LEGITIMATE_STUDIES: { title: string; abstract: string }[] = [
  {
    title: 'Sleep duration and incident cardiovascular disease: a prospective cohort study of 385,292 adults',
    abstract:
      'Participants reported habitual sleep duration at baseline. Both short (<6 h) and long (>9 h) sleep were associated with elevated risk of coronary events after adjustment for physical activity, smoking and body mass index.',
  },
  {
    title: 'Effect of evening screen use on sleep onset latency in adolescents: a randomised crossover trial',
    abstract:
      'Adolescents used a tablet or read a printed book for 90 minutes before bedtime. Objective sleep onset latency was measured by polysomnography. Screen use delayed sleep onset by a mean of 9 minutes; light intensity did not explain the difference, suggesting that content and arousal matter more than the spectral composition of the display.',
  },
  {
    title: 'Cognitive behavioural therapy for insomnia delivered digitally: a systematic review and meta-analysis',
    abstract:
      'We pooled 32 randomised controlled trials comprising 9,412 adults with chronic insomnia. Digital CBT-I improved insomnia severity relative to waitlist and to sleep hygiene education, with effects maintained at six months.',
  },
  {
    title: 'Chronotype, social jetlag and academic performance in university students',
    abstract:
      'Using wrist actigraphy over four weeks, we quantified the discrepancy between biological and social sleep timing. Larger social jetlag predicted lower examination grades independently of total sleep time.',
  },
  {
    title: 'Napping and blood pressure: a Mendelian randomisation analysis in the UK Biobank',
    abstract:
      'Genetic instruments for daytime napping were associated with higher systolic blood pressure, supporting a causal interpretation of previously reported observational associations.',
  },
  {
    title: 'Physical activity volume and all-cause mortality: harmonised meta-analysis of accelerometer data from nine cohorts',
    abstract:
      'Among 44,370 participants wearing accelerometers, higher daily step counts were associated with lower mortality. Risk declined steeply up to roughly 7,000 steps per day and then plateaued, with no additional benefit detectable beyond that level.',
  },
  {
    title: 'Time-restricted eating and body weight in adults with obesity: a 12-month randomised clinical trial',
    abstract:
      'Participants were assigned to an eight-hour eating window or to usual meal timing with matched caloric prescription. Weight loss did not differ significantly between groups; adherence declined over time in both arms.',
  },
  {
    title: 'Resistance training and resting energy expenditure across the adult lifespan',
    abstract:
      'Doubly labelled water was used to quantify total energy expenditure in 512 adults aged 25 to 70. Fat-free mass explained most of the between-person variance in resting energy expenditure.',
  },
  {
    title: 'Dietary fibre intake and colorectal cancer risk: dose-response meta-analysis of prospective studies',
    abstract:
      'Twenty-five prospective cohorts with 2.1 million participants were pooled. Each additional 10 g of dietary fibre per day was associated with a 9% lower risk of colorectal cancer.',
  },
  {
    title: 'Serotonergic modulation of reward learning: a pharmacological fMRI study',
    abstract:
      'Acute tryptophan depletion altered prediction-error signalling in the ventral striatum, consistent with a role for serotonin in the temporal discounting of reward. We make no claim about the aetiology of mood disorders.',
  },
  {
    title: 'Retrieval practice and spaced repetition improve long-term retention: a classroom randomised trial',
    abstract:
      'Students in 24 secondary school classes were randomly assigned to spaced retrieval practice or to re-reading. Retrieval practice produced substantially better retention at the delayed post-test eight weeks later.',
  },
  {
    title: 'Interruptions, task switching and knowledge worker productivity: evidence from 2,100 software engineers',
    abstract:
      'Using telemetry from an integrated development environment, we quantified the cost of interruptions during focused work. Resumption lag averaged 23 minutes and scaled with the complexity of the interrupted task.',
  },
  {
    title: 'Four-day week trials in 61 organisations: outcomes for wellbeing, burnout and revenue',
    abstract:
      'A six-month pilot across 61 UK organisations found reduced burnout and stable revenue. Self-reported sleep quality improved modestly; results are based on organisations that self-selected into the programme.',
  },
  {
    title: 'The effect of minimum wage increases on employment: evidence from bunching estimators',
    abstract:
      'We exploit 138 state-level minimum wage changes in the United States and find that the number of jobs paying below the new minimum falls while overall employment in affected sectors changes little.',
  },
  {
    title: 'Unemployment insurance generosity and job search intensity: a regression discontinuity design',
    abstract:
      'Administrative data on 1.4 million claimants show that search effort responds to benefit exhaustion dates. Reemployment wages are largely unaffected by benefit duration.',
  },
  {
    title: 'Housing supply elasticity and rent growth in 250 metropolitan areas',
    abstract:
      'Instrumenting for permitted construction with geographic constraints, we estimate that a 10% increase in the housing stock reduces rents by roughly 1% over five years.',
  },
  {
    title: 'Loneliness and mortality risk: an individual participant data meta-analysis',
    abstract:
      'Pooling 90 prospective studies with 2,205,000 participants, loneliness and objective social isolation were both associated with elevated all-cause mortality after adjustment for baseline health.',
  },
  {
    title: 'A registered replication of the cognitive interview in eyewitness memory',
    abstract:
      'Across 18 laboratories and 3,105 participants, the cognitive interview increased the amount of correct detail recalled without an increase in errors. The protocol was preregistered and the data are openly available.',
  },
  {
    title: 'Psychological safety and team performance in 312 healthcare teams',
    abstract:
      'Multilevel modelling of survey and outcome data showed that teams reporting higher psychological safety recorded more near-miss incidents and fewer adverse patient events.',
  },
  {
    title: 'Exercise as an adjunct treatment for depressive symptoms: network meta-analysis of 218 randomised trials',
    abstract:
      'Across 218 trials with 14,170 participants, supervised aerobic exercise and resistance training both reduced depressive symptoms relative to active control conditions. Effects were larger in trials with higher intensity prescriptions.',
  },
];

describe('Zombie-Filter', () => {
  test('lädt mindestens 25 belegte Einträge mit vollständigen Feldern', () => {
    assert.ok(ZOMBIE_CLAIMS.length >= 25, `nur ${ZOMBIE_CLAIMS.length} Zombie-Einträge geladen`);
    for (const claim of ZOMBIE_CLAIMS) {
      assert.ok(claim.slug.length > 0, 'slug fehlt');
      assert.ok(claim.label.length > 0, `label fehlt bei ${claim.slug}`);
      assert.ok(claim.why.length > 40, `why zu dünn bei ${claim.slug}`);
      assert.ok(claim.patterns.length > 0, `patterns fehlen bei ${claim.slug}`);
    }
  });

  test('erkennt klassische widerlegte Befunde', () => {
    const cases: { text: string; slug: string }[] = [
      {
        text: 'Ego depletion revisited: does exerting self-control drain a limited resource?',
        slug: 'ego-depletion',
      },
      {
        text: 'Power posing increases felt power and testosterone in a sample of managers.',
        slug: 'power-posing',
      },
      {
        text: 'The marshmallow test predicts adolescent achievement two decades later.',
        slug: 'marshmallow-test',
      },
      {
        text: 'Tailoring instruction to learning styles: matching visual and auditory presentation to learner preference.',
        slug: 'learning-styles',
      },
      {
        text: 'The serotonin hypothesis of depression revisited in a clinical sample.',
        slug: 'serotonin-depression',
      },
      {
        text: 'Adrenal fatigue in chronically stressed office workers: salivary cortisol profiles.',
        slug: 'adrenal-fatigue',
      },
      {
        text: 'A detox diet lowers circulating markers in overweight adults.',
        slug: 'detox-diets',
      },
      {
        text: 'Growth mindset intervention improves ninth grade achievement in a nationwide trial.',
        slug: 'growth-mindset',
      },
    ];
    for (const { text, slug } of cases) {
      const hit = findZombieMatch(makeStudy({ title: text, abstract: text }));
      assert.ok(hit, `kein Treffer für "${text}"`);
      assert.equal(hit.slug, slug);
    }
  });

  test('REGRESSION: schlägt bei 20 legitimen Studien nicht an', () => {
    const falsePositives: string[] = [];
    for (const legit of LEGITIMATE_STUDIES) {
      const hit = explainZombieMatch(makeStudy({ title: legit.title, abstract: legit.abstract }));
      if (hit) {
        falsePositives.push(`"${legit.title}" → ${hit.claim.slug} via /${hit.pattern}/`);
      }
    }
    assert.deepEqual(falsePositives, [], `Fehlalarme:\n${falsePositives.join('\n')}`);
  });

  test('durchsucht nur Titel und Abstract, nicht die Autorenliste', () => {
    const study = makeStudy({
      authors: ['Wakefield, A.', 'Wansink, B.'],
      title: 'Vitamin D status in adolescents',
      abstract: 'A cross-sectional survey of serum 25-hydroxyvitamin D in 900 adolescents.',
    });
    assert.equal(findZombieMatch(study), null);
  });

  test('kommt mit leerem Text zurecht', () => {
    assert.equal(findZombieMatch(makeStudy({ title: '', abstract: '' })), null);
  });

  test('Regexes sind zustandslos (kein g-Flag): wiederholte Aufrufe liefern dasselbe', () => {
    const study = makeStudy({
      title: 'Ego depletion and self-control',
      abstract: 'Ego depletion was measured twice. Ego depletion effects were small.',
    });
    const first = findZombieMatch(study);
    const second = findZombieMatch(study);
    const third = findZombieMatch(study);
    assert.ok(first && second && third);
    assert.equal(first.slug, second.slug);
    assert.equal(second.slug, third.slug);
  });
});

describe('scoreStudy — Rangfolge', () => {
  const metaAnalysis = makeStudy({
    id: 'doi:10.1000/meta',
    title: 'Physical activity and all-cause mortality: a systematic review and meta-analysis of 41 prospective cohorts',
    abstract:
      'We pooled 41 prospective cohort studies comprising 2,100,000 adults. The protocol was preregistered and sensitivity analyses are reported.',
    journal: 'The Lancet',
    design: 'meta-analysis',
    sampleSize: 2_100_000,
    citationCount: 310,
    year: THIS_YEAR - 3,
  });

  const singleExperiment = makeStudy({
    id: 'doi:10.1000/exp',
    title: 'Ambient scent and creative output in a laboratory task',
    abstract:
      'Forty-eight undergraduate students completed a divergent thinking task in a scented or unscented room. This exploratory pilot study reports a difference in idea fluency.',
    journal: 'Journal of Small Findings',
    design: 'experiment',
    sampleSize: 48,
    citationCount: 3,
    year: THIS_YEAR - 4,
  });

  test('Metaanalyse mit großem n schlägt Einzelexperiment deutlich', () => {
    const strong = scoreStudy(metaAnalysis);
    const weak = scoreStudy(singleExperiment);

    assert.ok(
      strong.total > weak.total + 25,
      `Abstand zu klein: Metaanalyse ${strong.total} vs. Experiment ${weak.total}`,
    );
    assert.equal(strong.rejected, false);
    assert.ok(strong.breakdown.design > weak.breakdown.design);
    assert.ok(strong.breakdown.sampleSize > weak.breakdown.sampleSize);
  });

  test('das schwache Einzelexperiment fällt unter die harte Untergrenze', () => {
    const weak = scoreStudy(singleExperiment);
    assert.ok(weak.total < CREDIBILITY_FLOOR, `Score ${weak.total} sollte unter ${CREDIBILITY_FLOOR} liegen`);
    assert.ok(weak.total < CREDIBILITY_THRESHOLD);
    assert.equal(weak.rejected, true);
    assert.match(String(weak.rejectionReason), /Gesamtscore/);
  });

  test('mittelmäßige Arbeiten werden nicht hart verworfen — darüber entscheidet die Themenschwelle', () => {
    const middling = makeStudy({
      title: 'Self-reported focus and workplace interruptions in a regional survey',
      abstract: 'A survey of 3,000 employees in one region examined self-reported interruptions and perceived focus.',
      journal: 'Journal of Regional Surveys',
      design: 'cross-sectional',
      sampleSize: 3_000,
      citationCount: 6,
      year: THIS_YEAR - 6,
    });
    const score = scoreStudy(middling);
    assert.ok(
      score.total > CREDIBILITY_FLOOR && score.total < CREDIBILITY_THRESHOLD,
      `Testaufbau: Score ${score.total} sollte zwischen ${CREDIBILITY_FLOOR} und ${CREDIBILITY_THRESHOLD} liegen`,
    );
    assert.equal(score.rejected, false, 'nur die absolute Untergrenze darf hart verwerfen');
  });

  test('die harte Untergrenze liegt unter der Aufnahmeschwelle', () => {
    assert.ok(CREDIBILITY_FLOOR <= CREDIBILITY_THRESHOLD);
  });

  test('Design ist der stärkste Einzelfaktor', () => {
    const asMeta = scoreStudy(makeStudy({ design: 'meta-analysis' }));
    const asUnknown = scoreStudy(makeStudy({ design: 'unknown' }));
    assert.ok(asMeta.breakdown.design - asUnknown.breakdown.design >= 25);
    assert.ok(asMeta.total > asUnknown.total);
  });

  test('Designs sind absteigend nach Aussagekraft gestaffelt', () => {
    const order: StudyDesign[] = [
      'meta-analysis',
      'systematic-review',
      'rct',
      'cohort',
      'case-control',
      'cross-sectional',
      'experiment',
      'modelling',
      'narrative-review',
      'unknown',
    ];
    const points = order.map((design) => scoreStudy(makeStudy({ design })).breakdown.design);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1] ?? 0;
      const cur = points[i] ?? 0;
      assert.ok(prev > cur, `${order[i - 1]} (${prev}) sollte über ${order[i]} (${cur}) liegen`);
    }
  });

  test('Summe der Teilscores entspricht dem Gesamtscore und bleibt in 0–100', () => {
    for (const study of [metaAnalysis, singleExperiment, makeStudy()]) {
      const score = scoreStudy(study);
      const sum = Object.values(score.breakdown).reduce((a, b) => a + b, 0);
      assert.ok(Math.abs(sum - score.total) <= 1, `Summe ${sum} vs. total ${score.total}`);
      assert.ok(score.total >= 0 && score.total <= 100);
    }
  });
});

describe('scoreStudy — harte Ablehnung', () => {
  test('Zombie-Treffer führt zu rejected, egal wie gut die Studie sonst aussieht', () => {
    const dressedUpZombie = makeStudy({
      id: 'doi:10.1000/zombie',
      title: 'Power posing and hormonal response: a meta-analysis of 41 studies',
      abstract:
        'We pooled 41 studies with 210,000 participants examining whether expansive postures raise testosterone and lower cortisol. The protocol was preregistered.',
      journal: 'Nature Human Behaviour',
      design: 'meta-analysis',
      sampleSize: 210_000,
      citationCount: 220,
      year: THIS_YEAR - 1,
    });

    const score = scoreStudy(dressedUpZombie);
    assert.equal(score.rejected, true);
    assert.ok(score.total > CREDIBILITY_THRESHOLD, 'Testaufbau: der Score selbst wäre hoch genug');
    assert.match(String(score.rejectionReason), /Zombie-Befund/);
    assert.match(String(score.rejectionReason), /power-posing/);
    assert.ok(score.reasons.some((r) => /Ranehill|Carney|Simonsohn/.test(r)), 'widerlegende Arbeit fehlt in reasons');
  });

  test('Preprint UND schwaches Design wird abgelehnt', () => {
    const preprint = makeStudy({
      title: 'A new questionnaire measure of workplace focus',
      abstract: 'We report a cross-sectional survey of 20,000 employees in twelve countries.',
      journal: undefined,
      design: 'cross-sectional',
      isPreprint: true,
      sampleSize: 20_000,
      citationCount: 0,
      year: THIS_YEAR,
    });
    const score = scoreStudy(preprint);
    assert.equal(score.rejected, true);
    assert.match(String(score.rejectionReason), /Preprint/);
  });

  test('Preprint mit starkem Design wird nicht automatisch abgelehnt', () => {
    const preprint = makeStudy({
      title: 'Sleep extension and blood pressure: a randomised controlled trial',
      abstract:
        'In this preregistered, double-blind randomised controlled trial, 1,200 adults were assigned to a sleep extension programme or usual care. Independent validation in a held-out sample is reported.',
      journal: undefined,
      design: 'rct',
      isPreprint: true,
      sampleSize: 1_200,
      citationCount: 2,
      year: THIS_YEAR,
    });
    const score = scoreStudy(preprint);
    assert.ok(
      !score.rejected || !/Preprint ohne/.test(String(score.rejectionReason)),
      'starkes Design darf nicht an der Preprint-Regel scheitern',
    );
    assert.ok(score.breakdown.venue < 6, 'Preprint muss beim Publikationsort abgewertet werden');
  });
});

describe('scoreStudy — fehlende Angaben', () => {
  test('fehlende sampleSize wird neutral behandelt, nicht wie n=0', () => {
    const missing = scoreStudy(makeStudy({ sampleSize: undefined }));
    const tiny = scoreStudy(makeStudy({ sampleSize: 20 }));
    const huge = scoreStudy(makeStudy({ sampleSize: 500_000 }));

    assert.ok(
      missing.breakdown.sampleSize > tiny.breakdown.sampleSize,
      'unbekannt darf nicht schlechter dastehen als eine Winzstichprobe',
    );
    assert.ok(
      missing.breakdown.sampleSize < huge.breakdown.sampleSize,
      'unbekannt darf nicht so gut dastehen wie eine Riesenstichprobe',
    );
    assert.equal(missing.breakdown.sampleSize, 10, 'neutraler Mittelwert erwartet');
    assert.ok(missing.reasons.some((r) => /nicht angegeben/.test(r)));
    assert.match(missing.evidenceLabel, /Teilnehmerzahl nicht angegeben/);
  });

  test('Stichprobe wird logarithmisch skaliert', () => {
    const at = (n: number) => scoreStudy(makeStudy({ sampleSize: n })).breakdown.sampleSize;
    const smallJump = at(500) - at(50);
    const hugeJump = at(500_000) - at(50_000);
    assert.ok(smallJump > hugeJump * 1.5, `50→500 (${smallJump}) muss deutlich mehr wiegen als 50k→500k (${hugeJump})`);
    assert.ok(at(50) > 0);
  });

  test('frische Arbeiten werden nicht für fehlende Zitationen bestraft', () => {
    const fresh = scoreStudy(
      makeStudy({ year: THIS_YEAR, publishedAt: new Date().toISOString(), citationCount: 0 }),
    );
    const old = scoreStudy(makeStudy({ year: THIS_YEAR - 10, citationCount: 0 }));
    assert.ok(fresh.breakdown.citations > old.breakdown.citations);
    assert.equal(fresh.breakdown.citations, 6);
    assert.ok(fresh.reasons.some((r) => /frisch erschienen/.test(r)));
  });

  test('fehlende Zitationszahl und fehlendes Jahr werden neutral gewertet', () => {
    const score = scoreStudy(makeStudy({ citationCount: undefined, year: undefined, publishedAt: undefined }));
    assert.equal(score.breakdown.citations, 6);
    assert.equal(score.breakdown.recency, 5);
  });
});

describe('evidenceLabel und reasons', () => {
  test('nutzt die echte Stichprobengröße in deutscher Alltagssprache', () => {
    const meta = scoreStudy(
      makeStudy({
        design: 'meta-analysis',
        sampleSize: 2_100_000,
        journal: 'The Lancet',
        citationCount: 300,
      }),
    );
    assert.match(meta.evidenceLabel, /Metaanalyse/);
    assert.match(meta.evidenceLabel, /2,1 Mio\./);
  });

  test('warnt bei kleinen Einzelexperimenten', () => {
    const small = scoreStudy(
      makeStudy({ design: 'experiment', sampleSize: 48, journal: 'Journal of Small Findings' }),
    );
    assert.match(small.evidenceLabel, /Einzelexperiment mit 48 Teilnehmenden/);
    assert.match(small.evidenceLabel, /mit Vorsicht zu genießen/);
  });

  test('kennzeichnet Preprints im Label', () => {
    const pre = scoreStudy(makeStudy({ isPreprint: true, journal: undefined, design: 'rct' }));
    assert.match(pre.evidenceLabel, /ohne Fachbegutachtung/);
  });

  test('enthält keinen Fachjargon und keine p-Werte', () => {
    for (const study of [
      makeStudy(),
      makeStudy({ design: 'meta-analysis', sampleSize: 2_100_000 }),
      makeStudy({ design: 'experiment', sampleSize: 48 }),
      makeStudy({ sampleSize: undefined, design: 'unknown' }),
    ]) {
      const label = scoreStudy(study).evidenceLabel;
      assert.doesNotMatch(label, /\bp\s*[<=>]/i, `p-Wert im Label: ${label}`);
      assert.doesNotMatch(label, /\bCohen|\bd\s*=|\bCI\b|\bodds ratio\b|\bhazard ratio\b/i, label);
      assert.ok(label.length > 10);
    }
  });

  test('reasons sind kurze deutsche Begründungen', () => {
    const score = scoreStudy(makeStudy());
    assert.ok(score.reasons.length >= 4);
    for (const reason of score.reasons) {
      assert.ok(reason.length > 0 && reason.length < 400, `Begründung zu lang/leer: ${reason}`);
    }
    assert.ok(score.reasons.some((r) => /Studiendesign/.test(r)));
  });
});
