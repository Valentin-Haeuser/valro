import type { Study, Topic } from '../types.js';

/**
 * Alltagsrelevanz — die zweite Achse neben der Belegstärke.
 *
 * Die Bewertung in `credibility.ts` misst, wie gut ein Befund belegt ist.
 * Sie sagt nichts darüber, ob er jemanden interessiert. Beides
 * auseinanderzuhalten ist nötig, weil die Fachliteratur systematisch in die
 * falsche Richtung zieht: Die methodisch saubersten Arbeiten sind fast immer
 * die engsten. Eine Metaanalyse zum Eierstockkrebsrisiko in asiatischen
 * Populationen ist erstklassige Wissenschaft und als Gesprächsstoff wertlos.
 *
 * Gesucht ist der Gegentyp: allgemeine Bevölkerung, alltägliches Verhalten,
 * ein Befund, der die eigene Woche betrifft. Nicht "seltene Krankheit bei
 * Untergruppe X", sondern "was Schlafdauer mit dem Gedächtnis macht".
 */

/** Alltagsnahe Gegenstände. Treffer heben die Bewertung. */
const EVERYDAY: readonly RegExp[] = [
  /\bsleep (duration|quality|timing|deprivation|restriction)\b/i,
  /\b(nap|napping|chronotype|circadian|jet ?lag|insomnia)\b/i,
  /\b(physical activity|exercise|walking|running|strength training|steps per day)\b/i,
  /\b(sedentary|sitting time|screen time|smartphone|social media)\b/i,
  /\b(diet|nutrition|breakfast|caffeine|coffee|alcohol|fasting|sugar|protein intake)\b/i,
  /\b(memory|attention|focus|concentration|learning|recall|multitasking)\b/i,
  /\b(procrastination|motivation|habit formation|self-?control|willpower|decision making)\b/i,
  /\b(stress|burnout|loneliness|mood|happiness|well-?being|life satisfaction)\b/i,
  /\b(working hours|remote work|commut(e|ing)|productivity|job performance|break)\b/i,
  /\b(income|wage|savings|spending|price|inflation|unemployment|retirement)\b/i,
  /\b(labor|labour) (market|supply|demand)\b/i,
  /\b(tax|taxes|subsid|insurance|credit|debt|mortgage|housing|pension)/i,
  /\b(incentive|bonus|negotiat|bargain|competition|monopol)/i,
  /\b(minimum wage|gig economy|automation|artificial intelligence and (work|jobs|labor))/i,
  /\b(longevity|life expectancy|mortality|ag(e)?ing|healthspan)\b/i,
  /\b(mindfulness|meditation|breathing|cold exposure|sauna)\b/i,
];

/**
 * Enge klinische Gegenstände. Kein Ausschluss — Krankheiten sind oft der
 * Anlass, aus dem etwas über gesunde Menschen gelernt wird — aber sie ziehen
 * die Bewertung deutlich nach unten.
 */
const CLINICAL: readonly RegExp[] = [
  /\b(cancer|carcinoma|tumou?r|oncolog|chemotherap|metasta)/i,
  /\b(schizophreni|psychosis|bipolar disorder|borderline personality)/i,
  /\b(dialysis|nephropath|cirrhosis|hepatitis|sepsis|icu|intensive care)/i,
  /\b(postoperative|perioperative|surgery|surgical|transplant|catheter|stent)/i,
  /\b(rhinosinusitis|arthritis|psoriasis|lupus|sclerosis|fibrosis|copd)/i,
  /\b(alzheimer|parkinson|dementia|epileps|stroke survivors)/i,
  /\b(chemo|radiotherapy|immunotherap|biomarker|genotyp|polymorphism|allele)/i,
  /\b(preterm|neonat|pregnan|gestational|in vitro fertilis)/i,
  /\b(mice|murine|rat model|rodent|zebrafish|in vitro|cell line)/i,
  /\b(prevalence of .{0,30}(disorder|disease|syndrome))/i,
];

/** Sehr enge Teilpopulationen — der Befund gilt dann kaum für den Leser. */
const NARROW_POPULATION: readonly RegExp[] = [
  /\b(refugee|asylum|prisoner|inmate|homeless)/i,
  /\b(patients with|among patients|in patients)\b/i,
  /\b(nurses|physicians|medical students|military personnel|veterans)\b/i,
  /\bin (a )?(chinese|korean|japanese|indian|iranian|turkish|brazilian|nigerian) (sample|population|students|adults|cohort)\b/i,
  /\b(survivors|caregivers of)\b/i,
];

/** Methodenarbeiten ohne Aussage über Menschen im Alltag. */
const METHODOLOGICAL: readonly RegExp[] = [
  /\b(fmri|eeg|meta-?analytic structural equation|network meta-analysis of (diagnostic|imaging))/i,
  /\b(psychometric|validation of the|reliability of the|factor structure|measurement invariance)/i,
  /\b(bibliometric|scientometric|scoping review|conceptual framework|research agenda)/i,
  /\b(mendelian randomi[sz]ation|genome-?wide association)/i,
  /\b(protocol for|study protocol)\b/i,
];

export interface Relevance {
  /** 0–1. Ab etwa 0,5 taugt ein Befund als Hauptfakt. */
  score: number;
  reasons: string[];
}

export function everydayRelevance(study: Study): Relevance {
  const title = study.title;
  // Nur den Anfang des Abstracts prüfen: Dort steht der Gegenstand. Weiter
  // hinten stehen Limitationen und Ausblick, die fast jede Arbeit klinisch
  // klingen lassen.
  const opening = study.abstract.slice(0, 600);
  const haystack = `${title} ${opening}`;
  const reasons: string[] = [];

  let score = 0.45; // neutraler Ausgangspunkt

  const everyday = EVERYDAY.filter((re) => re.test(haystack)).length;
  if (everyday > 0) {
    score += Math.min(0.35, everyday * 0.14);
    reasons.push(`alltagsnaher Gegenstand (${everyday} Treffer)`);
  }

  // Im Titel wiegt ein klinischer Begriff schwerer als im Abstract: Er
  // bestimmt, worum die Arbeit im Kern geht.
  const clinicalTitle = CLINICAL.some((re) => re.test(title));
  const clinicalBody = CLINICAL.some((re) => re.test(opening));
  if (clinicalTitle) {
    score -= 0.34;
    reasons.push('klinisch enges Thema im Titel');
  } else if (clinicalBody) {
    score -= 0.12;
    reasons.push('klinischer Kontext im Abstract');
  }

  if (NARROW_POPULATION.some((re) => re.test(title))) {
    score -= 0.22;
    reasons.push('sehr enge Teilpopulation');
  }

  if (METHODOLOGICAL.some((re) => re.test(haystack))) {
    score -= 0.2;
    reasons.push('Methoden- statt Sachbefund');
  }

  // Große, allgemeine Stichproben sprechen für Übertragbarkeit.
  if (study.sampleSize && study.sampleSize >= 10_000) {
    score += 0.08;
    reasons.push('sehr große Stichprobe');
  }

  return { score: clamp(score), reasons };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100));
}

/**
 * Prüft, ob eine Studie überhaupt zum Thema des Tages gehört.
 *
 * Nötig, weil die Suchanfragen an die Fachdatenbanken breit gefasst sein
 * müssen, um genug Material zu finden — dabei rutscht regelmäßig etwas
 * durch, das formal in der Trefferliste steht, aber nichts mit dem Thema zu
 * tun hat. Eine Studie über ein Diabetesmedikament ist kein Psychologiefakt,
 * auch wenn die Suche sie ausgespuckt hat.
 */
const TOPIC_GATE: Record<Topic, RegExp> = {
  sleep: /\b(sleep|insomnia|nap|circadian|chronotype|bedtime|shift work|drowsi|somnolen|rest)/i,
  productivity:
    /\b(attention|focus|concentrat|cognitiv|working memory|multitask|task switch|fatigue|productiv|work(ing)? hours|break|performance|executive function|procrastinat|efficien)/i,
  body: /\b(physical activity|exercise|diet|nutrition|mortality|longevity|metabolic|cardiovascular|weight|obesity|muscle|fitness|sedentary|steps|blood pressure|health|ag(e)?ing)/i,
  economics:
    /\b(econom|labor|labour|wage|income|price|market|tax|financ|monetary|fiscal|employ|unemploy|productivity|firm|consumer|household|inequal|trade|invest)/i,
  learning:
    /\b(learn|memory|recall|retrieval|practice|educat|academic|skill|training|instruction|student|teach|knowledge|forgetting)/i,
  environment:
    /\b(pollut|particulate|pm2\.?5|noise|temperature|heat|cold|green space|daylight|light exposure|air quality|environment|urban|climate)/i,
  nutrition:
    /\b(diet|nutrition|food|eating|sugar|protein|fibre|fiber|fasting|vitamin|supplement|calorie|carbohydrate|micronutrient|meal)/i,
  time: /\b(commut|time use|urban|city|cities|travel|transport|working time|leisure|neighbourhood|neighborhood|schedule|time poverty)/i,
  relationships:
    /\b(loneli|social isolation|social support|social connection|marriage|marital|friendship|social network|relationship|partner|famil|social tie)/i,
  // Bewusst weit gefasst. Eine zu enge Liste sortiert genau die Arbeiten aus,
  // die den besten Gesprächsstoff hergeben — die PNAS-Arbeit zu Prokrastination
  // und Impulsivität etwa nennt keinen einzigen der klassischen Oberbegriffe.
  psychology:
    /\b(behavio|psycholog|motivat|decision|memory|emotion|cognit|social|personalit|habit|belief|attitude|bias|stress|mood|wellbeing|well-being|mental|impulsiv|procrastinat|self-?control|attention|learning|reward|anxiet|depress|perception|judg(e)?ment|trait|heritab|temperament)/i,
};

export function matchesTopic(study: Study, topic: Topic): boolean {
  return TOPIC_GATE[topic].test(`${study.title} ${study.abstract.slice(0, 600)}`);
}
