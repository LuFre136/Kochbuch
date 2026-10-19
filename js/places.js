// Einkaufsorte (Supermarkt, Drogeriemarkt …): wo man eine Zutat bekommt. Jeder Nutzer hat
// eigene Orte (Tabelle shopping_places) und speichert je Zutat die Orte zusammen mit der
// Kategorie (ingredient_categories.places). Kommt eine Zutat zum ersten Mal vor, schlägt
// guessPlaces anhand des Namens und der Kategorie Orte vor.
import { nameWords, normalizeWord } from './pantry.js';
import { splitNote } from './ingredients.js';

// Die vorgegebenen Orte haben feste Kennungen, damit Vorschläge auch nach dem Umbenennen passen.
export const DEFAULT_PLACES = [
  { id: 'supermarkt', name: 'Supermarkt' },
  { id: 'drogerie', name: 'Drogeriemarkt' },
  { id: 'markt', name: 'Markt' },
  { id: 'baecker', name: 'Bäcker' },
  { id: 'baumarkt', name: 'Baumarkt' },
  { id: 'sonstige', name: 'Sonstige' },
];

const WORDS = {
  // Nur in der Drogerie.
  drogerie: 'Zahnpasta Zahncreme Zahnbürste Zahnseide Mundspülung Shampoo Spülung Duschgel Seife Flüssigseife Deo Deodorant Bodylotion Handcreme Sonnencreme Gesichtscreme Rasierer Rasierschaum Wattepads Wattestäbchen Watte Tampons Binden Slipeinlagen Windeln Feuchttücher Pflaster Abschminktücher Haarspray Haargel Nagellack Make Kosmetik Vitamintabletten',
  // In der Drogerie und im Supermarkt.
  haushalt: 'Backpapier Alufolie Frischhaltefolie Gefrierbeutel Müllbeutel Müllsäcke Spülmittel Spültabs Spülmaschinentabs Klarspüler Spülschwamm Schwamm Schwämme Taschentücher Toilettenpapier Klopapier Küchenrolle Küchenpapier Servietten Waschmittel Weichspüler Putzmittel Reiniger Allzweckreiniger Glasreiniger Kerzen Teelichter',
  baumarkt: 'Grillkohle Holzkohle Grillbriketts Grillanzünder Anzünder Kaminanzünder Batterie Batterien Glühbirne Leuchtmittel Blumenerde Dünger Schrauben Dübel Nägel Klebeband Panzertape Pinsel Kabelbinder Gartenschlauch Streusalz Holz Brennholz',
};

const KEYWORDS = [];
for (const [group, list] of Object.entries(WORDS)) {
  for (const w of list.split(/\s+/)) KEYWORDS.push([normalizeWord(w), group]);
}

// Frisches gibt es auch auf dem Markt.
const MARKET_CATEGORIES = new Set(['Obst', 'Gemüse', 'Kräuter']);

function groupOf(rawName) {
  const words = nameWords(splitNote(rawName).name.split(',')[0]);
  // Das letzte Wort bestimmt die Sache ("Bio Spülmittel"), zusammengesetzte Wörter über das Wortende.
  for (const word of words.reverse()) {
    for (const [key, group] of KEYWORDS) {
      if (word === key || (key.length >= 5 && word.endsWith(key))) return group;
    }
  }
  return null;
}

// Schlägt Kennungen von Orten vor; nur solche, die es in placeIds (den eigenen Orten) gibt.
// Ist keiner der vorgeschlagenen Orte mehr vorhanden, der erste eigene Ort.
export function guessPlaces(rawName, category, placeIds = DEFAULT_PLACES.map((p) => p.id)) {
  const group = groupOf(rawName);
  let ids;
  if (group === 'drogerie') ids = ['drogerie'];
  else if (group === 'haushalt') ids = ['supermarkt', 'drogerie'];
  else if (group === 'baumarkt') ids = ['baumarkt'];
  else if (MARKET_CATEGORIES.has(category)) ids = ['supermarkt', 'markt'];
  else if (category === 'Brot & Backwaren') ids = ['supermarkt', 'baecker'];
  else ids = ['supermarkt'];
  const have = ids.filter((id) => placeIds.includes(id));
  return have.length ? have : placeIds.slice(0, 1);
}

// Ladenweg: die Kategorien in der Reihenfolge, in der sie in einem Ort liegen. Gespeichert
// ist sie in shopping_places.category_order; fehlt sie, gilt die vorgegebene aus
// categories.js. Unbekannte Einträge fallen weg, neue Kategorien kommen in ihrer
// vorgegebenen Reihenfolge hinten dazu.
export function categoryOrder(saved, all) {
  const known = new Set(all);
  const order = [...new Set((saved ?? []).filter((c) => known.has(c)))];
  return [...order, ...all.filter((c) => !order.includes(c))];
}

// Sortierschlüssel einer Zutat auf dem Ladenweg: zuerst der Ort (in der Reihenfolge der
// Orte; bei mehreren Orten der erste davon), dann die Kategorie in der Reihenfolge dieses Orts.
// placeOrder: Kennungen der Orte; orderOf(placeId) liefert den Ladenweg eines Orts.
export function walkKey(itemPlaces, category, placeOrder, orderOf, onlyPlace = '') {
  const place = onlyPlace || placeOrder.find((id) => itemPlaces.includes(id)) || placeOrder[0] || '';
  const order = orderOf(place);
  const at = order.indexOf(category);
  return { place, rank: [onlyPlace ? 0 : Math.max(0, placeOrder.indexOf(place)), at === -1 ? order.length : at] };
}
