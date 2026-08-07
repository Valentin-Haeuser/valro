import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Briefing, ScoredStudy, Study } from '../src/types';
import type { Selection } from '../src/select/selector';
import { checkNumbers } from '../src/write/writer';

/**
 * Die Fälle stammen aus dem ersten echten Lauf (07.08.2026, Thema Psychologie).
 * Er erzeugte drei Warnungen, und alle drei waren falsch — der Text stimmte,
 * die Prüfung konnte die Schreibweise des Abstracts nur nicht lesen.
 */
const ABSTRACT =
  'A total of twenty-three independent samples (N = 13,636) met the inclusion criteria. ' +
  'Expressive suppression showed a small but significant positive association with poorer ' +
  'sleep quality (r = .14, 95% CI [0.12, 0.16]).';

function scored(abstract: string): ScoredStudy {
  const study = { abstract } as Study;
  return { study } as ScoredStudy;
}

function selectionFrom(abstract: string): Selection {
  return { lead: scored(abstract), shorts: [] } as unknown as Selection;
}

/** Nur die vier Felder, die `checkNumbers` tatsächlich liest. */
function briefingWith(finding: string, evidence = '', caveat = ''): Briefing {
  return {
    lead: { finding, mechanism: '', evidence, caveat },
  } as unknown as Briefing;
}

describe('checkNumbers — legitime Übersetzungen lösen keinen Alarm aus', () => {
  test('ausgeschriebenes Zahlwort im Abstract, Ziffer im Text', () => {
    const w = checkNumbers(briefingWith('Eine Zusammenschau von 23 Stichproben.'), selectionFrom(ABSTRACT));
    assert.deepEqual(w, []);
  });

  test('zusammengesetztes Zahlwort wird nicht als Einer gelesen', () => {
    // "nineteen" darf nicht als "nine" durchrutschen, sonst gilt 9 als belegt.
    const w = checkNumbers(briefingWith('Es waren 19 Studien, nicht 91.'), selectionFrom('Nineteen trials were pooled.'));
    assert.deepEqual(w, ['Zahl "91" steht nicht im Abstract']);
  });

  test('Korrelation ohne führende Null im Abstract', () => {
    const w = checkNumbers(briefingWith('Die Kennzahl liegt bei 0,14, also klein.'), selectionFrom(ABSTRACT));
    assert.deepEqual(w, []);
  });

  test('Satzzeichen am Zahlenende wandert nicht in die Zahl', () => {
    const w = checkNumbers(briefingWith('Der Wert lag bei 0,14.'), selectionFrom(ABSTRACT));
    assert.deepEqual(w, []);
  });

  test('bewusste Rundung nach unten und nach oben', () => {
    const runter = checkNumbers(briefingWith('', 'Über 13.000 Erwachsene.'), selectionFrom(ABSTRACT));
    assert.deepEqual(runter, []);

    const hoch = checkNumbers(briefingWith('', 'Rund 14.000 Erwachsene.'), selectionFrom(ABSTRACT));
    assert.deepEqual(hoch, []);
  });

  test('exakte Zahl mit deutschem Tausenderpunkt', () => {
    const w = checkNumbers(briefingWith('Insgesamt 13.636 Erwachsene.'), selectionFrom(ABSTRACT));
    assert.deepEqual(w, []);
  });

  test('Jahreszahlen sind harmlos', () => {
    const w = checkNumbers(briefingWith('Die Daten stammen aus 2019 bis 2024.'), selectionFrom(ABSTRACT));
    assert.deepEqual(w, []);
  });
});

describe('checkNumbers — erfundene Zahlen fliegen weiterhin auf', () => {
  test('frei erfundener Prozentwert', () => {
    const w = checkNumbers(briefingWith('Der Schlaf verbesserte sich um 42 Prozent.'), selectionFrom(ABSTRACT));
    assert.deepEqual(w, ['Zahl "42" steht nicht im Abstract']);
  });

  test('plausibel klingende, aber falsche Teilnehmerzahl', () => {
    const w = checkNumbers(briefingWith('An der Untersuchung nahmen 13.700 Menschen teil.'), selectionFrom(ABSTRACT));
    assert.deepEqual(w, ['Zahl "13.700" steht nicht im Abstract']);
  });

  test('Rundung deckt nicht die nächste Größenordnung', () => {
    // 13.636 rundet auf 13.000/14.000 — 20.000 bleibt eine Erfindung.
    const w = checkNumbers(briefingWith('Etwa 20.000 Teilnehmende.'), selectionFrom(ABSTRACT));
    assert.deepEqual(w, ['Zahl "20.000" steht nicht im Abstract']);
  });

  test('auch Kurzstudien-Abstracts zählen als Beleg', () => {
    const selection = {
      lead: scored(ABSTRACT),
      shorts: [scored('Seven studies with 273 participants were included.')],
    } as unknown as Selection;
    assert.deepEqual(checkNumbers(briefingWith('Sieben Studien mit 273 Teilnehmenden.'), selection), []);
  });
});
