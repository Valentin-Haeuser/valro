/**
 * Mail-Renderer für das tägliche Briefing.
 *
 * Zielclient ist Gmail (Web, Android, iOS), gelesen wird auf dem Handy.
 * Daraus folgen die Regeln, die hier konsequent durchgezogen werden:
 *
 *  - Tabellenlayout, kein flexbox/grid.
 *  - Jede einzelne Deklaration steht inline am Element. Der `<style>`-Block
 *    im Kopf ist reiner Bonus (Dark-Mode-Feinschliff) und darf ersatzlos
 *    wegfallen, ohne dass das Layout leidet.
 *  - Keine externen Ressourcen: keine Bilder, keine Webfonts, kein JS.
 *  - Farben sind so gewählt, dass sie auch nach Gmails automatischer
 *    Dark-Mode-Invertierung lesbar bleiben: kein reines Weiß, kein reines
 *    Schwarz, die stark hervorgehobenen Kästen sind von Haus aus dunkel.
 *  - Alles, was aus dem `Briefing` kommt, läuft durch `escapeHtml()`.
 *    Studientitel enthalten regelmäßig & < > " und Anführungszeichen.
 */

import type { Briefing, LeadFact, ShortFact, StudyRef } from '../types.js';
import { TOPIC_LABELS } from '../types.js';

/* ------------------------------------------------------------------ *
 * Escaping
 * ------------------------------------------------------------------ */

/**
 * Escaped alles, was in HTML-Text *und* in Attributwerten gefährlich ist.
 * Bewusst inklusive `'` und `"`, damit dieselbe Funktion für beides taugt.
 */
function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * URLs für `href`. Erlaubt nur http/https/mailto — alles andere
 * (javascript:, data:, …) fliegt raus und der Link wird zu reinem Text.
 */
function safeUrl(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  if (!/^(https?:|mailto:)/i.test(value)) return null;
  // Whitespace und Steuerzeichen würden das href-Attribut aufbrechen.
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 32 || code === 127) return null;
  }
  return escapeHtml(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/* ------------------------------------------------------------------ *
 * Datum
 * ------------------------------------------------------------------ */

/** "2026-08-07" → "Donnerstag, 7. August 2026". Fällt auf die Rohform zurück. */
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

/** "2026-08-07" → "07.08.2026", für die dezente Fußzeile. */
function formatDateShortDe(iso: string): string {
  const raw = text(iso).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return raw;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

function topicLabel(b: Briefing): string {
  return TOPIC_LABELS[b.topic] ?? text(b.topic);
}

/* ------------------------------------------------------------------ *
 * Design-Tokens
 * ------------------------------------------------------------------ */

const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',Times,serif";

const C = {
  /** Seitenhintergrund, hell aber nicht weiß — überlebt Invertierung. */
  page: '#e8ebef',
  card: '#fbfbf9',
  ink: '#14181d',
  body: '#2c323b',
  muted: '#59616e',
  hairline: '#dcdfe5',
  accent: '#0f5f7a',
  accentInk: '#0b3a4b',
  accentSoft: '#e5eef2',
  /** Dunkle Flächen: bleiben im Dark Mode ohnehin dunkel. */
  deep: '#103b4c',
  deepInk: '#f2f8fa',
  deepMuted: '#9dc0cd',
  warnBg: '#fdf2df',
  warnLine: '#c4831f',
  warnInk: '#63430c',
  sourceBg: '#f1f3f5',
};

/* ------------------------------------------------------------------ *
 * Bausteine
 * ------------------------------------------------------------------ */

/** Kleine Überschrift über einem Block. */
function sectionLabel(label: string, color: string = C.accent): string {
  return (
    `<div style="font-family:${SANS};font-size:12px;line-height:1.4;` +
    `letter-spacing:1.1px;text-transform:uppercase;font-weight:700;` +
    `color:${color};">${escapeHtml(label)}</div>`
  );
}

/** Eine Zeile im Hauptstrang: Label + Inhalt, mit Abstand nach unten. */
function block(label: string, inner: string, paddingBottom = 26): string {
  return (
    `<tr><td style="padding:0 0 8px 0;">${sectionLabel(label)}</td></tr>` +
    `<tr><td style="padding:0 0 ${paddingBottom}px 0;">${inner}</td></tr>`
  );
}

function paragraph(
  value: string,
  opts: { size?: number; color?: string; font?: string; weight?: number } = {},
): string {
  const size = opts.size ?? 17;
  const color = opts.color ?? C.body;
  const font = opts.font ?? SANS;
  const weight = opts.weight ?? 400;
  return (
    `<div style="font-family:${font};font-size:${size}px;line-height:1.62;` +
    `font-weight:${weight};color:${color};">${escapeHtml(value)}</div>`
  );
}

/** Farbiger Kasten mit linker Akzentkante — Basis für Befund/Warnung/Merksatz. */
function calloutBox(inner: string, bg: string, edge: string, radius = 10): string {
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;border-collapse:separate;background-color:${bg};` +
    `border-left:4px solid ${edge};border-radius:${radius}px;">` +
    `<tr><td style="padding:16px 18px 17px 16px;">${inner}</td></tr></table>`
  );
}

/** Quellenangabe: Titel als Link, darunter Journal · Jahr, darunter Evidenz-Pille. */
function studyBlock(study: StudyRef | undefined, opts: { compact?: boolean } = {}): string {
  if (!study) return '';
  const compact = opts.compact === true;
  const title = text(study.title) || 'Studie';
  const href = safeUrl(study.url);
  const titleSize = compact ? 15 : 16;

  const titleHtml = href
    ? `<a href="${href}" target="_blank" rel="noopener" ` +
      `style="font-family:${SANS};font-size:${titleSize}px;line-height:1.5;font-weight:700;` +
      `color:${C.accent};text-decoration:underline;">${escapeHtml(title)}</a>`
    : `<span style="font-family:${SANS};font-size:${titleSize}px;line-height:1.5;` +
      `font-weight:700;color:${C.accentInk};">${escapeHtml(title)}</span>`;

  const metaParts: string[] = [];
  const journal = text(study.journal);
  if (journal) metaParts.push(journal);
  if (typeof study.year === 'number' && Number.isFinite(study.year)) {
    metaParts.push(String(study.year));
  }
  const doi = text(study.doi);
  if (doi) metaParts.push(`DOI ${doi}`);

  const metaHtml = metaParts.length
    ? `<div style="font-family:${SANS};font-size:14px;line-height:1.5;color:${C.muted};` +
      `padding-top:5px;">${escapeHtml(metaParts.join(' · '))}</div>`
    : '';

  const evidence = text(study.evidenceLabel);
  const evidenceHtml = evidence
    ? `<div style="padding-top:10px;">` +
      `<span style="display:inline-block;font-family:${SANS};font-size:13px;line-height:1.45;` +
      `font-weight:700;color:${C.accentInk};background-color:${C.accentSoft};` +
      `border:1px solid #c6dbe3;border-radius:6px;padding:5px 10px;">` +
      `${escapeHtml(evidence)}</span></div>`
    : '';

  const inner = titleHtml + metaHtml + evidenceHtml;

  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;border-collapse:separate;background-color:${C.sourceBg};` +
    `border:1px solid ${C.hairline};border-radius:10px;">` +
    `<tr><td style="padding:${compact ? '13px 15px' : '15px 17px'};">` +
    `<div style="font-family:${SANS};font-size:11px;line-height:1.4;letter-spacing:1.1px;` +
    `text-transform:uppercase;font-weight:700;color:${C.muted};padding-bottom:7px;">Quelle</div>` +
    `${inner}</td></tr></table>`
  );
}

/** Ein Kurzfakt als kompakter Block mit Nummer. */
function shortBlock(short: ShortFact, index: number): string {
  const finding = text(short?.finding);
  const evidence = text(short?.evidence);

  const number =
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
    `style="border-collapse:separate;"><tr>` +
    `<td width="26" height="26" align="center" valign="middle" ` +
    `style="width:26px;height:26px;background-color:${C.accent};border-radius:13px;` +
    `font-family:${SANS};font-size:14px;line-height:26px;font-weight:700;color:#f2f8fa;` +
    `text-align:center;">${index}</td></tr></table>`;

  const evidenceHtml = evidence
    ? `<div style="font-family:${SANS};font-size:16px;line-height:1.6;color:${C.muted};` +
      `padding-top:8px;">${escapeHtml(evidence)}</div>`
    : '';

  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;border-collapse:separate;background-color:${C.card};` +
    `border:1px solid ${C.hairline};border-radius:12px;">` +
    `<tr><td style="padding:18px 18px 19px 18px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">` +
    `<tr><td style="padding:0 0 12px 0;">${number}</td></tr>` +
    `<tr><td style="padding:0 0 14px 0;">` +
    paragraph(finding, { size: 17, color: C.ink, weight: 600 }) +
    evidenceHtml +
    `</td></tr>` +
    `<tr><td>${studyBlock(short?.study, { compact: true })}</td></tr>` +
    `</table></td></tr></table>`
  );
}

/* ------------------------------------------------------------------ *
 * HTML
 * ------------------------------------------------------------------ */

export function renderEmailHtml(b: Briefing): string {
  const lead: LeadFact = b.lead ?? ({} as LeadFact);
  const shorts: ShortFact[] = Array.isArray(b.shorts) ? b.shorts.filter(Boolean) : [];

  const dateLine = formatDateDe(b.date);
  const topic = topicLabel(b);
  const subject = text(b.subject) || `${topic} — ${dateLine}`;

  const hook = text(lead.hook);
  const finding = text(lead.finding);
  const mechanism = text(lead.mechanism);
  const evidence = text(lead.evidence);
  const caveat = text(lead.caveat);
  const dinnerLine = text(lead.dinnerLine);

  /* Preheader: die Zeile, die Gmail in der Inbox-Übersicht anzeigt. */
  const preheaderText = hook || finding || subject;
  const preheaderPad = '&#847;&zwnj;&nbsp;'.repeat(60);

  const rows: string[] = [];

  if (hook) {
    rows.push(
      block(
        'Die Frage',
        `<div style="font-family:${SERIF};font-size:23px;line-height:1.42;` +
          `font-weight:700;color:${C.ink};">${escapeHtml(hook)}</div>`,
        24,
      ),
    );
  }

  if (finding) {
    rows.push(
      block(
        'Der Befund',
        calloutBox(
          `<div style="font-family:${SANS};font-size:18px;line-height:1.5;font-weight:600;` +
            `color:${C.accentInk};">${escapeHtml(finding)}</div>`,
          C.accentSoft,
          C.accent,
        ),
        26,
      ),
    );
  }

  if (mechanism) {
    rows.push(block('Warum das so ist', paragraph(mechanism), 26));
  }

  if (evidence) {
    rows.push(block('Wie gut belegt', paragraph(evidence), 26));
  }

  if (caveat) {
    rows.push(
      `<tr><td style="padding:0 0 8px 0;">${sectionLabel('Was die Studie nicht sagt', C.warnInk)}</td></tr>` +
        `<tr><td style="padding:0 0 26px 0;">` +
        calloutBox(
          `<div style="font-family:${SANS};font-size:16px;line-height:1.6;color:${C.warnInk};">` +
            `${escapeHtml(caveat)}</div>`,
          C.warnBg,
          C.warnLine,
        ) +
        `</td></tr>`,
    );
  }

  if (dinnerLine) {
    rows.push(
      `<tr><td style="padding:0 0 26px 0;">` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
        `style="width:100%;border-collapse:separate;background-color:${C.deep};border-radius:12px;">` +
        `<tr><td style="padding:18px 20px 20px 20px;">` +
        `<div style="font-family:${SANS};font-size:12px;line-height:1.4;letter-spacing:1.1px;` +
        `text-transform:uppercase;font-weight:700;color:${C.deepMuted};padding-bottom:9px;">` +
        `Satz für heute Abend</div>` +
        `<div style="font-family:${SERIF};font-size:19px;line-height:1.55;color:${C.deepInk};">` +
        `${escapeHtml(dinnerLine)}</div>` +
        `</td></tr></table></td></tr>`,
    );
  }

  if (lead.study) {
    rows.push(`<tr><td style="padding:0 0 4px 0;">${studyBlock(lead.study)}</td></tr>`);
  }

  /* Nachschläge */
  let shortsHtml = '';
  if (shorts.length) {
    const heading =
      shorts.length === 1 ? 'Noch ein Fakt' : shorts.length === 2 ? 'Noch zwei Fakten' : 'Nachschläge';
    const items = shorts
      .map(
        (s, i) =>
          `<tr><td style="padding:0 0 ${i === shorts.length - 1 ? 0 : 16}px 0;">` +
          `${shortBlock(s, i + 1)}</td></tr>`,
      )
      .join('');

    shortsHtml =
      `<tr><td class="vr-pad" style="background-color:${C.page};border-top:1px solid ${C.hairline};` +
      `padding:26px 22px 28px 22px;">` +
      `<div style="font-family:${SERIF};font-size:19px;line-height:1.4;font-weight:700;` +
      `color:${C.ink};padding-bottom:16px;">${escapeHtml(heading)}</div>` +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">` +
      `${items}</table></td></tr>`;
  }

  const generated = text(b.generatedAt);
  const generatedHint = generated
    ? `<div style="font-family:${SANS};font-size:12px;line-height:1.6;color:${C.muted};` +
      `padding-top:6px;">Erstellt am ${escapeHtml(formatDateShortDe(generated))}</div>`
    : '';

  return `<!doctype html>
<html lang="de" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${escapeHtml(subject)}</title>
<style type="text/css">
  /* Reiner Bonus: Gmail entfernt diesen Block in vielen Kontexten, das
     Layout steht deshalb vollständig auf den Inline-Styles.
     Bewusst zurückhaltend — hier werden nur Flächen angefasst, auf denen
     kein Text sitzt. Würde man die Karte dunkel färben, blieben die inline
     gesetzten dunklen Textfarben stehen und nichts wäre mehr lesbar. */
  body { margin:0 !important; padding:0 !important; width:100% !important; }
  img { border:0; outline:none; text-decoration:none; }
  @media only screen and (max-width:420px) {
    .vr-pad { padding-left:16px !important; padding-right:16px !important; }
  }
  @media (prefers-color-scheme: dark) {
    /* Nur der Rahmen um die Karte wird dunkel; die Karte selbst bleibt
       hell und in sich stimmig kontrastiert. */
    .vr-page { background-color:#12161a !important; }
  }
</style>
</head>
<body class="vr-page" style="margin:0;padding:0;width:100%;background-color:${C.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${C.page};">${escapeHtml(preheaderText)}</div>
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${C.page};">${preheaderPad}</div>
<table role="presentation" class="vr-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background-color:${C.page};">
  <tr>
    <td align="center" style="padding:18px 12px 26px 12px;">
      <table role="presentation" class="vr-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;background-color:${C.card};border:1px solid ${C.hairline};border-radius:14px;overflow:hidden;">

        <!-- Kopf -->
        <tr>
          <td class="vr-pad" style="background-color:${C.deep};padding:22px 22px 24px 22px;border-radius:14px 14px 0 0;">
            <div style="font-family:${SANS};font-size:12px;line-height:1.4;letter-spacing:1.3px;text-transform:uppercase;font-weight:700;color:${C.deepMuted};">${escapeHtml(dateLine)}</div>
            <div style="font-family:${SERIF};font-size:25px;line-height:1.3;font-weight:700;color:${C.deepInk};padding-top:7px;">${escapeHtml(topic)}</div>
            <div style="font-family:${SANS};font-size:13px;line-height:1.5;color:${C.deepMuted};padding-top:8px;">Ein Fakt aus einer echten Studie — plus zwei Nachschläge.</div>
          </td>
        </tr>

        <!-- Hauptfakt -->
        <tr>
          <td class="vr-pad" style="padding:26px 22px 24px 22px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
              ${rows.join('\n              ')}
            </table>
          </td>
        </tr>

        <!-- Nachschläge -->
        ${shortsHtml}

        <!-- Fußzeile -->
        <tr>
          <td class="vr-pad" style="background-color:${C.card};border-top:1px solid ${C.hairline};padding:20px 22px 24px 22px;border-radius:0 0 14px 14px;" align="center">
            <div style="font-family:${SANS};font-size:13px;line-height:1.6;color:${C.muted};">Täglich ein geprüfter Fakt. Jede Zahl steht in der verlinkten Studie.</div>
            ${generatedHint}
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/* ------------------------------------------------------------------ *
 * Plaintext
 * ------------------------------------------------------------------ */

const WIDTH = 78;

/** Weicher Umbruch bei ~78 Zeichen; überlange Einzelwörter (URLs) bleiben heil. */
function wrap(value: string, width = WIDTH, indent = ''): string {
  const source = text(value);
  if (!source) return '';
  const out: string[] = [];

  for (const paragraph of source.split(/\r?\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    let line = indent;
    for (const word of words) {
      const candidate = line === indent ? indent + word : `${line} ${word}`;
      if (candidate.length > width && line !== indent) {
        out.push(line);
        line = indent + word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

function rule(char = '-', width = WIDTH): string {
  return char.repeat(width);
}

function textSection(label: string, value: string): string[] {
  const body = wrap(value);
  if (!body) return [];
  return [label.toUpperCase(), body, ''];
}

function textStudy(study: StudyRef | undefined, indent = ''): string[] {
  if (!study) return [];
  const lines: string[] = [];
  const title = text(study.title) || 'Studie';
  lines.push(wrap(`Quelle: ${title}`, WIDTH, indent));

  const meta: string[] = [];
  const journal = text(study.journal);
  if (journal) meta.push(journal);
  if (typeof study.year === 'number' && Number.isFinite(study.year)) meta.push(String(study.year));
  const evidence = text(study.evidenceLabel);
  if (evidence) meta.push(evidence);
  if (meta.length) lines.push(wrap(meta.join(' · '), WIDTH, `${indent}  `));

  const url = text(study.url);
  if (url) lines.push(`${indent}  ${url}`);
  const doi = text(study.doi);
  if (doi) lines.push(`${indent}  DOI: ${doi}`);
  return lines;
}

export function renderEmailText(b: Briefing): string {
  const lead: LeadFact = b.lead ?? ({} as LeadFact);
  const shorts: ShortFact[] = Array.isArray(b.shorts) ? b.shorts.filter(Boolean) : [];

  const dateLine = formatDateDe(b.date);
  const topic = topicLabel(b);

  const lines: string[] = [];

  lines.push(rule('='));
  lines.push(wrap(`${dateLine.toUpperCase()} · ${topic.toUpperCase()}`));
  const subject = text(b.subject);
  if (subject) lines.push(wrap(subject));
  lines.push(rule('='));
  lines.push('');

  lines.push(...textSection('Die Frage', lead.hook));
  lines.push(...textSection('Der Befund', lead.finding));
  lines.push(...textSection('Warum das so ist', lead.mechanism));
  lines.push(...textSection('Wie gut belegt', lead.evidence));
  lines.push(...textSection('Was die Studie nicht sagt', lead.caveat));

  const dinner = text(lead.dinnerLine);
  if (dinner) {
    lines.push('SATZ FÜR HEUTE ABEND');
    lines.push(rule('-'));
    lines.push(wrap(dinner));
    lines.push(rule('-'));
    lines.push('');
  }

  if (lead.study) {
    lines.push(...textStudy(lead.study));
    lines.push('');
  }

  if (shorts.length) {
    const heading =
      shorts.length === 1 ? 'NOCH EIN FAKT' : shorts.length === 2 ? 'NOCH ZWEI FAKTEN' : 'NACHSCHLÄGE';
    lines.push(rule('='));
    lines.push(heading);
    lines.push(rule('='));
    lines.push('');

    shorts.forEach((short, i) => {
      const finding = text(short.finding);
      if (finding) {
        // Hängender Einzug: Folgezeilen stehen unter dem Text, nicht unter der Nummer.
        const wrapped = wrap(finding, WIDTH, '   ');
        lines.push(`${i + 1})${wrapped.slice(2)}`);
      }
      const evidence = text(short.evidence);
      if (evidence) {
        lines.push('');
        lines.push(wrap(evidence, WIDTH, '   '));
      }
      const studyLines = textStudy(short.study, '   ');
      if (studyLines.length) {
        lines.push('');
        lines.push(...studyLines);
      }
      if (i < shorts.length - 1) {
        lines.push('');
        lines.push(rule('-'));
        lines.push('');
      }
    });
    lines.push('');
  }

  lines.push(rule('-'));
  lines.push(wrap('Täglich ein geprüfter Fakt. Jede Zahl steht in der verlinkten Studie.'));
  const generated = text(b.generatedAt);
  if (generated) lines.push(`Erstellt am ${formatDateShortDe(generated)}`);

  // Mehr als eine Leerzeile am Stück sieht in Plaintext unruhig aus.
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
