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
      'Die Zeit-Chips („bis 30 Min.“ …) zeigen nur Rezepte, die in der Gesamtzeit fertig sind, ersatzweise in der Koch-/Backzeit. Es gibt sie auch bei „Was kochen?“ und im Saisonkalender. Rezepte ohne Zeitangabe fallen dabei weg; der Hinweis darunter zeigt sie dir zum Nachtragen.',
      '„+ Rezept“ legt ein neues an — entweder aus einem Link, Video oder Foto, oder selbst getippt.',
      'Im Rezept änderst du die Anzahl Portionen; die Mengen der Zutaten werden mitgerechnet.',
      'Ein Wisch nach links oder rechts auf einem Rezept führt zu seinen Alternativen, falls es welche hat.',
    ],
  },
  {
    id: 'beimkochen',
    title: 'Kochmodus, Haken, Timer und Mengen',
    lines: [
      '„Kochen“ im Rezept öffnet den Kochmodus: zuerst die Zutaten, dann jeder Schritt groß auf einer eigenen Seite. Wische oder tippe auf „Weiter“ und „Zurück“.',
      'Solange der Kochmodus offen ist, bleibt das Display an. Hat ein Schritt einen Zeitstempel, öffnet „Video ab …“ das Video unten auf der Seite.',
      'Auf der letzten Seite speichert „Fertig, heute gekocht“ das Datum als „zuletzt gekocht“. Öffnest du den Kochmodus wieder, geht es beim Schritt nach deinem letzten Haken weiter.',
      'Tippe im Rezept auf eine Zutat oder einen Schritt, um sie durchzustreichen. Ein zweiter Tipp nimmt den Haken zurück.',
      'Die Haken bleiben auf diesem Gerät stehen, auch wenn du die App schließt. Nach 12 Stunden ohne neuen Haken beginnt das Rezept wieder leer, oder du tippst auf „Haken entfernen“.',
      'Zeitangaben in den Schritten wie „20 Minuten“ sind eingerahmt. Ein Tipp darauf startet einen Timer; bei einer Spanne wie „10–15 Minuten“ läuft er auf den kleineren Wert.',
      'Laufende Timer stehen unten auf jeder Seite, mit Pause und Abbrechen. Mehrere Timer können gleichzeitig laufen.',
      'Ein Timer klingelt nur, solange die App offen ist. Ist sie zu, läuft die Zeit trotzdem weiter, und beim nächsten Öffnen meldet er sich.',
      'In den Schritten steht hinter jeder Zutat ihre Menge für die eingestellten Portionen, auch bei Anteilen wie „die Hälfte des Mehls“ oder „die restliche Butter“. Der Schalter „Mengen in den Schritten“ blendet sie aus.',
      'Kommt eine Zutat ohne Anteil in mehreren Schritten vor, steht die Menge nur beim ersten Mal. Nennt ein Schritt die Zutat anders als die Zutatenliste, findet die App sie nicht.',
    ],
  },
  {
    id: 'offline',
    title: 'Ohne Internet',
    lines: [
      'Die App merkt sich alles, was sie zuletzt geladen hat. Ohne Netz zeigt sie diesen Stand, und oben steht, von wann er ist.',
      'Offline gehen deine Rezepte, der Kochmodus mit Timern und Haken, „Was kochen?“, der Saisonkalender und die Einkaufsliste. Kochbücher anderer gehen, wenn du sie vorher einmal geöffnet hast.',
      'Bilder bleiben auf dem Gerät, sobald sie einmal angezeigt wurden; die Titelbilder lädt die App im WLAN von allein vor. Videos brauchen immer Internet.',
      'Auf der Einkaufsliste kannst du auch ohne Empfang abhaken. Die Haken werden gespeichert, sobald wieder Netz da ist. Bearbeiten, Teilen, Einplanen und Importieren brauchen Internet.',
      'Am zuverlässigsten klappt das, wenn die App auf dem Home-Bildschirm liegt. Im Safari-Tab kann das iPhone die gespeicherten Daten löschen, wenn du die Seite länger nicht öffnest.',
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
      'Unter dem Zutatenfeld steht jede Zutat mit Kategorie und Einkaufsorten. Nach links wischen und „Ändern“ ändert beides, nach rechts wischen und „Löschen“ entfernt die Zutat. An den drei Strichen rechts ziehst du eine Zutat nach oben oder unten.',
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
      'Jede Zutat hat eine Kategorie und mindestens einen Einkaufsort. Wische einen Eintrag nach rechts, um beides zu ändern; oben filterst du die Liste nach Ort.',
      '„Verwalten“ gibt dir auch einen Einladungslink, mit dem eine Person die Liste mitbearbeiten kann — Änderungen erscheinen bei allen sofort. Jeder Link gilt für eine Person.',
    ],
  },
  {
    id: 'zutaten',
    title: 'Zutaten und Einkaufsorte',
    routes: ['zutaten', 'orte'],
    lines: [
      'Unter „Verwalten“ → „Zutaten“ stehen alle deine Zutaten nach Kategorien. Tippe eine an, um ihre Kategorie und ihre Einkaufsorte zu ändern; das gilt in allen Rezepten und Einkaufslisten.',
      'Oben erfasst du neue Zutaten, bevor sie in einem Rezept vorkommen. Die App schlägt Kategorie und Orte vor.',
      'Jede Zutat hat mindestens einen Ort. Löschst du einen Ort, bekommen Zutaten, die nur diesen hatten, wieder einen vorgeschlagenen.',
      'Unter „Verwalten“ → „Orte“ legst du Einkaufsorte an, benennst sie um, sortierst sie mit den Pfeilen und löschst sie. Ein Ort bleibt immer.',
    ],
  },
  {
    id: 'teilen',
    title: 'Teilen: Kochbuch und einzelne Rezepte',
    routes: ['geteilt', 'kochbuch', 'einladung', 'erhalten'],
    lines: [
      'Jeder Einladungslink gilt für genau eine Person: Sie tippt „Annehmen“ oder „Ablehnen“, danach ist der Link verbraucht. Für mehrere Leute teilst du einfach mehrmals.',
      'Wer die Einladung zu deinem Kochbuch annimmt, kann alle deine Rezepte ansehen und übernehmen, aber nichts ändern. Lesezugriff kannst du einzeln entfernen.',
      'Ein einzelnes Rezept schickst du im Rezept selbst über „Teilen“. Wer annimmt, findet es unter „Mit mir geteilte Rezepte“; dafür braucht man ein Konto.',
      'Unter „Offene Einladungen“ siehst du verschickte Links, die noch niemand beantwortet hat, und kannst sie zurückziehen.',
      'Die Glocke oben rechts meldet, wenn jemand deine Einladung angenommen hat. Ungelesenes ist hervorgehoben; Gelesenes verschwindet nach 7 Tagen.',
      'Nimmst du die Einladung zu einem Kochbuch an, fragt die App, ob du dein eigenes zurückteilen möchtest. Die andere Person bekommt das Angebot in die Glocke und nimmt dort an oder lehnt ab.',
      'Familiengeheimnis: Schließt du beim Bearbeiten eines Rezepts das Schloss „Familiengeheimnis“, sehen es Leser deines Kochbuchs nicht. Wem du das Rezept einzeln schickst, der sieht es trotzdem.',
      'Dein Benutzername ist das, was andere von dir sehen; du kannst ihn hier ändern. Jeden Namen gibt es nur einmal, Groß- und Kleinschreibung zählt dabei nicht. Schon beim Tippen siehst du, ob er noch frei ist.',
      'Kochbücher, die andere mit dir geteilt haben, stehen oben auf dieser Seite und lassen sich wieder verlassen. Das Auge dahinter blendet ein Kochbuch aus: Es erscheint dann nicht mehr bei „Was kochen?“, in der Saison und beim Kombinieren, bleibt aber hier zum Öffnen stehen.',
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
