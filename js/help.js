// Hilfetexte der App. Jeder Eintrag wird zweimal genutzt: auf der Hilfeseite (#/hilfe) als
// aufklappbarer Abschnitt und im Hilfe-Knopf oben rechts, der den Abschnitt zur aktuellen
// Seite zeigt. routes nennt die Seiten, auf denen der Knopf diesen Abschnitt öffnet; ein
// Eintrag ohne routes steht nur auf der Hilfeseite.

export const HELP = [
  {
    id: 'rezepte',
    title: 'Rezepte sammeln und finden',
    routes: ['', 'r'],
    lines: [
      'Die Übersicht zeigt alle deine Rezepte. Oben suchst du nach Titel oder Zutat und filterst über die Tags.',
      'Mit dem Knopf rechts oben sortierst du nach Titel, Bewertung, Anlagedatum oder danach, wann du ein Rezept zuletzt gekocht hast.',
      '„+ Rezept“ legt ein neues an — entweder aus einem Link, Video oder Foto, oder selbst getippt.',
      'Im Rezept änderst du die Anzahl Portionen; die Mengen der Zutaten werden mitgerechnet.',
      'Ein Wisch nach links oder rechts auf einem Rezept führt zu seinen Alternativen, falls es welche hat.',
    ],
  },
  {
    id: 'importieren',
    title: 'Rezept importieren',
    routes: ['neu'],
    lines: [
      'Aus einem Link: Adresse einer Rezeptseite einfügen und „Importieren“. Bei YouTube, Shorts und TikTok wird das Video ausgewertet, und die Schritte bekommen Zeitstempel.',
      'Aus Fotos: bis zu sechs Bilder einer Kochbuchseite oder Rezeptkarte, auch handschriftlich.',
      'Aus einem Video: ein gespeichertes TikTok oder Reel bis 50 MB, wenn das Rezept nur gesprochen wird.',
      'Text einfügen: zum Beispiel ein Kommentar, in dem das Rezept steht.',
      'Prüfe nach jedem Import die Mengen und Schritte — die Auswertung kann sich irren — und tippe dann auf Speichern.',
    ],
  },
  {
    id: 'naehrwerte',
    title: 'Nährwerte',
    lines: [
      'Nennt die Quelle Nährwerte, übernimmt sie der Import von allein.',
      'Sonst öffnest du im Bearbeiten-Formular den Abschnitt „Nährwerte“ und tippst auf „Nährwerte ermitteln“: die Werte werden aus der Zutatenliste geschätzt und auf eine Portion gerechnet.',
      'Zutaten ohne Menge („Salz“, „Öl zum Braten“) gehen nicht in die Summe ein und stehen im Hinweis unter dem Knopf.',
      'Die Werte sind Schätzungen aus einer Nährwerttabelle. Du kannst jedes Feld von Hand überschreiben.',
    ],
  },
  {
    id: 'videos',
    title: 'Videos, Bilder und Zeitstempel',
    lines: [
      'Videos und Bilder stehen im Rezept nach den Zutaten, über der Zubereitung. Hat ein Rezept mehrere, schaltet die Leiste darüber um.',
      'Ein Tipp auf den Zeitstempel eines Schritts springt im Video an die Stelle und startet es, auch wenn gerade ein anderes Video zu sehen ist.',
      'Startet der Ton nicht, liegt es am Browser: er lässt Videos nur stumm von allein anlaufen. Die App versucht es dann stumm und schaltet den Ton gleich danach dazu.',
      'Beim Bearbeiten stellst du unter den Schritten ein, zu welchem Video ein Zeitstempel gehört.',
    ],
  },
  {
    id: 'alternativen',
    title: 'Alternativrezepte und Rezepte kombinieren',
    routes: ['kombinieren'],
    lines: [
      'Zwei Rezepte, die dasselbe Gericht auf andere Art machen, verknüpfst du im Bearbeiten-Formular unter „Alternativen“.',
      'Verknüpfte Rezepte stehen in der Übersicht als Kartenstapel und lassen sich im Rezept durchwischen.',
      '„Kombinieren“ im Bearbeiten-Formular baut aus mehreren Rezepten ein neues: du wählst je Rezept die Schritte und Zutaten aus, die mitkommen.',
      'Die Ausgangsrezepte bleiben erhalten; nach dem Speichern fragt die App, ob sie gelöscht werden sollen.',
    ],
  },
  {
    id: 'kochen',
    title: 'Was kochen? und Vorrat',
    routes: ['kochen'],
    lines: [
      'Tippe ein, was du zu Hause hast; die App zeigt die Rezepte, die damit gehen, und was jeweils noch fehlt.',
      'Grundzutaten wie Salz, Öl und Mehl zählt sie als vorhanden, solange das Häkchen gesetzt ist.',
      'Der eingetippte Vorrat bleibt auf dem Gerät gespeichert, auch wenn du die App schließt.',
      'Über die Leiste oben kommst du zum Saisonkalender.',
    ],
  },
  {
    id: 'saison',
    title: 'Saisonkalender',
    routes: ['saison'],
    lines: [
      'Zeigt, welches Gemüse und Obst im gewählten Monat aus der Region kommt, und darunter die Rezepte, die dazu passen.',
      'Mit den Pfeilen wechselst du den Monat, „Ganzes Jahr ansehen“ zeigt die Tabelle über alle Monate.',
      '„Lagerware einbeziehen“ nimmt Sorten dazu, die gelagert werden, zum Beispiel Äpfel und Kartoffeln.',
    ],
  },
  {
    id: 'plan',
    title: 'Essensplan',
    routes: ['plan'],
    lines: [
      'Jedem Tag lassen sich Rezepte zuordnen, mit der Anzahl Portionen.',
      'Beim Einplanen fragt die App, ob die Zutaten gleich auf eine Einkaufsliste sollen.',
      'Ist ein geplanter Tag vorbei, merkt sich das Rezept das Datum als „zuletzt gekocht“ — danach kannst du die Übersicht sortieren.',
    ],
  },
  {
    id: 'einkauf',
    title: 'Einkaufslisten',
    routes: ['einkauf'],
    lines: [
      'Du kannst mehrere Listen führen, etwa eine pro Haushalt oder Woche.',
      'Zutaten kommen aus einem Rezept oder von Hand dazu; gleiche Zutaten werden zusammengefasst.',
      'Jede Zutat hat eine Kategorie und einen Einkaufsort; über „Verwalten“ in der Liste stellst du beides ein und filterst nach Ort.',
      '„Verwalten“ gibt dir auch einen Link, mit dem andere die Liste mitbearbeiten können — Änderungen erscheinen bei allen sofort.',
    ],
  },
  {
    id: 'teilen',
    title: 'Teilen: Kochbuch und einzelne Rezepte',
    routes: ['geteilt', 'kochbuch'],
    lines: [
      'Mit dem Einladungslink für dein Kochbuch kann jeder mit Konto alle deine Rezepte ansehen und übernehmen, aber nichts ändern.',
      'Ein neuer Einladungslink macht den alten ungültig; wer schon Zugriff hat, behält ihn. Lesezugriff kannst du einzeln entfernen.',
      'Ein einzelnes Rezept teilst du im Rezept selbst: dieser Link funktioniert ohne Konto.',
      'Dein Benutzername ist das, was andere von dir sehen; du kannst ihn hier ändern. Jeden Namen gibt es nur einmal, Groß- und Kleinschreibung zählt dabei nicht. Schon beim Tippen siehst du, ob er noch frei ist.',
      'Kochbücher, die andere mit dir geteilt haben, stehen oben auf dieser Seite und lassen sich wieder verlassen.',
      'Abmelden findest du unter „Verwalten“, unter den anderen Einträgen.',
    ],
  },
];

export function helpTopic(id) {
  return HELP.find((t) => t.id === id) ?? null;
}

// Der Abschnitt, den der Hilfe-Knopf auf dieser Seite zeigt. first und action sind die
// ersten Teile der Adresse, z. B. "r" und "bearbeiten".
export function helpFor(first = '', action = '') {
  if (first === 'r' && action === 'bearbeiten') return helpTopic('importieren');
  return HELP.find((t) => (t.routes ?? []).includes(first)) ?? null;
}
