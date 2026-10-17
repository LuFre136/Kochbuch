// Alternativrezepte: Verknüpfungen zwischen zwei Rezepten. Eine Verknüpfung ist ein
// Datensatz je Paar und gilt deshalb immer in beide Richtungen.

// Bringt ein Paar in die gespeicherte Reihenfolge (recipe_a < recipe_b).
export const pairOf = (a, b) => (a < b ? { recipe_a: a, recipe_b: b } : { recipe_a: b, recipe_b: a });

// Alle Rezepte, die mit diesem verknüpft sind.
export function alternativeIds(links, id) {
  const ids = [];
  for (const l of links ?? []) {
    const other = l.recipe_a === id ? l.recipe_b : l.recipe_b === id ? l.recipe_a : null;
    if (other && !ids.includes(other)) ids.push(other);
  }
  return ids;
}

export const isLinked = (links, a, b) => alternativeIds(links, a).includes(b);

// Das aufgerufene Rezept und seine Alternativen, nach Titel sortiert. Zum Wischen in der Rezeptansicht.
export function alternativeGroup(recipe, links, recipes, compare = (a, b) => a.localeCompare(b)) {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const alts = alternativeIds(links, recipe.id)
    .map((id) => byId.get(id))
    .filter(Boolean)
    .sort((a, b) => compare(a.title, b.title));
  return [recipe, ...alts];
}

// Vorschläge anhand gemeinsamer Tags: je mehr gemeinsame Tags, desto weiter vorne.
// Rezepte ohne gemeinsamen Tag werden nicht vorgeschlagen.
export function suggestAlternatives(recipe, candidates, links, { limit = 5, compare = (a, b) => a.localeCompare(b) } = {}) {
  const linked = alternativeIds(links, recipe.id);
  const own = new Set((recipe.tags ?? []).map((t) => t.toLowerCase()));
  if (!own.size) return [];
  return candidates
    .filter((c) => c.id !== recipe.id && !linked.includes(c.id))
    .map((c) => {
      const tags = new Set((c.tags ?? []).map((t) => t.toLowerCase()));
      let shared = 0;
      for (const t of tags) if (own.has(t)) shared += 1;
      // Anteil gemeinsamer Tags, damit ein Rezept mit zwei passenden von zwei Tags
      // vor einem mit zwei passenden von zehn liegt.
      return { recipe: c, shared, score: shared / (own.size + tags.size - shared) };
    })
    .filter((s) => s.shared > 0)
    .sort((a, b) => b.shared - a.shared || b.score - a.score || compare(a.recipe.title, b.recipe.title))
    .slice(0, limit)
    .map((s) => s.recipe);
}
