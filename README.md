# Mein Kochbuch

Rezept-App für iPhone und Browser. Läuft komplett kostenlos auf GitHub Pages (App) und Supabase (Login, Datenbank, Bilder).

## Einrichtung (einmalig)

1. **Datenbank anlegen:** Im Supabase-Dashboard links **SQL Editor** öffnen, den Inhalt von [`supabase/schema.sql`](supabase/schema.sql) einfügen und auf **Run** klicken.
   Danach ebenso den Inhalt von [`supabase/teilen.sql`](supabase/teilen.sql) ausführen (Teilen von Rezepten und Kochbüchern).
2. **Login-Weiterleitung:** Unter **Authentication → URL Configuration** als **Site URL** `https://lufre136.github.io/Kochbuch/` eintragen und dieselbe Adresse bei **Redirect URLs** hinzufügen. Sonst führen Bestätigungs-Mails ins Leere.
3. **Veröffentlichen:** Im GitHub-Repository unter **Settings → Pages** bei *Source* „Deploy from a branch“, Branch `main`, Ordner `/ (root)` wählen. Nach ein bis zwei Minuten ist die App unter `https://lufre136.github.io/Kochbuch/` erreichbar.
4. **Import per Link einrichten:** Im Supabase-Dashboard **Edge Functions → Deploy a new function → Via Editor** wählen, als Namen `import-recipe` eintragen, den Inhalt von [`supabase/functions/import-recipe/index.ts`](supabase/functions/import-recipe/index.ts) einfügen und auf **Deploy function** klicken. Danach in den Einstellungen der Funktion **Verify JWT** ausschalten (die Funktion prüft die Anmeldung selbst).
5. **Aufs iPhone:** Die Adresse in Safari öffnen, auf *Teilen* tippen und **Zum Home-Bildschirm** wählen.

Die Supabase-Adresse und der Publishable Key stehen in [`js/config.js`](js/config.js). Der Key ist für den Browser gedacht; wer welche Daten sehen darf, regeln die Zugriffsregeln in `schema.sql`.

## Entwicklung

Kein Build-Schritt nötig, alles sind statische Dateien.

```sh
npm start   # lokaler Server auf http://localhost:8080
npm test    # Tests für Zutaten-Parser, Portionsrechner, Rezept-Import und Zutatensuche
```

Zutaten werden als eine Zeile pro Zutat eingegeben („200 g Mehl“, „½ Bund Petersilie“, „2-3 Zehen Knoblauch“) und als `{ amount, amountMax, unit, name }` gespeichert. So kann die App sie auf eine andere Personenzahl umrechnen.

## Teilen

- **Einzelnes Rezept:** Im Rezept auf „Teilen“ tippen. Der Link (`#/teilen/…`) zeigt das Rezept auch ohne Konto; mit Konto lässt es sich ins eigene Kochbuch übernehmen. „Teilen beenden“ macht den Link ungültig.
- **Ganzes Kochbuch:** Unter „Geteilt“ einen Einladungslink erstellen. Wer ihn mit eigenem Konto öffnet, bekommt Lesezugriff auf alle Rezepte. Leser lassen sich dort einzeln entfernen; ein neuer Link macht den alten ungültig.
