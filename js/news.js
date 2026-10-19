// "Was ist neu": beim ersten Start nach einem Update zeigt die App, was dazugekommen ist.
// Neueste Fassung zuerst. version ist frei wählbar, muss sich aber je Eintrag unterscheiden;
// gespeichert wird immer nur die Version des obersten Eintrags. ziel ist eine Adresse in der
// App, die der Knopf hinter der Zeile öffnet.

export const NEWS = [
  {
    version: '2026-10-19-zeitfilter',
    title: 'Filter nach Zeit',
    lines: [
      { text: 'In der Übersicht, bei „Was kochen?“ und im Saisonkalender zeigen „bis 15 Min.“ bis „bis 1 Std.“ nur Rezepte, die so schnell fertig sind.', ziel: '#/hilfe/rezepte' },
    ],
  },
  {
    version: '2026-10-19-kochmodus',
    title: 'Kochmodus',
    lines: [
      { text: '„Kochen“ im Rezept zeigt jeden Schritt groß auf einer eigenen Seite, und das Display bleibt dabei an.', ziel: '#/hilfe/beimkochen' },
    ],
  },
  {
    version: '2026-10-19-mengen-schritte',
    title: 'Mengen in den Schritten',
    lines: [
      { text: 'Hinter jeder Zutat in der Zubereitung steht ihre Menge, passend zu den Portionen. „Die Hälfte des Mehls“ bekommt auch nur die Hälfte.', ziel: '#/hilfe/beimkochen' },
    ],
  },
  {
    version: '2026-10-19-haken-timer',
    title: 'Abhaken und Timer beim Kochen',
    lines: [
      { text: 'Tippe im Rezept auf eine Zutat oder einen Schritt, um sie beim Kochen durchzustreichen.', ziel: '#/hilfe/beimkochen' },
      { text: 'Zeitangaben wie „20 Minuten“ in den Schritten starten mit einem Tipp einen Timer. Laufende Timer stehen unten auf jeder Seite.', ziel: '#/hilfe/beimkochen' },
    ],
  },
  {
    version: '2026-10-19-zutaten-sortieren',
    title: 'Zutaten löschen und verschieben',
    lines: [
      { text: 'Beim Bearbeiten eines Rezepts löschst du eine Zutat, indem du sie nach rechts wischst. An den drei Strichen rechts ziehst du sie an eine andere Stelle.', ziel: '#/hilfe/importieren' },
    ],
  },
  {
    version: '2026-10-18-zutaten-orte',
    title: 'Zutaten und Orte verwalten',
    lines: [
      { text: 'Unter „Verwalten“ gibt es jetzt „Zutaten“: alle Zutaten mit Kategorie und Einkaufsorten, zum Ändern und zum Erfassen neuer Zutaten.', ziel: '#/zutaten' },
      { text: 'Die Einkaufsorte verwaltest du unter „Verwalten“ → „Orte“ und kannst sie dort auch sortieren.', ziel: '#/orte' },
      { text: 'Beim Bearbeiten eines Rezepts wischst du eine Zutat zur Seite, um Kategorie und Orte zu ändern.' },
    ],
  },
  {
    version: '2026-10-18-zurueckteilen',
    title: 'Kochbuch zurückteilen',
    lines: [
      { text: 'Nimmst du eine Einladung zu einem Kochbuch an, kannst du dein eigenes gleich zurückteilen. Die andere Person bekommt das Angebot in die Glocke und entscheidet dort.', ziel: '#/hilfe/teilen' },
    ],
  },
  {
    version: '2026-10-18-glocke',
    title: 'Glocke oben rechts',
    lines: [
      { text: 'Die Glocke meldet, wenn jemand deine Einladung zu einem Rezept, deinem Kochbuch oder einer Einkaufsliste angenommen hat. Die Zahl zeigt, wie viel ungelesen ist; Gelesenes bleibt 7 Tage stehen.' },
    ],
  },
  {
    version: '2026-10-18-einladungen',
    title: 'Einladungen gelten nur einmal',
    lines: [
      { text: 'Jeder Einladungslink für ein Rezept, dein Kochbuch oder eine Einkaufsliste gilt jetzt für genau eine Person. Sie tippt „Annehmen“ oder „Ablehnen“, danach ist der Link verbraucht.', ziel: '#/hilfe/teilen' },
      { text: 'Einzelne Rezepte bekommt man nur noch mit Konto. Angenommene Rezepte stehen unter „Teilen“ → „Mit mir geteilte Rezepte“.', ziel: '#/geteilt' },
      { text: 'Unter „Teilen“ siehst du offene Einladungen und kannst sie zurückziehen.', ziel: '#/geteilt' },
    ],
  },
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
