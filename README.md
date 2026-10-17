# Mein Kochbuch

Rezept-App für iPhone und Browser. Läuft komplett kostenlos auf GitHub Pages (App) und Supabase (Login, Datenbank, Bilder).

## Einrichtung (einmalig)

1. **Datenbank anlegen:** Im Supabase-Dashboard links **SQL Editor** öffnen, den Inhalt von [`supabase/schema.sql`](supabase/schema.sql) einfügen und auf **Run** klicken.
   Danach ebenso den Inhalt von [`supabase/teilen.sql`](supabase/teilen.sql) ausführen (Teilen von Rezepten und Kochbüchern).
   Danach [`supabase/planung.sql`](supabase/planung.sql) (Bewertungen und Essensplan) und [`supabase/einkauf.sql`](supabase/einkauf.sql) (Einkaufslisten), [`supabase/benutzername.sql`](supabase/benutzername.sql) (Benutzernamen statt E-Mail-Adressen beim Teilen), [`supabase/kategorien.sql`](supabase/kategorien.sql) (eigene Zutaten-Kategorien) , [`supabase/naehrwerte.sql`](supabase/naehrwerte.sql) (Nährwerte) , [`supabase/orte.sql`](supabase/orte.sql) (Einkaufsorte wie Supermarkt oder Drogeriemarkt) und [`supabase/videos.sql`](supabase/videos.sql) (Speicherordner für den Import aus Videos) und [`supabase/alternativen.sql`](supabase/alternativen.sql) (Alternativrezepte).
2. **Login-Weiterleitung:** Unter **Authentication → URL Configuration** als **Site URL** `https://lufre136.github.io/Kochbuch/` eintragen und dieselbe Adresse bei **Redirect URLs** hinzufügen. Sonst führen Bestätigungs-Mails ins Leere.
3. **Veröffentlichen:** Im GitHub-Repository unter **Settings → Pages** bei *Source* „Deploy from a branch“, Branch `main`, Ordner `/ (root)` wählen. Nach ein bis zwei Minuten ist die App unter `https://lufre136.github.io/Kochbuch/` erreichbar.
4. **Import per Link einrichten:** Im Supabase-Dashboard **Edge Functions → Deploy a new function → Via Editor** wählen, als Namen `import-recipe` eintragen, den Inhalt von [`supabase/functions/import-recipe/index.ts`](supabase/functions/import-recipe/index.ts) einfügen und auf **Deploy function** klicken. Danach in den Einstellungen der Funktion **Verify JWT** ausschalten (die Funktion prüft die Anmeldung selbst).
5. **Import aus Videos (YouTube, Shorts, TikTok):** Unter **Edge Functions → Secrets** zwei Secrets anlegen: `GEMINI_API_KEY` (kostenloser Schlüssel aus dem Google AI Studio, wertet das Video aus) und `YOUTUBE_API_KEY` (YouTube Data API v3, liefert Titel und Beschreibung). Ohne `GEMINI_API_KEY` übernimmt der Import nur Titel, Bild, Link und Videobeschreibung. Optional legt `GEMINI_MODEL` das Gemini-Modell fest (Standard: `gemini-flash-latest`).
6. **Import aus Fotos, Videos und Text:** Im Import-Bereich „📷 Aus Fotos“ wählen und bis zu sechs Fotos von Kochbuchseiten oder handgeschriebenen Rezepten auswählen. Gemini liest das Rezept aus (braucht ebenfalls `GEMINI_API_KEY`). Nährwerte übernimmt der Import, wenn die Seite, das Foto oder das Video sie nennt. Bei einem TikTok-Link liest die Funktion zuerst die Videoseite: hat das Video Untertitel, macht Gemini daraus ein Rezept mit Zeitstempeln; ist es ein Foto-Post, wertet es die Bilder aus; sonst bleibt die Bildunterschrift. Klappt das alles nicht (TikTok sperrt Abrufe aus Rechenzentren zeitweise), das Video in TikTok über „Teilen“ → „Video speichern“ aufs Handy laden und mit „🎬 Aus Video“ hochladen (bis 50 MB); die Edge Function gibt es an Gemini und löscht es danach. „📝 Text einfügen“ wertet z. B. einen Kommentar mit dem Rezept aus.
7. **Aufs iPhone:** Die Adresse in Safari öffnen, auf *Teilen* tippen und **Zum Home-Bildschirm** wählen.

Die Supabase-Adresse und der Publishable Key stehen in [`js/config.js`](js/config.js). Der Key ist für den Browser gedacht; wer welche Daten sehen darf, regeln die Zugriffsregeln in `schema.sql`.

## Entwicklung

Kein Build-Schritt nötig, alles sind statische Dateien.

```sh
npm start   # lokaler Server auf http://localhost:8080
npm test    # Tests für Zutaten-Parser, Portionsrechner, Rezept-Import, Zutatensuche, Einkaufslisten und Saisonkalender
```

Schritte sind entweder Text oder `{ text, t, v }` mit `t` = Sekunden im Video und `v` = Kennung des Videos (z. B. `youtube:dQw4w9WgXcQ`). Jeder Video-Link von YouTube oder TikTok unter den Quellen ist ein Video des Rezepts; stehen dort mehrere, schaltet eine Leiste über dem Player zwischen ihnen um, und am Zeitstempel steht die Nummer des Videos. Ein Tipp darauf wechselt zum passenden Video und springt an die Stelle. Alte Schritte ohne `v` gehören zum ersten Video. Wird ein Video-Link aus den Quellen gelöscht, verlieren seine Schritte beim Speichern den Zeitstempel.

Zutaten werden als eine Zeile pro Zutat eingegeben („200 g Mehl“, „½ Bund Petersilie“, „2-3 Zehen Knoblauch“) und als `{ amount, amountMax, unit, name }` gespeichert. So kann die App sie auf eine andere Personenzahl umrechnen. Eine Anmerkung in Klammern („200 g Mehl (Type 405)“) wird als `note` gespeichert und kommt nicht mit auf die Einkaufsliste; Plural-Klammern wie „Ei(er)“ fallen weg.

Jede Zutat hat eine Kategorie (Obst, Gemüse, Fleisch & Wurst …). Kommt eine Zutat zum ersten Mal vor, schlägt [`js/categories.js`](js/categories.js) anhand des Namens eine vor; ändern lässt sie sich in der Vorschau unter dem Zutatenfeld oder auf der Einkaufsliste (nach rechts wischen). Die Zuordnungen gelten pro Nutzer, auch für übernommene Rezepte.

## Alternativrezepte

Zu einem Rezept lassen sich andere Rezepte als Alternative hinterlegen (im Rezept auf „Bearbeiten“, Abschnitt *Alternativen*). Eine Verknüpfung gilt immer in beide Richtungen: hängt B als Alternative an A, erscheint A auch bei B. „+ Alternative“ sucht über Titel und Tags; hat ein gefundenes Rezept selbst Alternativen, lassen sich mit einem Tipp alle übernehmen. Darunter schlägt die App Rezepte mit gemeinsamen Tags vor.

In der Rezeptansicht ist das aufgerufene Rezept das Hauptrezept; mit Wischen nach links oder rechts (oder über die Pfeile) wechselt man zu den Alternativen. Die Punkte unter dem Titel zeigen, wo man ist.

## Rezepte kombinieren

Im Rezept auf „Kombinieren“ tippen (oder `#/kombinieren` öffnen). Das aufgerufene Rezept ist das Hauptrezept: seine Zutaten, Bilder, Zeiten und Personenzahl stehen schon im neuen Rezept. Über „+ Rezept“ kommen weitere dazu, auch aus freigegebenen Kochbüchern.

Die Schritte der Ausgangsrezepte werden in der Reihenfolge angetippt, in der gekocht wird; ein weiterer Tipp nimmt einen Schritt wieder heraus, und mit ↑ ↓ lässt sich die Reihenfolge ändern. Nennt ein gewählter Schritt eine Zutat seines Rezepts, die noch fehlt, kommt sie automatisch dazu — umgerechnet auf die Personenzahl des Hauptrezepts. Steht die Zutat schon drin, bleibt die Menge des Hauptrezepts stehen und die andere Menge erscheint als Hinweis. Weil nicht jeder Schritt seine Zutaten nennt („Alles verrühren“), gibt es je Rezept die Liste „Weitere Zutaten aus …“ zum Nachtragen.

„Weiter“ öffnet das Bearbeiten-Formular mit Titel „A + B“, den Tags aller Rezepte und allen Quellen; die Zeitstempel behalten ihr Video. Nach dem Speichern wird das neue Rezept mit allen Ausgangsrezepten als Alternative verknüpft, und die App fragt, ob die Ausgangsrezepte gelöscht werden sollen.

## Teilen

- **Einzelnes Rezept:** Im Rezept auf „Teilen“ tippen. Der Link (`#/teilen/…`) zeigt das Rezept auch ohne Konto; mit Konto lässt es sich ins eigene Kochbuch übernehmen. „Teilen beenden“ macht den Link ungültig.
- **Ganzes Kochbuch:** Unter „Geteilt“ einen Einladungslink erstellen. Wer ihn mit eigenem Konto öffnet, bekommt Lesezugriff auf alle Rezepte. Leser lassen sich dort einzeln entfernen; ein neuer Link macht den alten ungültig.
- **Einkaufsliste:** Unter „Einkauf“ → „Liste verwalten“ einen Einladungslink erstellen. Wer ihn mit eigenem Konto öffnet, kann die Liste mitbearbeiten; Änderungen erscheinen auf allen Geräten sofort.

## Einkaufslisten

Im Plan setzt „Auf die Einkaufsliste“ die Zutaten eines eingeplanten Rezepts (umgerechnet auf die geplante Personenzahl) auf eine Liste. Jeder Eintrag merkt sich, aus welchen Rezepten er stammt. Steht eine Zutat schon offen auf der Liste und passen die Einheiten (gleich oder umrechenbar wie g/kg), fragt die App, ob zusammengerechnet oder ein neuer Eintrag angelegt werden soll. Über die Rezept-Chips oben in der Liste nimmt man alles wieder heraus, was ein Rezept beigetragen hat; von Hand eingetragene Mengen bleiben stehen.

## Saisonkalender

Unter „Was kochen?“ → „Saison“ zeigt die App, welches Obst und Gemüse in Deutschland gerade frisch (oder auf Wunsch als Lagerware) zu haben ist, und darunter die eigenen Rezepte, die davon etwas enthalten. Die Daten stehen in [`js/season.js`](js/season.js) und lassen sich dort ergänzen.
