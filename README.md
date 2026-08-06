# Morgenbriefing

Jeden Werktagmorgen eine Mail mit **einem** Fakt aus einer echten, geprüften Studie —
aufbereitet zum Weitererzählen.

Kein zusammengesuchtes Trivia: Die Pipeline holt Arbeiten aus Fachdatenbanken,
bewertet ihre Belastbarkeit und schreibt erst danach den Text. Ein Sprachmodell
sucht sich nichts selbst aus.

---

## Warum der Umweg über echte Datenbanken

Fragt man ein Sprachmodell einfach nach „einem spannenden Fakt mit Studie", erfindet
es mit hoher Wahrscheinlichkeit eine plausibel klingende Quelle samt Journal und
Jahreszahl. Die gibt es dann nicht.

Dazu kommt das größere Problem: Schlaf, Produktivität, Ernährung und Psychologie sind
die von der **Replikationskrise** am stärksten betroffenen Felder. Die bekanntesten
„Fun Facts" daraus sind widerlegt — Power Posing, Ego Depletion, der Marshmallow-Test
als Erfolgsvorhersage, die 10.000-Stunden-Regel. Wer die weitererzählt und auf jemanden
trifft, der den Forschungsstand kennt, steht schlechter da als vorher.

Deshalb läuft die Pipeline andersherum:

```
echte Studie holen  →  Qualität prüfen  →  Zombie-Befunde aussortieren
                    →  auswählen        →  erst dann schreiben
```

## Ablauf

1. **Quellen** (`src/sources/`) — Europe PMC, PubMed, Crossref, OpenAlex, NBER.
   Alle ohne API-Key. Die Suchanfragen bevorzugen gezielt Metaanalysen, systematische
   Übersichtsarbeiten und randomisierte Studien.
2. **Bewertung** (`src/scoring/`) — jede Studie bekommt 0–100 Punkte aus Studientyp,
   Stichprobengröße, Zitationen relativ zum Alter, Publikationsort und Aktualität.
   `data/zombies.json` listet 36 bekannt widerlegte Befunde; ein Treffer führt zum
   harten Ausschluss. Daneben läuft die Relevanzbewertung (siehe unten).
3. **Auswahl** (`src/select/`) — Dubletten über Quellen hinweg zusammenführen, alles
   aus `data/history.json` bereits Verschicktes verwerfen, dann Hauptfakt (strengere
   Schwelle) und zwei Nachschläge wählen. Reicht das Material nicht, kommt bewusst
   **keine** Mail statt einer schwachen.
4. **Text** (`src/write/`) — Claude bekommt ausschließlich die echten Abstracts und
   darf keine Zahl nennen, die dort nicht steht. Titel, Journal, Jahr und Link setzen
   wir hinterher selbst ein, damit sie gar nicht erst erfunden werden können.
5. **Versand** (`src/render/`, `src/deliver/`) — HTML-Mail über das eigene Gmail-Konto,
   Kopie als Markdown ins `archive/`.

## Aufbau eines Briefings

Der Hauptfakt folgt immer derselben Dramaturgie:

| Block | Aufgabe |
|---|---|
| **Aufhänger** | Eine Frage, bei der man kurz selbst überlegt |
| **Befund** | Das Ergebnis mit einer konkreten, merkbaren Zahl |
| **Warum das so ist** | Der Wirkmechanismus — hier entsteht der Aha-Moment |
| **Wie gut belegt** | Belastbarkeit in Alltagssprache, keine p-Werte |
| **Was die Studie nicht sagt** | Die Einschränkung |
| **Der Satz für abends** | Eine Zeile, die man wirklich so sagen kann |

Der vorletzte Block ist der wichtigste. Wer die Einschränkung mitliefert
(„gilt aber nur für Menschen über 50"), wirkt informiert statt nachplappernd.

## Themenrotation

Zehn Themen über zwei Wochen — der Zyklus hängt an der ISO-Kalenderwoche.

| | Mo | Di | Mi | Do | Fr |
|---|---|---|---|---|---|
| **Woche A** | Schlaf | Produktivität & Fokus | Körper & Gesundheit | Wirtschaft | Psychologie |
| **Woche B** | Lernen & Gedächtnis | Umwelt & Alltagseinflüsse | Ernährung | Zeit, Pendeln & Städte | Beziehungen & soziale Bindung |

Ohne feste Zuordnung landet man schnell mehrmals hintereinander beim selben
Gegenstand, weil manche Felder deutlich mehr publizieren als andere.

## Die zweite Achse: Alltagsrelevanz

Belegstärke allein reicht nicht. Die Fachliteratur zieht systematisch in die
falsche Richtung: Die methodisch saubersten Arbeiten sind fast immer die
engsten. Eine Metaanalyse zum Eierstockkrebsrisiko in asiatischen Populationen
ist erstklassige Wissenschaft und als Gesprächsstoff wertlos.

`src/scoring/relevance.ts` bewertet deshalb getrennt, ob ein Befund jemanden
betrifft, der nicht vom Fach ist — alltägliche Gegenstände heben die Bewertung,
enge klinische Themen, seltene Teilpopulationen und reine Methodenarbeiten
senken sie. Die Auswahl rangiert nach beiden Achsen zusammen und prüft
zusätzlich, ob eine Studie überhaupt zum Thema des Tages gehört; die
Suchanfragen müssen breit sein, und dabei rutscht regelmäßig Fachfremdes durch.

## Wie Wiederholungen verhindert werden

Vier Ebenen, weil „schon mal gehört" das Briefing schneller ruiniert als ein
schwacher Fakt:

| Ebene | Wogegen |
|---|---|
| DOI-Abgleich im Lauf | Dieselbe Arbeit kommt gleichzeitig über Europe PMC, PubMed und Crossref herein |
| `data/history.json` | Eine einmal verschickte Studie kommt **nie** wieder |
| Themensperre, 42 Tage | Nicht die dritte Prokrastinations-Metaanalyse in vier Wochen — verglichen werden Inhaltswörter der Titel, Methoden-Floskeln wie „systematic review and meta-analysis" zählen dabei nicht |
| Ähnlichkeit in der Ausgabe | Die beiden Kurzfakten dürfen dem Hauptfakt nicht zu nahe kommen |

Die Sperrfrist ist bewusst endlich: Dauerhaft gesperrte Themen würden nach einem
Jahr die ergiebigsten Felder verbrennen. Beide Werte stehen in `src/config.ts`.

---

## Einrichtung

Einmalig nötig, danach läuft es von allein. Rechne mit rund 10 Minuten.

### 1. Gmail-App-Passwort erzeugen

Die Mail geht über dein eigenes Gmail-Konto. Dafür braucht es ein App-Passwort —
nicht dein normales Google-Passwort.

1. Zwei-Faktor-Authentifizierung aktivieren (Voraussetzung):
   [myaccount.google.com/security](https://myaccount.google.com/security) → „Bestätigung in zwei Schritten"
2. App-Passwort anlegen: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Namen vergeben, z. B. `valro-briefing` → **Erstellen**
4. Das 16-stellige Passwort wird **nur einmal** angezeigt — direkt in Schritt 3 einfügen.

> Bei Google Workspace mit eigener Domain muss der Admin App-Passwörter erlauben.
> Falls der Menüpunkt fehlt, ist genau das der Grund.

### 2. Anthropic-API-Key holen

[console.anthropic.com](https://console.anthropic.com) → API Keys → **Create Key**

### 3. Secrets in GitHub eintragen

`Settings` → `Secrets and variables` → `Actions` → **New repository secret**

| Name | Wert |
|---|---|
| `ANTHROPIC_API_KEY` | Der Key aus Schritt 2 |
| `SMTP_USER` | Deine Gmail-Adresse |
| `SMTP_PASSWORD` | Das 16-stellige App-Passwort aus Schritt 1 |
| `MAIL_TO` | Die Adresse, an die das Briefing gehen soll |

Optional unter *Variables* statt *Secrets*: `MAIL_FROM_NAME` (Absendername, Standard: „Morgenbriefing").

### 4. Testlauf

`Actions` → **Tägliches Briefing** → `Run workflow`. Für einen Probelauf ohne Versand
`dry_run` auf `true` setzen; das Ergebnis steht dann im Job-Log.

Danach läuft es automatisch Mo–Fr um 06:30 (Sommerzeit) bzw. 05:30 (Winterzeit).

---

## Lokal ausführen

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...

npm run preview                      # erzeugen, nichts verschicken, History ignorieren
npm run briefing -- --topic sleep    # bestimmtes Thema erzwingen (10 möglich)
npm run typecheck
npm test
```

## Kosten

Rund 1–2 € im Monat für die Claude-Aufrufe. Alle Studienquellen sind kostenlos,
GitHub Actions ist für öffentliche Repos gratis, Gmail-Versand ebenfalls.

## Wenn etwas nicht klappt

| Symptom | Ursache |
|---|---|
| `Fehlende Secrets: ...` | Secret fehlt oder heißt anders — Schritt 3 prüfen |
| `Invalid login` beim SMTP | Normales Passwort statt App-Passwort, oder 2FA nicht aktiv |
| `Nicht genug Material über der Qualitätsschwelle` | Kein Fehler, sondern Absicht. Schwellen stehen in `src/config.ts` |
| Keine Mail, Job aber grün | Spam-Ordner prüfen und Absender als „kein Spam" markieren |

## Später: Audio

Der Aufbau ist so geschnitten, dass eine Sprachausgabe nur ein weiteres Ausgabemodul
neben `src/render/email.ts` braucht — Text zu Sprache, MP3 in einen privaten
Podcast-Feed. Inhalts-Pipeline und Qualitätsfilter bleiben unverändert.
