// Kategorien für Zutaten (Obst, Gemüse, Fleisch …), z. B. um die Einkaufsliste zu sortieren.
// Jeder Nutzer hat eigene Zuordnungen (Tabelle ingredient_categories); kommt eine Zutat zum
// ersten Mal vor, schlägt guessCategory anhand des Namens eine Kategorie vor.
import { nameWords, normalizeWord } from './pantry.js';
import { splitNote } from './ingredients.js';

// Reihenfolge wie bei einem Gang durch den Supermarkt; so wird auch sortiert.
export const CATEGORIES = [
  'Obst', 'Gemüse', 'Kräuter', 'Brot & Backwaren', 'Fleisch & Wurst', 'Fisch & Meeresfrüchte',
  'Milchprodukte & Eier', 'Nudeln, Reis & Getreide', 'Backzutaten', 'Konserven & Gläser',
  'Öl, Essig & Saucen', 'Gewürze', 'Nüsse & Trockenfrüchte', 'Süßes & Snacks', 'Tiefkühl', 'Getränke', 'Sonstiges',
];
export const OTHER = 'Sonstiges';

const WORDS = {
  'Obst': 'Apfel Äpfel Birne Banane Orange Mandarine Clementine Zitrone Limette Grapefruit Kiwi Mango Ananas Papaya Melone Wassermelone Traube Weintraube Kirsche Erdbeere Himbeere Heidelbeere Blaubeere Brombeere Johannisbeere Stachelbeere Beere Pfirsich Nektarine Aprikose Pflaume Zwetschge Zwetschgen Feige Granatapfel Maracuja Rhabarber Quitte Kokosnuss Physalis Litschi Obst Früchte',
  'Gemüse': 'Tomate Kartoffel Süßkartoffel Zwiebel Schalotte Frühlingszwiebel Lauchzwiebel Knoblauch Knoblauchzehe Karotte Möhre Möhren Paprika Paprikaschote Peperoni Chili Chilischote Gurke Salatgurke Zucchini Aubergine Kürbis Hokkaido Butternut Brokkoli Broccoli Blumenkohl Kohl Weißkohl Rotkohl Wirsing Spitzkohl Grünkohl Rosenkohl Kohlrabi Spinat Mangold Salat Eisbergsalat Rucola Feldsalat Kopfsalat Romanasalat Radicchio Chicorée Endivie Lauch Porree Sellerie Staudensellerie Knollensellerie Fenchel Spargel Erbse Zuckerschote Bohne Bohnen Brechbohnen Mais Maiskolben Pilz Champignon Champignons Pfifferling Steinpilz Shiitake Austernpilz Rote Bete Rettich Radieschen Pastinake Petersilienwurzel Steckrübe Rübe Avocado Okra Artischocke Ingwer Meerrettich Gemüse Suppengrün',
  'Kräuter': 'Petersilie Schnittlauch Basilikum Dill Koriander Minze Pfefferminze Thymian Rosmarin Oregano Majoran Salbei Estragon Kerbel Liebstöckel Zitronengras Kresse Bärlauch Kräuter Lorbeer Lorbeerblatt',
  'Brot & Backwaren': 'Brot Brötchen Baguette Toast Toastbrot Ciabatta Fladenbrot Tortilla Wrap Laugenbrezel Brezel Croissant Knäckebrot Zwieback Semmelbrösel Paniermehl Croutons Pita Naan Brioche Burgerbrötchen',
  'Fleisch & Wurst': 'Fleisch Rindfleisch Rind Schweinefleisch Schwein Hackfleisch Hack Gehacktes Hähnchen Hühnchen Huhn Hähnchenbrust Hühnerbrust Hähnchenschenkel Pute Putenbrust Truthahn Ente Gans Lamm Lammfleisch Kalb Kalbfleisch Wild Hirsch Reh Kaninchen Steak Filet Schnitzel Gulasch Braten Kotelett Rippchen Spareribs Speck Bacon Schinken Kochschinken Pancetta Guanciale Salami Chorizo Wurst Würstchen Bratwurst Wiener Leberkäse Mett Frikadelle Lyoner Mortadella Prosciutto',
  'Fisch & Meeresfrüchte': 'Fisch Lachs Lachsfilet Thunfisch Kabeljau Seelachs Forelle Dorade Wolfsbarsch Zander Hering Makrele Sardine Sardelle Anchovis Scholle Pangasius Tilapia Garnele Garnelen Shrimps Krabben Scampi Muschel Miesmuscheln Tintenfisch Calamari Oktopus Hummer Räucherlachs',
  'Milchprodukte & Eier': 'Milch Vollmilch Buttermilch Sahne Schlagsahne Schmand Crème Creme Fraîche Fraiche Saure Sauerrahm Joghurt Quark Magerquark Butter Butterschmalz Käse Parmesan Pecorino Mozzarella Burrata Feta Hirtenkäse Gouda Emmentaler Bergkäse Cheddar Gruyère Ricotta Mascarpone Frischkäse Hüttenkäse Halloumi Camembert Brie Gorgonzola Ziegenkäse Ei Eier Eigelb Eiweiß Kefir Skyr Kondensmilch Hafermilch Sojamilch Mandelmilch Pflanzenmilch Margarine',
  'Nudeln, Reis & Getreide': 'Nudel Nudeln Pasta Spaghetti Penne Fusilli Farfalle Tagliatelle Linguine Rigatoni Makkaroni Lasagne Lasagneplatten Gnocchi Spätzle Tortellini Ravioli Reis Basmati Jasmin Risotto Risottoreis Milchreis Couscous Bulgur Quinoa Hirse Polenta Grieß Haferflocken Hafer Müsli Graupen Buchweizen Glasnudeln Reisnudeln Mie Udon Soba Linsen Kichererbsen',
  'Backzutaten': 'Mehl Weizenmehl Dinkelmehl Roggenmehl Vollkornmehl Speisestärke Stärke Maisstärke Backpulver Natron Hefe Trockenhefe Vanillezucker Vanille Vanilleschote Puderzucker Rohrzucker Zucker Brauner Kakao Kakaopulver Schokolade Kuvertüre Zartbitterschokolade Gelatine Agar Mandelblättchen Streusel Marzipan Fondant Lebensmittelfarbe Zuckerguss Honig Ahornsirup Sirup Agavendicksaft',
  'Konserven & Gläser': 'Tomatenmark Passata Dosentomaten Tomatenpüree Pizzatomaten Kokosmilch Kidneybohnen Mais Oliven Kapern Gewürzgurke Essiggurke Sauerkraut Pesto Brühe Gemüsebrühe Hühnerbrühe Rinderbrühe Fond Bouillon Marmelade Konfitüre Nutella Erdnussbutter Tahini Apfelmus',
  'Öl, Essig & Saucen': 'Zitronensaft Limettensaft Öl Olivenöl Rapsöl Sonnenblumenöl Sesamöl Kokosöl Essig Balsamico Weißweinessig Apfelessig Rotweinessig Sojasauce Sojasoße Sojasoße Teriyaki Worcestersauce Fischsauce Austernsauce Ketchup Senf Mayonnaise Mayo Sriracha Tabasco Sambal Currypaste Barbecuesauce Sauce Soße Dressing Hoisin Miso',
  'Gewürze': 'Salz Meersalz Pfeffer Paprikapulver Edelsüß Rosenscharf Curry Currypulver Kurkuma Kreuzkümmel Kümmel Cumin Zimt Muskat Muskatnuss Nelke Nelken Kardamom Piment Anis Sternanis Chiliflocken Cayennepfeffer Garam Masala Ras Hanout Za Zaatar Fenchelsamen Senfsaat Bockshornklee Gewürz Gewürze Gewürzmischung Italienische Kräuter Provence Knoblauchpulver Zwiebelpulver Safran',
  'Nüsse & Trockenfrüchte': 'Nuss Nüsse Walnuss Haselnuss Mandel Mandeln Cashew Cashewkerne Erdnuss Erdnüsse Pistazie Pinienkerne Macadamia Pekannuss Paranuss Sonnenblumenkerne Kürbiskerne Sesam Leinsamen Chiasamen Rosine Rosinen Sultaninen Cranberries Datteln Dattel Trockenobst Aprikosen Kokosraspel Kokosflocken',
  'Süßes & Snacks': 'Chips Kekse Keks Butterkekse Löffelbiskuit Gummibärchen Bonbon Popcorn Cracker Salzstangen Riegel Pralinen',
  'Tiefkühl': 'Tiefkühl TK Eis Eiswürfel Blätterteig Pizzateig Fischstäbchen Pommes Kroketten Tiefkühlerbsen Rahmspinat',
  'Getränke': 'Wasser Mineralwasser Saft Orangensaft Apfelsaft Wein Weißwein Rotwein Bier Sekt Prosecco Rum Wodka Gin Whisky Likör Amaretto Kaffee Espresso Tee Cola Limonade Tonic',
};

// Schlüsselwörter normalisiert (wie die Namenswörter), mit ihrer Kategorie.
const KEYWORDS = [];
for (const [category, list] of Object.entries(WORDS)) {
  for (const w of list.split(/\s+/)) {
    const k = normalizeWord(w);
    if (k.length >= 2) KEYWORDS.push([k, category]);
  }
}

// Wie gut passt ein Schlüsselwort auf ein Wort? 3 = gleich, 2 = Wortende (zusammengesetzte
// Wörter wie "Kirschtomaten", "Olivenöl"), 1 = kleine Abweichung am Ende,
// 0.5 = Wortanfang ("Schokoladenstückchen") als letzter Ausweg.
function score(word, key) {
  if (word === key) return 3;
  if (key.length >= 3 && word.endsWith(key)) return 2;
  if (key === 'ol' && word.endsWith('ol')) return 2;
  if (word.startsWith(key) && word.length - key.length <= 2 && key.length >= 3) return 1;
  if (word.startsWith(key) && key.length >= 5) return 0.5;
  return 0;
}

// Schlägt eine Kategorie vor; bei Unklarheit "Sonstiges".
export function guessCategory(rawName) {
  const name = splitNote(rawName).name.split(',')[0];
  const words = nameWords(name);
  let best = null;
  // Im Deutschen bestimmt das letzte Wort die Sache ("Tomatenmark", "Hähnchen Brust"), deshalb von hinten.
  words.reverse().forEach((word, pos) => {
    for (const [key, category] of KEYWORDS) {
      const s = score(word, key);
      if (!s) continue;
      const rank = [s, -pos, key.length];
      if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && (rank[1] > best.rank[1]
        || (rank[1] === best.rank[1] && rank[2] > best.rank[2])))) best = { rank, category };
    }
  });
  return best?.category ?? OTHER;
}

// Schlüssel, unter dem die Kategorie einer Zutat gespeichert wird: "Zwiebeln" und
// "Zwiebel, gehackt" teilen sich eine Zuordnung.
export function categoryKey(rawName) {
  return nameWords(splitNote(rawName).name.split(',')[0]).join(' ');
}

export const categoryRank = (c) => {
  const i = CATEGORIES.indexOf(c);
  return i === -1 ? CATEGORIES.length - 1 : i;
};
