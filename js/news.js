// "Was ist neu": beim ersten Start nach einem Update zeigt die App, was dazugekommen ist.
// Neueste Fassung zuerst. version ist frei wählbar, muss sich aber je Eintrag unterscheiden;
// gespeichert wird immer nur die Version des obersten Eintrags. ziel ist eine Adresse in der
// App, die der Knopf hinter der Zeile öffnet.

export const NEWS = [
  {
    version: '2026-10-18-auge',
    title: 'Geteilte Kochbücher ausblenden',
    lines: [
      { text: 'Unter „Teilen“ steht hinter jedem Kochbuch, das jemand mit dir teilt, ein Auge. Ausgeblendete Kochbücher tauchen bei „Was kochen?“, in der Saison und beim Kombinieren nicht mehr auf.', ziel: '#/geteilt' },
    ],
  },
  {
    version: '2026-10-18-geheimnis',
    title: 'Familiengeheimnis',
    lines: [
      { text: 'Im Bearbeiten-Formular gibt es das Häkchen „Familiengeheimnis“. Solche Rezepte sehen Leser deines Kochbuchs nicht, auch nicht bei „Was kochen?“ oder als Alternative. Wem du das Rezept einzeln schickst, der sieht es trotzdem.', ziel: '#/hilfe/teilen' },
    ],
  },
  {
    version: '2026-10-18-namen',
    title: 'Eindeutige Benutzernamen',
    lines: [
      { text: 'Beim Registrieren und beim Ändern deines Namens siehst du schon beim Tippen, ob der Name noch frei ist. Jeder Name gehört genau einer Person.', ziel: '#/geteilt' },
    ],
  },
  {
    version: '2026-10-18-nav',
    title: 'Kopfzeile aufgeräumt',
    lines: [
      { text: 'Abmelden steht jetzt unter „Verwalten“, nicht mehr oben in der Leiste.', ziel: '#/verwalten' },
      { text: '„+ Rezept“ erscheint nur noch auf der Rezept-Übersicht, damit oben mehr Platz ist.' },
    ],
  },
  {
    version: '2026-10-18',
    title: 'Hilfe und Nährwerte',
    lines: [
      { text: 'Hilfe: Der Reiter „Verwalten“ führt zur Hilfeseite, und das Fragezeichen oben rechts erklärt die Seite, auf der du gerade bist.', ziel: '#/hilfe' },
      { text: 'Nährwerte aus den Zutaten: Im Bearbeiten-Formular schätzt „Nährwerte ermitteln“ die Werte für eine Portion.', ziel: '#/hilfe/naehrwerte' },
      { text: 'Videos und Bilder stehen jetzt direkt über der Zubereitung, und ein Zeitstempel startet das Video auch bei TikTok.', ziel: '#/hilfe/videos' },
    ],
  },
  {
    version: '2026-10-17',
    title: 'Alternativen und Kombinieren',
    lines: [
      { text: 'Alternativrezepte: Verknüpfte Rezepte liegen als Kartenstapel hinter dem Rezept und lassen sich durchwischen.', ziel: '#/hilfe/alternativen' },
      { text: 'Rezepte kombinieren: Aus mehreren Rezepten ein neues bauen, Schritt für Schritt.', ziel: '#/hilfe/alternativen' },
      { text: 'Die Übersicht lässt sich nach Bewertung, Anlagedatum und „zuletzt gekocht“ sortieren.', ziel: '#/hilfe/rezepte' },
    ],
  },
];

export const latestVersion = () => NEWS[0]?.version ?? '';

// Die Einträge, die seit dem letzten Besuch dazugekommen sind. seen = gespeicherte Version;
// beim allerersten Start ist nichts gespeichert, dann zeigt die App nichts (wer die App neu
// hat, braucht keine Liste von Änderungen). Ist die gespeicherte Version unbekannt, weil der
// Eintrag inzwischen gestrichen wurde, kommen höchstens die drei neuesten.
export function newsSince(seen, news = NEWS) {
  if (!seen) return [];
  const at = news.findIndex((n) => n.version === seen);
  return at === -1 ? news.slice(0, 3) : news.slice(0, at);
}
