import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findDurations, durationParts, formatCountdown, checksFor, toggleCheck, clearChecks, CHECKS_EXPIRE,
  startTimer, timerLeft, timerDone, pauseTimer, resumeTimer, removeTimer,
} from '../js/cooking.js';

const found = (text) => findDurations(text).map((d) => [d.text, d.seconds]);

test('erkennt Zeitangaben in Schritten', () => {
  assert.deepEqual(found('20 Minuten backen'), [['20 Minuten', 1200]]);
  assert.deepEqual(found('20 Min. backen'), [['20 Min.', 1200]]);
  assert.deepEqual(found('1,5 Std. köcheln'), [['1,5 Std.', 5400]]);
  assert.deepEqual(found('1 Stunde 20 Minuten ruhen'), [['1 Stunde 20 Minuten', 4800]]);
  assert.deepEqual(found('1 Std. und 20 Min. garen'), [['1 Std. und 20 Min.', 4800]]);
  assert.deepEqual(found('30 Sekunden mixen'), [['30 Sekunden', 30]]);
  assert.deepEqual(found('eine halbe Stunde ziehen lassen'), [['eine halbe Stunde', 1800]]);
  assert.deepEqual(found('drei Minuten'), [['drei Minuten', 180]]);
  assert.deepEqual(found('2 h gehen lassen'), [['2 h', 7200]]);
});

test('bei einer Spanne läuft der Timer auf den kleineren Wert', () => {
  const [d] = findDurations('Im Ofen 10–15 Minuten backen');
  assert.equal(d.text, '10–15 Minuten');
  assert.equal(d.seconds, 600);
  assert.equal(d.max, 900);
  assert.deepEqual(found('25 bis 30 min backen'), [['25 bis 30 min', 1500]]);
});

test('Mengen und Temperaturen sind keine Zeiten', () => {
  assert.deepEqual(found('2 Scheiben Brot und 3 Eier'), []);
  assert.deepEqual(found('bei 180 Grad backen'), []);
  assert.deepEqual(found('über Nacht ziehen lassen'), []);
  assert.deepEqual(found('eine Handvoll Minze'), []);
  assert.deepEqual(found('4 Eier 5 Minuten kochen'), [['5 Minuten', 300]]);
});

test('zerlegt einen Schritt in Text und Zeiten', () => {
  assert.deepEqual(durationParts('Etwa 1 Stunde backen.'), [
    { text: 'Etwa ' }, { text: '1 Stunde', seconds: 3600 }, { text: ' backen.' },
  ]);
  assert.deepEqual(durationParts('Ofen vorheizen.'), [{ text: 'Ofen vorheizen.' }]);
});

test('zeigt die Restzeit an', () => {
  assert.equal(formatCountdown(600000), '10:00');
  assert.equal(formatCountdown(65000), '1:05');
  assert.equal(formatCountdown(3725000), '1:02:05');
  assert.equal(formatCountdown(400), '0:01');
  assert.equal(formatCountdown(-5), '0:00');
});

test('Haken werden pro Rezept gemerkt und laufen nach 12 Stunden ab', () => {
  let all = toggleCheck({}, 'r1', 'ing', 2, 1000);
  all = toggleCheck(all, 'r1', 'steps', 0, 2000);
  assert.deepEqual(checksFor(all, 'r1', 3000), { ing: [2], steps: [0] });
  assert.deepEqual(checksFor(all, 'r2', 3000), { ing: [], steps: [] });
  all = toggleCheck(all, 'r1', 'ing', 2, 4000);                 // zweiter Tipp nimmt den Haken zurück
  assert.deepEqual(checksFor(all, 'r1', 5000), { ing: [], steps: [0] });
  assert.deepEqual(checksFor(all, 'r1', 4000 + CHECKS_EXPIRE + 1), { ing: [], steps: [] });
  assert.equal(clearChecks(all, 'r1').r1, undefined);
  // Abgelaufene Rezepte fallen beim nächsten Haken weg, leere auch.
  const later = toggleCheck(all, 'r2', 'ing', 0, 4000 + CHECKS_EXPIRE + 1);
  assert.deepEqual(Object.keys(later), ['r2']);
  assert.deepEqual(toggleCheck(toggleCheck({}, 'r1', 'ing', 1, 0), 'r1', 'ing', 1, 1), {});
});

test('Timer laufen über die Endzeit, lassen sich anhalten und fortsetzen', () => {
  let timers = startTimer([], { label: 'Schritt 2', seconds: 600 }, 0);
  const [t] = timers;
  assert.equal(timerLeft(t, 60000), 540000);
  assert.equal(timerDone(t, 599999), false);
  assert.equal(timerDone(t, 600000), true);
  timers = pauseTimer(timers, t.id, 60000);
  assert.equal(timerLeft(timers[0], 500000), 540000);           // angehalten bleibt die Zeit stehen
  assert.equal(timerDone(timers[0], 10 ** 9), false);
  timers = resumeTimer(timers, t.id, 100000);
  assert.equal(timerLeft(timers[0], 100000), 540000);
  assert.equal(timerDone(timers[0], 640000), true);
  assert.deepEqual(removeTimer(timers, t.id), []);
});

import { stepAmounts, stepPieces } from '../js/cooking.js';

const ZUTATEN = [
  { amount: 250, unit: 'g', name: 'Mehl', note: 'Type 405' }, { amount: 100, unit: 'g', name: 'Butter' },
  { amount: 80, unit: 'g', name: 'Zucker' }, { amount: 3, unit: '', name: 'Eier' }, { amount: null, unit: '', name: 'Pfeffer' },
  { amount: 20, unit: 'g', name: 'Puderzucker' }, { amount: 200, unit: 'ml', name: 'Milch' },
];
// Kurzform: je Schritt [Zutat, Anteil]
const shares = (steps) => stepAmounts(steps, ZUTATEN).map((list) => list.map((a) => [ZUTATEN[a.ing].name, a.share]));

test('setzt die Menge hinter die Zutat im Schritt', () => {
  assert.deepEqual(shares(['Mehl, Zucker und Eier mischen.']), [[['Mehl', 1], ['Zucker', 1], ['Eier', 1]]]);
  const [list] = stepAmounts(['Mehl unterrühren.'], ZUTATEN);
  assert.deepEqual(list, [{ at: 4, ing: 0, share: 1 }]);
});

test('erkennt Anteile wie Hälfte, Drittel und Rest', () => {
  assert.deepEqual(shares([
    'Die Hälfte des Mehls unterrühren.',
    'Ein Drittel der Butter schmelzen, dann die Eier dazu.',
    'Restliches Mehl und die restliche Butter dazugeben.',
    '1/4 der Milch erwärmen, den Rest der Milch kalt dazu.',
  ]), [
    [['Mehl', 0.5]],
    [['Butter', 0.333], ['Eier', 1]],
    [['Mehl', 0.5], ['Butter', 0.667]],
    [['Milch', 0.25]],                                          // dieselbe Zutat zählt je Schritt einmal
  ]);
  assert.deepEqual(shares(['Zwei Drittel der Milch und drei Viertel des Zuckers verrühren.']), [[['Milch', 0.667], ['Zucker', 0.75]]]);
});

test('ohne Anteil steht die Menge nur beim ersten Mal', () => {
  assert.deepEqual(shares(['Butter schmelzen.', 'Form mit Butter einfetten.']), [[['Butter', 1]], []]);
  // "Rest" ohne vorherigen Anteil und "etwas" bekommen keine Menge.
  assert.deepEqual(shares(['Die restliche Milch dazu.', 'Etwas Zucker drüberstreuen.']), [[], []]);
});

test('Zutaten ohne Menge und ähnliche Wörter', () => {
  assert.deepEqual(shares(['Mit Pfeffer würzen.']), [[]]);
  assert.deepEqual(shares(['Mit Puderzucker bestreuen.']), [[['Puderzucker', 1]]]); // nicht der Zucker
  assert.deepEqual(shares(['Den Brei umrühren, ein Ei ist nicht drin.']), [[['Eier', 1]]]);
  assert.deepEqual(shares(['Weizenmehl sieben.']), [[['Mehl', 1]]]);
});

test('Stücke für die Anzeige: Text, Zeiten und Mengen in Reihenfolge', () => {
  const text = 'Mehl einrühren und 10 Minuten ruhen lassen.';
  const [amounts] = stepAmounts([text], ZUTATEN);
  assert.deepEqual(stepPieces(text, amounts), [
    { text: 'Mehl' }, { amount: { ing: 0, share: 1 } }, { text: ' einrühren und ' },
    { text: '10 Minuten', seconds: 600 }, { text: ' ruhen lassen.' },
  ]);
  assert.deepEqual(stepPieces('Ofen an.'), [{ text: 'Ofen an.' }]);
});
