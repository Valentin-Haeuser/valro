import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ROTATION, isoWeek, topicForDate, weekIndex } from '../src/config';
import { TOPICS } from '../src/types';

const mo = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('Themenrotation', () => {
  test('alle zehn Themen kommen genau einmal vor', () => {
    const belegt = ROTATION.flatMap((w) => Object.values(w));
    assert.equal(belegt.length, TOPICS.length);
    assert.equal(new Set(belegt).size, TOPICS.length);
  });

  test('der erste echte Lauf bleibt Psychologie', () => {
    // Fr, 07.08.2026 — diese Ausgabe ist verschickt und steht in der History.
    assert.equal(topicForDate(mo('2026-08-07')), 'psychology');
  });

  test('die Woche darauf beginnt mit Lernen & Gedächtnis', () => {
    assert.equal(topicForDate(mo('2026-08-10')), 'learning');
  });

  test('am Wochenende fällt die Zuordnung nicht auf einen Wochentag zurück', () => {
    // Der Cron läuft Mo–Fr; ein Handstart am Samstag darf trotzdem nicht
    // versehentlich das Montagsthema erwischen.
    assert.notEqual(topicForDate(mo('2026-08-08')), topicForDate(mo('2026-08-10')));
  });
});

describe('Wochenzähler über den Jahreswechsel', () => {
  test('KW 53 und KW 1 folgen aufeinander, ohne die Hälfte zu wiederholen', () => {
    // 2026 hat 53 ISO-Wochen. Mit gerade/ungerade auf der Kalenderwoche
    // hätten KW 53 und KW 1 dieselbe Hälfte erwischt.
    assert.equal(isoWeek(mo('2026-12-28')), 53);
    assert.equal(isoWeek(mo('2027-01-04')), 1);
    assert.notEqual(topicForDate(mo('2026-12-28')), topicForDate(mo('2027-01-04')));
  });

  test('der Zähler läuft über den Jahreswechsel um genau eins weiter', () => {
    assert.equal(weekIndex(mo('2027-01-04')) - weekIndex(mo('2026-12-28')), 1);
  });

  test('fünf Jahre lang wechselt jeder Montag das Thema', () => {
    let vorher: string | null = null;
    for (let i = 0; i < 260; i++) {
      const d = new Date(Date.UTC(2026, 7, 3 + i * 7));
      const jetzt = topicForDate(d);
      assert.notEqual(jetzt, vorher, `Wiederholung am ${d.toISOString().slice(0, 10)}`);
      vorher = jetzt;
    }
  });

  test('auch rückwärts bleibt der Index im gültigen Bereich', () => {
    // Vor der Ankerwoche wird die Differenz negativ.
    for (const iso of ['2025-01-06', '2020-06-15', '1999-12-27']) {
      assert.ok(TOPICS.includes(topicForDate(mo(iso))));
    }
  });
});
