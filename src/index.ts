import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { ScoredStudy, Source, Study, Topic } from './types.js';
import { TOPIC_LABELS, TOPICS } from './types.js';
import { CONFIG, loadEnv, topicForDate } from './config.js';
import { europePmcSource } from './sources/europepmc.js';
import { pubmedSource } from './sources/pubmed.js';
import { nberSource } from './sources/nber.js';
import { openAlexSource } from './sources/openalex.js';
import { crossrefSource } from './sources/crossref.js';
import { scoreStudy } from './scoring/credibility.js';
import { dedupe, select } from './select/selector.js';
import { loadHistory, recordBriefing, saveHistory } from './select/history.js';
import { checkNumbers, writeBriefing } from './write/writer.js';
import { renderEmailHtml, renderEmailText } from './render/email.js';
import { renderMarkdown } from './render/markdown.js';
import { createConsoleMailer, createSmtpMailer } from './deliver/smtp.js';

const SOURCES: Source[] = [
  europePmcSource,
  pubmedSource,
  crossrefSource,
  openAlexSource,
  nberSource,
];

const ARCHIVE_DIR = new URL('../archive/', import.meta.url).pathname;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'no-history': { type: 'boolean', default: false },
      topic: { type: 'string' },
    },
  });
  const dryRun = values['dry-run'] === true;
  const skipHistory = values['no-history'] === true;

  // Im Trockenlauf brauchen wir keine SMTP-Zugangsdaten, nur den API-Key.
  const env = dryRun ? loadEnvForDryRun() : loadEnv();

  const now = new Date();
  const date = formatDate(now);
  const activeTopic = resolveTopic(values.topic, now);

  console.log(`Briefing für ${date} — Thema: ${TOPIC_LABELS[activeTopic]}`);

  // Quellen laufen parallel; eine ausgefallene Quelle darf den Lauf nicht kippen.
  const settled = await Promise.allSettled(
    SOURCES.map((s) =>
      s.fetch({ topic: activeTopic, sinceDays: CONFIG.sinceDays, limit: CONFIG.limitPerSource }),
    ),
  );

  const studies: Study[] = [];
  settled.forEach((r, i) => {
    const src = SOURCES[i]!;
    if (r.status === 'fulfilled') {
      console.log(`  ${src.label}: ${r.value.length} Treffer`);
      studies.push(...r.value);
    } else {
      console.warn(`  ${src.label}: FEHLER — ${r.reason}`);
    }
  });

  if (studies.length === 0) throw new Error('Keine Quelle hat Treffer geliefert.');

  const unique = dedupe(studies);
  console.log(`${unique.length} Studien nach Dublettenabgleich`);

  const scored: ScoredStudy[] = unique.map((study) => ({ study, score: scoreStudy(study) }));
  const rejected = scored.filter((s) => s.score.rejected);
  if (rejected.length > 0) {
    console.log(`${rejected.length} aussortiert:`);
    for (const r of rejected.slice(0, 10)) {
      console.log(`  – ${r.score.rejectionReason}: ${r.study.title.slice(0, 70)}`);
    }
  }

  const history = skipHistory ? { entries: [] } : await loadHistory();
  const selection = select(scored, history, activeTopic);
  if (!selection) {
    throw new Error(
      'Nicht genug Material über der Qualitätsschwelle. Heute lieber keine Mail als eine schwache.',
    );
  }

  console.log(`Hauptfakt (${selection.lead.score.total}/100): ${selection.lead.study.title}`);

  const briefing = await writeBriefing(selection, activeTopic, date, env.anthropicApiKey);

  for (const w of checkNumbers(briefing, selection)) console.warn(`  Zahlen-Warnung: ${w}`);

  const html = renderEmailHtml(briefing);
  const text = renderEmailText(briefing);

  const mailer = dryRun ? createConsoleMailer() : createSmtpMailer(env);
  const result = await mailer.send({
    to: env.mailTo,
    subject: briefing.subject,
    html,
    text,
  });
  if (!result.ok) throw new Error(`Versand fehlgeschlagen: ${result.error}`);
  console.log(`Versendet über ${result.provider}`);

  // Archiv und History nur im Echtlauf fortschreiben.
  if (!dryRun) {
    await mkdir(ARCHIVE_DIR, { recursive: true });
    await writeFile(`${ARCHIVE_DIR}${date}.md`, renderMarkdown(briefing), 'utf8');
    await saveHistory(
      recordBriefing(history, briefing, [
        selection.lead.study,
        ...selection.shorts.map((s) => s.study),
      ]),
    );
  }
}

/** `--topic` überschreibt die Wochenrotation; nur gültige Themen sind erlaubt. */
function resolveTopic(raw: string | undefined, now: Date): Topic {
  if (!raw) return topicForDate(now);
  if ((TOPICS as readonly string[]).includes(raw)) return raw as Topic;
  throw new Error(`Unbekanntes Thema "${raw}". Möglich: ${TOPICS.join(', ')}`);
}

function loadEnvForDryRun() {
  return {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() ?? '',
    smtpUser: '',
    smtpPassword: '',
    smtpHost: '',
    smtpPort: 0,
    mailTo: process.env.MAIL_TO?.trim() || 'trockenlauf@example.com',
    mailFromName: 'Morgenbriefing',
  };
}

/** Datum in der konfigurierten Zeitzone, sonst kippt die Ausgabe um Mitternacht UTC. */
function formatDate(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: CONFIG.timezone }).format(d);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
