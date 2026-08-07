import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Briefing, ScoredStudy, StudyRef, Topic } from '../types.js';
import { TOPIC_LABELS } from '../types.js';
import { CONFIG } from '../config.js';
import type { Selection } from '../select/selector.js';

/**
 * Der Redakteur-Schritt ist die einzige Stelle, an der ein Sprachmodell
 * mitschreibt — und damit die einzige Stelle, an der etwas erfunden werden
 * könnte. Zwei Riegel dagegen:
 *
 * 1. Das Modell sieht ausschließlich echte Abstracts, die vorher aus den
 *    Fachdatenbanken geholt und bewertet wurden. Es sucht sich nichts selbst.
 * 2. Alle Metadaten der Quellenangabe (Titel, Journal, Jahr, Link, DOI)
 *    setzen wir hinterher aus unseren eigenen Daten ein — das Modell darf
 *    sie gar nicht erst schreiben.
 *
 * Bleibt als Restrisiko, dass eine Zahl im Fließtext falsch übernommen wird.
 * Dagegen steht die Prompt-Regel plus die Nachprüfung in `checkNumbers()`.
 */

const factSchema = z.object({
  hook: z.string().min(10),
  finding: z.string().min(20),
  mechanism: z.string().min(20),
  evidence: z.string().min(10),
  caveat: z.string().min(10),
  dinnerLine: z.string().min(10),
});

const responseSchema = z.object({
  subject: z.string().min(5),
  lead: factSchema,
  shorts: z
    .array(z.object({ finding: z.string().min(20), evidence: z.string().min(5) }))
    .min(1),
});

/**
 * Dasselbe Format noch einmal als JSON-Schema — daran bindet die API die
 * Antwort verbindlich. Vorher stand nur im Prompt "antworte mit JSON", was
 * gelegentlich in einem Markdown-Codeblock endete und den Lauf zerlegte.
 *
 * Bewusst ohne Längenangaben: Die akzeptiert die API im Schema nicht. Die
 * Mindestlängen prüft weiterhin Zod nach dem Parsen.
 */
const TEXT = { type: 'string' } as const;

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'lead', 'shorts'],
  properties: {
    subject: TEXT,
    lead: {
      type: 'object',
      additionalProperties: false,
      required: ['hook', 'finding', 'mechanism', 'evidence', 'caveat', 'dinnerLine'],
      properties: {
        hook: TEXT,
        finding: TEXT,
        mechanism: TEXT,
        evidence: TEXT,
        caveat: TEXT,
        dinnerLine: TEXT,
      },
    },
    shorts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['finding', 'evidence'],
        properties: { finding: TEXT, evidence: TEXT },
      },
    },
  },
} as const;

const SYSTEM = `Du bist Redakteur für ein tägliches Wissens-Briefing. Dein Leser will den Fakt abends im Gespräch weitererzählen können und dabei kompetent wirken — nicht wie jemand, der einen Podcast nacherzählt.

ABSOLUTE REGELN:
1. Du erfindest NICHTS. Jede Zahl, jeder Effekt, jede Aussage muss wörtlich aus dem gelieferten Abstract stammen. Steht eine Zahl nicht im Abstract, nennst du sie nicht.
2. Du nennst KEINE Studientitel, Journalnamen, Autoren, Jahreszahlen oder Links im Fließtext. Die Quellenangabe wird technisch angehängt.
3. Wenn das Abstract eine Aussage nur vorsichtig formuliert ("associated with", "may suggest"), formulierst du sie ebenfalls vorsichtig. Aus einer Korrelation machst du NIEMALS eine Ursache.
4. Sprache: Deutsch, natürlich gesprochen, keine Anglizismen wo es deutsche Wörter gibt. Fachbegriffe nur, wenn du sie im selben Satz erklärst.
5. Keine p-Werte, keine Konfidenzintervalle, kein Statistik-Jargon.

AUFBAU DES HAUPTFAKTS — jedes Feld hat eine klare Aufgabe:
- hook: Eine Frage oder Beobachtung, bei der der Leser kurz selbst überlegt. Ein bis zwei Sätze. Weckt Neugier, verrät die Antwort noch nicht.
- finding: Der Befund mit der konkreten, merkbaren Zahl aus dem Abstract. Zwei bis drei Sätze.
- mechanism: WARUM ist das so? Der biologische, psychologische oder ökonomische Wirkmechanismus. Das ist der wichtigste Teil — hier entsteht der Aha-Moment und hier klingt der Leser klug. Drei bis vier Sätze. Wenn das Abstract den Mechanismus nicht nennt, sag ehrlich, dass der Mechanismus noch unklar ist, und beschreibe, welche Erklärung die Autoren diskutieren.
- evidence: Wie gut ist das belegt, in Alltagssprache. Ein bis zwei Sätze.
- caveat: Was die Studie ausdrücklich NICHT sagt, oder für wen sie nicht gilt. Ein bis zwei Sätze. Dieser Teil ist der eigentliche Kompetenzbeweis: Wer die Einschränkung mitliefert, wirkt informiert statt nachplappernd.
- dinnerLine: EIN Satz, den man abends tatsächlich so sagen kann. Gesprochene Sprache, keine Schriftsprache. Kein "Studien zeigen" — konkret werden.

KURZFAKTEN: je zwei bis drei Sätze, Befund plus Zahl, dazu eine knappe Einordnung der Belegstärke.

BETREFF: neugierig machen, ohne Clickbait. Maximal 60 Zeichen. Keine Emojis.`;

function studyBlock(s: ScoredStudy, label: string): string {
  const st = s.study;
  return [
    `## ${label}`,
    `Titel: ${st.title}`,
    st.journal ? `Journal: ${st.journal}` : null,
    st.year ? `Jahr: ${st.year}` : null,
    `Studientyp: ${st.design}`,
    st.sampleSize ? `Teilnehmerzahl: ${st.sampleSize.toLocaleString('de-DE')}` : null,
    `Belegstärke (unsere Einordnung): ${s.score.evidenceLabel}`,
    '',
    'ABSTRACT (deine einzige Faktenquelle):',
    st.abstract,
  ]
    .filter(Boolean)
    .join('\n');
}

function refFor(s: ScoredStudy): StudyRef {
  return {
    title: s.study.title,
    journal: s.study.journal,
    year: s.study.year,
    url: s.study.url,
    doi: s.study.doi,
    evidenceLabel: s.score.evidenceLabel,
  };
}

export async function writeBriefing(
  selection: Selection,
  topic: Topic,
  date: string,
  apiKey: string,
): Promise<Briefing> {
  const client = new Anthropic({ apiKey });

  const prompt = [
    `Thema des Tages: ${TOPIC_LABELS[topic]}`,
    '',
    studyBlock(selection.lead, 'HAUPTSTUDIE — daraus entsteht der Hauptfakt'),
    '',
    ...selection.shorts.map((s, i) => studyBlock(s, `KURZSTUDIE ${i + 1}`)),
    '',
    `Schreibe das Briefing. Genau ${selection.shorts.length} Kurzfakten, in der Reihenfolge der Kurzstudien.`,
  ].join('\n');

  const res = await client.messages.create({
    model: CONFIG.model,
    max_tokens: CONFIG.maxTokens,
    system: SYSTEM,
    output_config: {
      effort: CONFIG.effort,
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    messages: [{ role: 'user', content: prompt }],
  });

  if (res.stop_reason === 'max_tokens') {
    throw new Error(
      'Die Antwort wurde abgeschnitten. maxTokens in src/config.ts erhöhen.',
    );
  }

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // Das Format garantiert die API; Zod prüft zusätzlich die Mindestlängen,
  // die sich im Schema nicht ausdrücken lassen.
  const parsed = responseSchema.parse(JSON.parse(text));

  // Quellenangaben kommen aus unseren Daten, nicht aus der Modellantwort.
  const shorts = parsed.shorts.slice(0, selection.shorts.length).map((s, i) => ({
    finding: s.finding,
    evidence: s.evidence,
    study: refFor(selection.shorts[i]!),
  }));

  return {
    date,
    topic,
    subject: parsed.subject,
    lead: { ...parsed.lead, study: refFor(selection.lead) },
    shorts,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Warnt, wenn im Fließtext eine auffällige Zahl steht, die so nicht im
 * Abstract vorkommt. Kein harter Abbruch, sondern eine Notiz im Actions-Log.
 *
 * Der Wert dieser Prüfung hängt vollständig daran, wie selten sie anschlägt.
 * Eine Warnung, die bei jeder Mail erscheint, liest nach einer Woche niemand
 * mehr — und dann geht die eine echte darin unter. Der erste Lauf hat drei
 * Fehlalarme erzeugt, alle aus derselben Ursache: Abstracts schreiben Zahlen
 * anders als deutscher Fließtext. Deshalb kennt die Prüfung inzwischen die
 * drei Übersetzungen, die ein Redakteur zu Recht vornimmt:
 *
 *   "twenty-three samples"  → 23        (ausgeschriebene Zahlwörter)
 *   "r = .14"               → 0,14      (fehlende führende Null)
 *   "N = 13,636"            → "über 13.000"  (bewusste Rundung)
 */
export function checkNumbers(briefing: Briefing, selection: Selection): string[] {
  const warnings: string[] = [];

  const known = new Set<string>();
  for (const { study } of [selection.lead, ...selection.shorts]) {
    for (const raw of study.abstract.match(NUM_RE) ?? []) {
      const n = normalizeNum(raw);
      known.add(n);
      const value = Number(n);
      if (Number.isFinite(value)) for (const r of roundedForms(value)) known.add(r);
    }
    for (const n of spelledNumbers(study.abstract)) known.add(n);
  }

  const body = [
    briefing.lead.finding,
    briefing.lead.mechanism,
    briefing.lead.evidence,
    briefing.lead.caveat,
  ].join(' ');

  for (const raw of body.match(NUM_RE) ?? []) {
    const n = normalizeNum(raw);
    const value = Number(n);
    if (value >= 1900 && value <= 2100) continue; // Jahreszahl
    if (n.length <= 1) continue; // einstellige Zahlen sind zu häufig für ein Signal
    // Ohne den Schlusspunkt des Satzes — sonst steht in der Meldung "91."
    // und man sucht im Text nach einer Zahl, die es so nicht gibt.
    const shown = raw.replace(/[.,]+$/, '');
    if (!known.has(n)) warnings.push(`Zahl "${shown}" steht nicht im Abstract`);
  }
  return warnings;
}

/**
 * Das führende `\.?` fängt Werte wie ".14" ein, wie sie in englischen
 * Abstracts bei Korrelationen üblich sind. Ohne das stand die Zahl gar nicht
 * erst im Vergleichsbestand, und jede korrekt übersetzte "0,14" schlug an.
 */
const NUM_RE = /\.?\d[\d.,]*/g;

/**
 * Punkt und Komma sind je nach Sprache Tausender- oder Dezimaltrennzeichen —
 * und am Wortende oft schlicht Satzzeichen. Letzteres zuerst abschneiden:
 * Sonst wandert der Schlusspunkt eines Satzes mit in die Zahl und "0,14."
 * findet "0.14" nicht wieder.
 */
function normalizeNum(s: string): string {
  const bare = s.replace(/[.,]+$/, '');
  const withLeadingZero = bare.startsWith('.') ? `0${bare}` : bare;
  return withLeadingZero.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.');
}

/**
 * Gerundete Fassungen einer Zahl. "13.636 Teilnehmer" darf im Text zu
 * "über 13.000" werden — das ist saubere Redaktionsarbeit, keine Erfindung.
 * Abgerundet UND gerundet, weil "über 13.000" abrundet, "rund 14.000" aber
 * aufrundet; beide sind legitim.
 */
function roundedForms(n: number): string[] {
  const out: string[] = [];
  for (const step of [10, 100, 1000, 10_000, 100_000]) {
    if (n < step) break;
    out.push(String(Math.floor(n / step) * step), String(Math.round(n / step) * step));
  }
  return out;
}

const ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** Längere Wörter zuerst, damit "nineteen" nicht als "nine" durchgeht. */
const byLength = (o: Record<string, number>) =>
  Object.keys(o).sort((a, b) => b.length - a.length).join('|');

const SPELLED_RE = new RegExp(
  `\\b(?:(${byLength(TENS)})(?:[-\\s](${byLength(ONES)}))?|(${byLength(ONES)}))\\b`,
  'gi',
);

/**
 * "A total of twenty-three independent samples" — Abstracts schreiben kleine
 * Anzahlen regelmäßig aus, der deutsche Text nennt sie dann als Ziffer.
 */
function spelledNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPELLED_RE)) {
    const tens = m[1]?.toLowerCase();
    const tensOnes = m[2]?.toLowerCase();
    const ones = m[3]?.toLowerCase();
    const value = tens
      ? TENS[tens]! + (tensOnes ? ONES[tensOnes]! : 0)
      : ONES[ones!.toLowerCase()]!;
    out.push(String(value));
  }
  return out;
}
