/**
 * Markdown-Renderer fürs Repo-Archiv.
 *
 * Eine Datei pro Ausgabe, mit YAML-Frontmatter, damit sich der Bestand
 * später maschinell durchsuchen lässt (Thema, Datum, Betreff), und mit
 * verlinkten Studien, damit man jede Zahl nachschlagen kann.
 */

import type { Briefing, LeadFact, ShortFact, StudyRef } from '../types.js';
import { TOPIC_LABELS } from '../types.js';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Normalisiert Zeilenumbrüche innerhalb eines Feldes zu einem Fließabsatz. */
function flat(value: unknown): string {
  return text(value).replace(/\s*\n\s*/g, ' ');
}

/** Zeichen, die Markdown sonst als Auszeichnung liest. */
function mdEscape(value: unknown): string {
  return flat(value)
    .replace(/([\\`*_[\]<>|])/g, '\\$1')
    .replace(/^([#>\-+])/, '\\$1');
}

/** Werte im Frontmatter immer doppelt gequotet — Betreffzeilen enthalten `:`. */
function yamlString(value: unknown): string {
  const raw = flat(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${raw}"`;
}

function formatDateDe(iso: string): string {
  const raw = text(iso);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) return raw;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat('de-DE', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  } catch {
    return raw;
  }
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 32 || code === 127) return false;
  }
  return true;
}

/** Quellenzeile: verlinkter Titel + Journal · Jahr · Evidenzlabel (+ DOI). */
function studyLine(study: StudyRef | undefined): string {
  if (!study) return '';
  const title = text(study.title) || 'Studie';
  const url = text(study.url);
  // Klammern in der URL würden das Linkziel vorzeitig beenden — dann spitze Klammern.
  const target = /[()]/.test(url) ? `<${url}>` : url;
  const linked = isHttpUrl(url) ? `[${mdEscape(title)}](${target})` : mdEscape(title);

  const meta: string[] = [];
  const journal = text(study.journal);
  if (journal) meta.push(mdEscape(journal));
  if (typeof study.year === 'number' && Number.isFinite(study.year)) meta.push(String(study.year));
  const evidence = text(study.evidenceLabel);
  if (evidence) meta.push(mdEscape(evidence));
  const doi = text(study.doi);
  if (doi) meta.push(`DOI: ${mdEscape(doi)}`);

  const metaText = meta.length ? ` — ${meta.join(' · ')}` : '';
  return `**Quelle:** ${linked}${metaText}`;
}

export function renderMarkdown(b: Briefing): string {
  const lead: LeadFact = b.lead ?? ({} as LeadFact);
  const shorts: ShortFact[] = Array.isArray(b.shorts) ? b.shorts.filter(Boolean) : [];

  const date = text(b.date);
  const topic = text(b.topic);
  const label = TOPIC_LABELS[b.topic] ?? topic;
  const subject = text(b.subject);
  const generatedAt = text(b.generatedAt);

  const out: string[] = [];

  /* Frontmatter */
  out.push('---');
  out.push(`date: ${yamlString(date)}`);
  out.push(`topic: ${yamlString(topic)}`);
  out.push(`topicLabel: ${yamlString(label)}`);
  out.push(`subject: ${yamlString(subject)}`);
  if (generatedAt) out.push(`generatedAt: ${yamlString(generatedAt)}`);
  out.push('---');
  out.push('');

  /* Kopf */
  out.push(`# ${mdEscape(subject || label)}`);
  out.push('');
  out.push(`*${formatDateDe(date)} · ${mdEscape(label)}*`);
  out.push('');

  /* Hauptfakt */
  out.push('## Hauptfakt');
  out.push('');

  const hook = flat(lead.hook);
  if (hook) {
    out.push(`> ${mdEscape(hook)}`);
    out.push('');
  }

  const sections: Array<[string, unknown]> = [
    ['Der Befund', lead.finding],
    ['Warum das so ist', lead.mechanism],
    ['Wie gut belegt', lead.evidence],
    ['Was die Studie nicht sagt', lead.caveat],
  ];

  for (const [heading, value] of sections) {
    const body = flat(value);
    if (!body) continue;
    out.push(`### ${heading}`);
    out.push('');
    out.push(mdEscape(body));
    out.push('');
  }

  const dinner = flat(lead.dinnerLine);
  if (dinner) {
    out.push('### Satz für heute Abend');
    out.push('');
    out.push(`> **${mdEscape(dinner)}**`);
    out.push('');
  }

  const leadSource = studyLine(lead.study);
  if (leadSource) {
    out.push(leadSource);
    out.push('');
  }

  /* Nachschläge */
  if (shorts.length) {
    const heading =
      shorts.length === 1 ? 'Noch ein Fakt' : shorts.length === 2 ? 'Noch zwei Fakten' : 'Nachschläge';
    out.push('---');
    out.push('');
    out.push(`## ${heading}`);
    out.push('');

    shorts.forEach((short, i) => {
      // Der Befund ist zu lang für eine Überschrift — die Nummer trägt die Gliederung.
      out.push(`### Nachschlag ${i + 1}`);
      out.push('');
      const finding = flat(short.finding);
      if (finding) {
        out.push(`**${mdEscape(finding)}**`);
        out.push('');
      }
      const evidence = flat(short.evidence);
      if (evidence) {
        out.push(mdEscape(evidence));
        out.push('');
      }
      const source = studyLine(short.study);
      if (source) {
        out.push(source);
        out.push('');
      }
    });
  }

  /* Fußzeile */
  out.push('---');
  out.push('');
  out.push('*Täglich ein geprüfter Fakt. Jede Zahl steht in der verlinkten Studie.*');
  if (generatedAt) {
    out.push('');
    out.push(`*Erstellt: ${mdEscape(generatedAt)}*`);
  }
  out.push('');

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
