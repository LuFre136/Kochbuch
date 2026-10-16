// Zutaten parsen, umrechnen und formatieren.
// Eine Zutat ist { amount, amountMax, unit, name }; amount/amountMax sind Zahlen oder null.

const FRACTIONS = { '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅕': 1 / 5, '⅛': 1 / 8 };
const FRACTION_CHARS = Object.keys(FRACTIONS).join('');

const UNITS = [
  'g', 'kg', 'mg', 'ml', 'l', 'cl', 'dl', 'EL', 'TL', 'Prise', 'Prisen', 'Msp.', 'Msp',
  'Tasse', 'Tassen', 'Becher', 'Dose', 'Dosen', 'Pck.', 'Pck', 'Päckchen', 'Packung', 'Packungen',
  'Bund', 'Stück', 'Stk.', 'Stk', 'Scheibe', 'Scheiben', 'Zehe', 'Zehen', 'Zweig', 'Zweige',
  'Blatt', 'Blätter', 'Handvoll', 'Glas', 'Gläser', 'Würfel', 'cm', 'Spritzer', 'Schuss',
  'Tropfen', 'Kugel', 'Kugeln', 'Liter', 'Gramm', 'Kilo', 'Stange', 'Stangen', 'Knolle', 'Knollen',
  'oz', 'lb', 'cup', 'cups', 'tbsp', 'tsp',
];
const UNIT_LOOKUP = new Map(UNITS.map(u => [u.toLowerCase(), u]));

const NUM = String.raw`(?:\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?\s*[${FRACTION_CHARS}]?|[${FRACTION_CHARS}])`;
const LINE_RE = new RegExp(String.raw`^\s*(${NUM})(?:\s*[-–]\s*(${NUM}))?\s*(.*)$`, 'u');

export function parseNumber(str) {
  if (str == null) return null;
  const s = String(str).trim();
  let m = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  m = s.match(new RegExp(`^(\\d+(?:[.,]\\d+)?)?\\s*([${FRACTION_CHARS}])?$`, 'u'));
  if (m && (m[1] || m[2])) {
    return (m[1] ? Number(m[1].replace(',', '.')) : 0) + (m[2] ? FRACTIONS[m[2]] : 0);
  }
  return null;
}

export function parseIngredientLine(line) {
  const text = String(line).trim();
  if (!text) return null;
  const m = text.match(LINE_RE);
  if (!m) return { amount: null, amountMax: null, unit: '', name: text };
  let rest = m[3].trim();
  let unit = '';
  const unitMatch = rest.match(/^(\S+?)(?:\s+|$)/u);
  if (unitMatch) {
    const known = UNIT_LOOKUP.get(unitMatch[1].toLowerCase());
    if (known) {
      unit = known;
      rest = rest.slice(unitMatch[0].length).trim();
    }
  }
  return { amount: parseNumber(m[1]), amountMax: m[2] ? parseNumber(m[2]) : null, unit, name: rest };
}

export function parseIngredientText(text) {
  return String(text).split('\n').map(parseIngredientLine).filter(Boolean);
}

const DISPLAY_FRACTIONS = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [1 / 2, '½'], [2 / 3, '⅔'], [3 / 4, '¾'], [1, '']];

// Rundet für die Anzeige auf sinnvolle Werte: kleine Mengen als Bruch, große als ganze Zahl.
export function formatAmount(n) {
  if (n == null || !isFinite(n)) return '';
  if (n < 10) {
    const whole = Math.floor(n);
    const frac = n - whole;
    for (const [value, symbol] of DISPLAY_FRACTIONS) {
      if (Math.abs(frac - value) < 0.02) {
        const w = whole + (value === 1 ? 1 : 0);
        if (!symbol) return String(w);
        return w === 0 ? symbol : `${w}${symbol}`;
      }
    }
    const decimals = n < 1 ? 2 : 1;
    return String(Number(n.toFixed(decimals))).replace('.', ',');
  }
  return String(Math.round(n));
}

export function formatQuantity(ing, factor = 1) {
  const parts = [];
  if (ing.amount != null) {
    let q = formatAmount(ing.amount * factor);
    if (ing.amountMax != null) q += `–${formatAmount(ing.amountMax * factor)}`;
    parts.push(q);
  }
  if (ing.unit) parts.push(ing.unit);
  return parts.join(' ');
}

// Für das Bearbeiten: verlustfrei genug, um beim erneuten Speichern dieselbe Zutat zu ergeben.
function exactAmount(n) {
  for (const [value, symbol] of DISPLAY_FRACTIONS) {
    const whole = Math.floor(n);
    if (symbol && Math.abs(n - whole - value) < 1e-6) return whole ? `${whole}${symbol}` : symbol;
  }
  return String(Number(n.toFixed(3))).replace('.', ',');
}

export function ingredientToLine(ing) {
  const parts = [];
  if (ing.amount != null) {
    let q = exactAmount(ing.amount);
    if (ing.amountMax != null) q += `-${exactAmount(ing.amountMax)}`;
    parts.push(q);
  }
  if (ing.unit) parts.push(ing.unit);
  if (ing.name) parts.push(ing.name);
  return parts.join(' ');
}
