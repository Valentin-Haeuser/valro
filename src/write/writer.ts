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

BETREFF: neugierig machen, ohne Clickbait. Maximal 60 Zeichen. Keine Emojis.

Antworte ausschließlich mit gültigem JSON in genau diesem Format, ohne Markdown-Codeblock:
{"subject": "...", "lead": {"hook": "...", "finding": "...", "mechanism": "...", "evidence": "...", "caveat": "...", "dinnerLine": "..."}, "shorts": [{"finding": "...", "evidence": "..."}, {"finding": "...", "evidence": "..."}]}`;

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
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  const parsed = responseSchema.parse(JSON.parse(stripCodeFence(text)));

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

/** Manche Antworten kommen trotz Anweisung in einem Codeblock. */
function stripCodeFence(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text.trim());
  return fenced?.[1] ?? text;
}

/**
 * Warnt, wenn im Fließtext eine auffällige Zahl steht, die so nicht im
 * Abstract vorkommt. Kein harter Abbruch: Prozentwerte werden legitim
 * umgerechnet ("ein Drittel" statt "33%"), und Jahreszahlen sind harmlos.
 * Die Warnung landet im Actions-Log, damit man Ausreißer bemerkt.
 */
export function checkNumbers(briefing: Briefing, selection: Selection): string[] {
  const warnings: string[] = [];
  const nums = (s: string) => s.match(/\d[\d.,]*/g) ?? [];
  const inAbstract = new Set(
    [selection.lead, ...selection.shorts].flatMap((s) => nums(s.study.abstract).map(normalizeNum)),
  );

  const body = [
    briefing.lead.finding,
    briefing.lead.mechanism,
    briefing.lead.evidence,
    briefing.lead.caveat,
  ].join(' ');

  for (const raw of nums(body)) {
    const n = normalizeNum(raw);
    if (Number(n) >= 1900 && Number(n) <= 2100) continue; // Jahreszahl
    if (n.length <= 1) continue; // einstellige Zahlen sind zu häufig für ein Signal
    if (!inAbstract.has(n)) warnings.push(`Zahl "${raw}" steht nicht im Abstract`);
  }
  return warnings;
}

function normalizeNum(s: string): string {
  return s.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.');
}
