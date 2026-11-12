# Spezifikation

## Ziel

Claude in Thunderbird so nutzbar machen wie einen eingebauten Schreib- und Leseassistenten:

1. **Schreiben:** markierten Text oder die ganze Mail umformulieren, kürzen, im Ton ändern,
   übersetzen; Antwort auf eine Mail entwerfen.
2. **Lesen:** offene Mail oder Thread zusammenfassen, Fragen dazu stellen.
3. **Abfragen:** Fragen über das Postfach stellen ("Was hat X zum Angebot geschrieben?").

Erste Ausbaustufe: nur für den Eigengebrauch, macOS, Backend "lokales Claude Code".
Die Veröffentlichung (Phase 7) ist vorbereitet, aber nicht Teil der ersten Stufe.

## Architektur

```
extension/            MailExtension, Manifest V3, TypeScript
  background/         Hintergrundskript: Routing, Backend-Auswahl, Mailzugriff
  backend/            Schnittstelle Backend + CliBackend (+ später ApiBackend)
  compose/            Popup der compose_action
  display/            Popup der message_display_action
  chat/               Tab für Postfach-Abfragen
  options/            Einstellungen
  prompts/            Prompt-Bausteine, an einer Stelle
  _locales/de, en
host/                 Native-Messaging-Host (Node, ohne Abhängigkeiten)
  host.mjs            liest Anfragen, startet `claude -p`, streamt Antwort zurück
  install-macos.mjs   schreibt das Host-Manifest, ermittelt den absoluten Pfad zu `claude`
test/
```

### Backend-Schnittstelle

```ts
interface Backend {
  // Streamt Textstücke; wirft BackendError mit maschinenlesbarem code.
  run(req: { system: string; prompt: string; model?: string; signal: AbortSignal }): AsyncIterable<string>;
  check(): Promise<{ ok: boolean; detail?: string }>;   // für die Einstellungsseite
}
```

UI-Code kennt nur diese Schnittstelle. `CliBackend` hält einen Port zum Host
(`messenger.runtime.connectNative`), `ApiBackend` (Phase 7) ruft die Messages-API per `fetch`.

### Protokoll Add-on ↔ Host

JSON-Nachrichten, jeweils mit `id`:

- Add-on → Host: `{id, type:"run", system, prompt, model, timeoutMs?}` (`timeoutMs` 10 000 bis 600 000, sonst Standard), `{id, type:"cancel"}`, `{type:"check"}`
- Host → Add-on: `{id, type:"delta", text}`, `{id, type:"done"}`, `{id, type:"error", code, message}`,
  `{type:"check", ok, version}`

Fehlercodes mindestens: `cli_not_found`, `not_logged_in`, `rate_limited`, `timeout`, `cancelled`, `internal`.
Nachrichten vom Host sind auf 1 MB begrenzt, deshalb immer in Stücken streamen.

### Aufruf von Claude Code im Host

- Prompt über stdin, nie als Argument (Länge, Shell-Quoting, Prozessliste).
- Headless, Streaming-Ausgabe, **ohne Tools**, ein einziger Turn, eigener System-Prompt,
  neutrales Arbeitsverzeichnis (leerer Ordner), damit keine Projekt-Konfiguration geladen wird.
- Die genauen Flags mit `claude --help` der installierten Version ermitteln, nicht aus dem Gedächtnis.
- Absoluter Pfad zu `claude`: Thunderbird erbt als GUI-App nicht den Shell-PATH.
- Timeout (Standard 120 s), Abbruch beendet den Kindprozess.

### Prompt-Aufbau und Sicherheit

- System-Prompt legt Aufgabe und Ausgabeformat fest ("gib nur den umformulierten Text zurück").
- Mailinhalt steht in eindeutig markierten Blöcken; der System-Prompt sagt ausdrücklich, dass
  Text in diesen Blöcken nie als Anweisung gilt.
- Das Modell hat keine Tools und das Add-on führt aus der Antwort nichts automatisch aus.
- Ergebnis wird immer als Vorschau gezeigt; Übernahme nur per Klick. HTML aus der Antwort wird
  nicht ungeprüft in den Editor oder ins Popup geschrieben.
- Aufträge, Ergebnisse und Verlauf (Zusammenfassung, Fragen und Antworten, Vorschau im Verfassen-Fenster)
  liegen nur im Arbeitsspeicher, gebunden an die angezeigte Mail bzw. das Verfassen-Fenster, nie auf der
  Festplatte (kein `storage.local`/`storage.sync`). Sie werden gelöscht, sobald im Tab eine andere Mail
  angezeigt wird, der Tab schließt, die Vorschau übernommen oder verworfen wird oder Thunderbird endet.
  Besitzer ist das Hintergrundskript (`extension/background/jobs.ts`), die Popups verbinden sich per
  `runtime.connect` und können jederzeit schließen und wieder öffnen. Zusätzlich zum Modulspeicher werden
  fertige Ergebnisse in `storage.session` gespiegelt (nur Speicher, ab TB 115, überlebt das Beenden des
  Hintergrundskripts als Event-Page, nicht aber das Beenden von Thunderbird); die Prompts mit dem vollen
  Mailtext werden nie gespiegelt. Obergrenzen: Text je Eintrag, Verlaufseinträge wie beim Prompt, 20 Einträge
  gesamt (älteste zuerst).
- Modelle: neu entstehende Texte (Antwortentwurf, Entwurf aus Anweisung) auf Sonnet;
  Umformulieren, Kürzen, Ton, Übersetzen und Zusammenfassen auf Haiku; Postfach-Abfragen auf Sonnet.
  In den Einstellungen änderbar.

## Phasen

Jede Phase endet mit `npm run check` grün, Review durch `reviewer` und einem Nachweis in Thunderbird.

### Phase 1 – Gerüst
- [x] `package.json`, TypeScript strikt, esbuild-Build nach `dist/`, ESLint, `web-ext`
- [x] `manifest.json` (MV3, Add-on-ID, `strict_min_version` nach Doku festlegen und begründen)
- [x] Hintergrundskript und leere `compose_action` / `message_display_action` mit Popup
- [x] `npm run start` öffnet Thunderbird mit geladenem Add-on

Abnahme: Beide Buttons erscheinen und öffnen ein Popup; `web-ext lint` ohne Fehler.
Nachgewiesen am 2026-11-12 in Thunderbird 160: beide Buttons öffnen ihr Popup (Nutzer-Test im Testprofil).

### Phase 2 – Bridge
- [x] Voraussetzung prüfen: `claude` installiert und eingeloggt (sonst Nutzer fragen)
- [x] `host/host.mjs` mit Protokoll, Streaming, Timeout, Abbruch, Fehlercodes
- [x] `host/install-macos.mjs` (Pfad des Host-Manifests in der Doku nachschlagen und testen)
- [x] `Backend`-Schnittstelle und `CliBackend`
- [x] Tests für den Host mit einem Fake-`claude`-Skript (Framing, Streaming, Abbruch, Fehler)

Abnahme: Ein Testknopf im Popup schickt "Sag Hallo" und zeigt die gestreamte Antwort;
ohne installierte CLI erscheint eine verständliche Fehlermeldung.
Nachgewiesen am 2026-11-12 in Thunderbird 160 (Nutzer-Test im Testprofil, Verfassen-Fenster): gestreamte
Antwort auf "Sag Hallo"; mit falschem `claude`-Pfad die Meldung "Claude Code wurde nicht gefunden …",
ohne registrierten Host "Der Hilfsdienst ist nicht installiert …". Host-Manifest-Ort
`~/Library/Mozilla/NativeMessagingHosts/` damit bestätigt.

### Phase 3 – Schreiben
- [x] Popup im Verfassen-Fenster: Umformulieren, Kürzen, Ton (freundlich, formell, knapp),
      Übersetzen (de/en), freie Anweisung
- [x] Arbeitet auf der Markierung, sonst auf dem ganzen Text; Zitate und Signatur bleiben unberührt
- [x] Vorschau mit Übernehmen, Verwerfen, Neu erzeugen; Abbrechen während des Streamings
- [x] Funktioniert im HTML- und im Nur-Text-Modus
- [x] Antwortentwurf: aus der beantworteten Mail plus Stichworten des Nutzers
- [x] Freie Anweisung bei leerem Text erzeugt neuen Text (Entwurf aus Anweisung)

Abnahme: Markierten Absatz in einer HTML-Mail umformulieren und übernehmen, Rest der Mail
inklusive Formatierung und Signatur unverändert; dasselbe in einer Nur-Text-Mail.
In einer leeren neuen Mail erzeugt eine freie Anweisung einen Entwurf, der nach Klick eingefügt wird;
in einer leeren Antwort landet er vor Zitat und Signatur, beide bleiben unverändert.
Nachgewiesen am 2026-11-12 in Thunderbird 160: Abnahme vom Nutzer im Testprofil bestätigt (Umformulieren und Übernehmen in HTML- und Nur-Text-Mail, Entwurf aus Anweisung).

### Phase 4 – Lesen
- [x] Popup in der Mailansicht: Zusammenfassung, Frage stellen, "Antwort entwerfen" (öffnet Phase 3)
- [x] Thread-Kontext: zugehörige Mails einbeziehen, mit Obergrenze für die Textmenge
- [x] HTML-Mails zu Text reduzieren, Anhänge nur als Namen nennen

Abnahme: Zusammenfassung einer langen HTML-Mail und eine Folgefrage dazu, jeweils gestreamt.
Nachgewiesen am 2026-11-12 in Thunderbird 160: Abnahme vom Nutzer im Testprofil bestätigt (Zusammenfassung der langen HTML-Mail `test/fixtures/long-html.eml` und Folgefrage, jeweils gestreamt; "Antwort entwerfen" aus einem lokalen Ordner). Aus einer Datei geöffnete Mails: Antwortfenster lässt sich nicht per `beginReply` öffnen, Popup nennt den normalen Antworten-Knopf als Weg.

#### Nacharbeit
- [x] Antworten mit der Identität, an die die Mail ging (`accountsRead`); Thread-Suche auf das Konto der Mail begrenzt
- [x] Laufende Aufträge und das letzte Ergebnis überleben das Schließen des Popups (Hintergrundskript als Besitzer,
      `runtime.connect`, `storage.session` als Spiegel; Compose-Erfassung bleibt im Editor-Skript, das Popup
      liest beim Wiederöffnen nur per `peek`)

Abnahme: Zusammenfassung starten, rausklicken, Popup wieder öffnen, Ergebnis ist da; andere Mail anklicken,
Ergebnis ist weg; dasselbe mit einem Entwurf im Verfassen-Fenster; Antwort auf eine Mail an eine
Nicht-Standard-Adresse nutzt diese Adresse.
Nachgewiesen am 2026-11-12 in Thunderbird 160: Abnahme vom Nutzer im Testprofil bestätigt (Ergebnis überlebt Schließen des Popups, verschwindet bei Mailwechsel; Entwurf im Verfassen-Fenster). Ob die Identitätswahl mit einem Konto mit mehreren Adressen geprüft wurde, ist nicht belegt.

### Phase 5 – Postfach-Abfrage
- [x] Chat-Tab; Schritt 1: Modell erzeugt aus der Frage Suchparameter (strukturierte Ausgabe)
- [x] Schritt 2: Suche über die Thunderbird-API, Treffer begrenzen und kürzen
- [x] Schritt 3: Antwort mit Verweisen, die die jeweilige Mail öffnen
- [x] Anzeige, wie viele Mails an das Modell gingen; harte Obergrenze einstellbar

Abnahme: Eine Frage, deren Antwort in einer bekannten Mail steht, wird korrekt beantwortet und
verlinkt die Mail.
Nachgewiesen am 2026-11-12 in Thunderbird 160: Abnahme vom Nutzer im Testprofil bestätigt (Testmails aus `test/fixtures/query/` in einem lokalen Ordner: Frage nach dem Preis des Angebots korrekt beantwortet, Verweis öffnet die Mail; Folgefrage nach über einer Minute Pause beantwortet; Frage ohne Treffer führt zur Meldung "nichts gefunden"). Nicht geprüft: Volltextsuche in IMAP-Ordnern ohne Offline-Kopie, Reihenfolge der Treffer bei großen Postfächern, von Thunderbird wiederhergestellter Chat-Tab.

### Phase 6 – Härtung
- [x] Einwilligungsdialog beim ersten Start (welche Daten wohin gehen); durchgesetzt im Hintergrundskript
      (`background/gated-backend.ts`), widerrufbar, ein Widerruf bricht laufende Aufträge ab; gespeichert wird nur
      `{version}` unter `consent` in `storage.local`
- [x] Einstellungsseite (`options/`): Modelle je Aufgabe, Obergrenzen (Mails je Postfach-Frage, Textmenge,
      Zeitlimit je Modellaufruf), Verbindungstest, Einwilligung. Der Backend-Umschalter folgt erst mit Phase 7.
      Eine Textmenge ersetzt die früheren getrennten Konstanten (Standard 40 000 Zeichen, vorher Verlauf 40 000,
      eigener Text und Originalmail 30 000, Postfach-Treffer 50 000). Bei der Postfach-Abfrage gilt das Modell für die
      Antwort, die Suchbegriffe ermittelt immer Haiku.
- [x] Prompt-Injection-Tests mit präparierten Mails (`test/fixtures/injection/`, `test/injection.test.ts`) und
      ein manueller Durchlauf gegen Claude Code über den Helfer
- [x] Lokalisierung de/en vollständig (`test/locales.test.ts`), Tastaturbedienung, helles und dunkles Theme
- [x] `security-review` über das gesamte Projekt (keine HIGH/MEDIUM-Befunde, LOW-Befunde behoben)

Abnahme: Einwilligungsdialog erscheint beim ersten Start und sperrt ohne Zustimmung; ein geändertes Modell und eine
geänderte Obergrenze sind im Verhalten erkennbar; der Verbindungstest zeigt den richtigen Zustand; dunkles Theme ist
lesbar; Bedienung per Tastatur geht.
Nachgewiesen am 2026-11-12 in Thunderbird 160: Abnahme vom Nutzer im Testprofil bestätigt (Einwilligungsdialog und
Sperre, Widerruf, geändertes Modell und geänderte Obergrenze, Verbindungstest, dunkles Theme, Tastatur). Der
Verbindungstest nutzt die bestehende Verbindung zum Helfer: ein bei laufendem Thunderbird deinstallierter Helfer wird
erst nach einem Neustart als "nicht installiert" gemeldet. Bildschirmleser nicht geprüft.

### Phase 7 – Veröffentlichung auf GitHub (nur Repository, CLI-Backend, macOS)
- [x] Nutzungsbedingungen von Anthropic gelesen (2026-11-12, `code.claude.com/docs/en/legal-and-compliance` und
      Consumer Terms): Das Add-on bietet keinen Claude-Login an, fasst keine Zugangsdaten an und ruft nur das vom
      Nutzer installierte, unveränderte Claude Code auf, in dem dieser selbst angemeldet ist. Ein ausdrückliches Verbot
      dafür steht dort nicht; Anthropic empfiehlt Entwicklern aber API-Keys und behält sich Durchsetzung ohne
      Vorankündigung vor. Daher: CLI-Backend nur im GitHub-Repository, Store-Version mit API-Key (Phase 8).
- [x] Lizenzdatei (MIT), Urheber "PaulNae"
- [x] README auf Englisch, mit Abschnitten zu Datenschutz (was wann wohin geht, Verweis auf Anthropics
      Datenschutzerklärung, Hinweis auf Daten Dritter in Mails) und zu Anthropic (kein offizielles Produkt, eigenes
      Claude Code und eigenes Konto nötig, Abo laut Consumer Terms nicht für geschäftliche Nutzung)
- [x] Übrige nach außen sichtbare Texte auf Englisch (Ausgaben des Installers waren es schon, `package.json` ergänzt); SPEC.md und CLAUDE.md
      bleiben deutsch
- [x] Git-Historie auf die GitHub-Noreply-Adresse umgeschrieben und neu gepusht (2026-11-12). Das Repository wurde danach neu
      angelegt, weil GitHub überschriebene Commits über ihre Kennung abrufbar hält; das alte heißt
      `thunderbird-mail-assistant-old` (privat, vom Nutzer zu löschen)
- [x] GitHub-Release `v0.6.0` mit der `.xpi`
- [x] Repository öffentlich geschaltet (2026-11-12, auf Wort des Nutzers)

### Phase 8 – API-Key-Backend, Umschalter, Hinweise (Vorbereitung Store)

Entschieden am 2026-11-12: Die Store-Version bekommt beide Backends mit Umschalter. Voreinstellung ist der API-Key,
das Abo über Claude Code ist eine bewusst zu wählende Option. Der Nutzer hat der neuen Host-Berechtigung für
`https://api.anthropic.com/*` zugestimmt; weitere neue Berechtigungen nur nach Rückfrage.

- [x] `ApiBackend`: Messages-API per `fetch` mit Streaming, gleiche `Backend`-Schnittstelle und gleiche Fehlercodes
      wie `CliBackend` (dazu ein Code für fehlenden oder ungültigen Schlüssel), Abbruch und Zeitlimit. Keine Tools.
      Modellnamen der Einstellungen (`haiku`, `sonnet`, …) auf API-Modellkennungen abbilden; die Kennungen und das
      Anfrageformat in der offiziellen API-Doku nachschlagen, nicht aus dem Gedächtnis.
- [x] API-Key: Eingabe in den Einstellungen (Passwortfeld), gespeichert in `storage.local`, nie in Logs,
      Fehlermeldungen oder `storage.sync`; geht nur an `api.anthropic.com`. Verbindungstest auch für dieses Backend.
- [x] Backend-Umschalter in den Einstellungen. Neue Installation: API-Key. Bestehende Installation (0.6.0 und älter,
      erkennbar an vorhandenen Einstellungen) bleibt beim CLI-Backend, damit beim Nutzer nichts bricht.
- [x] Einrichtungsanleitung im Add-on (de/en), als eigene Seite, erreichbar aus den Einstellungen, aus dem
      Einwilligungsdialog und aus Fehlermeldungen (`host_not_found`, `cli_not_found`, `not_logged_in`, fehlender
      Schlüssel). Für den API-Key: wo man ihn erstellt, wo man ihn einträgt, dass Kosten nach Verbrauch entstehen.
      Für Claude Code: Voraussetzungen (macOS, Node 22, Claude Code installiert und angemeldet), Helfer aus dem
      GitHub-Repository installieren (`npm run host:install`), Verbindungstest. Das CLI-Backend bleibt vorerst nur
      macOS; auf anderen Systemen sagt das die Anleitung und der Umschalter.
- [x] Hinweis am Umschalter und in der Anleitung: Das Abo (Free, Pro, Max) ist laut Anthropics Consumer Terms nur
      für private, nicht geschäftliche Nutzung; für geschäftliche Mails den API-Key verwenden. Eigenes Konto nötig,
      kein offizielles Anthropic-Produkt.
- [x] Stand-Hinweis mit Datum am Umschalter, in der Anleitung und im README: "Anthropics Bedingungen zuletzt geprüft
      am 12.11.2026. Anthropic kann sie ändern; ist die Nutzung des Abos über Claude Code auf diesem Weg nicht mehr
      erlaubt, darf diese Option nicht mehr verwendet werden. Maßgeblich sind die aktuellen Bedingungen von
      Anthropic, nicht dieser Hinweis." Mit Link auf `https://code.claude.com/docs/en/legal-and-compliance`. Das
      Datum steht als eine Konstante im Code und wird nur nach erneuter Prüfung der Bedingungen geändert.
- [x] Haftungshinweis im Einwilligungsdialog und in der Anleitung (de/en): Bereitstellung ohne Gewähr; Antworten
      des Modells können falsch sein und sind vor dem Senden zu prüfen; der Nutzer ist für die Einhaltung der
      Anthropic-Bedingungen und für die Weitergabe von Mailinhalten selbst verantwortlich; Verweis auf die
      MIT-Lizenz. Wer schon eingewilligt hat, muss den erweiterten Text einmal neu bestätigen (Versionsnummer der
      Einwilligung erhöhen).
- [x] README (englisch) und Datenschutz-Abschnitt an beide Backends anpassen; Version 0.7.0
- [x] Prüfen, ob Thunderbird `data_collection_permissions` im Manifest verlangt (Doku), und danach handeln.
      Ergebnis (2026-11-12): Thunderbird verlangt den Schlüssel nicht. Die Thunderbird-Doku (`permissions`-API, ab TB 140)
      sagt ausdrücklich, dass Thunderbird den eingebauten Zustimmungsablauf von Firefox nicht verwendet und Add-ons die
      Zustimmung selbst einholen müssen; das tut der Einwilligungsdialog. Die ATN-Richtlinie nennt den Schlüssel nicht,
      verlangt aber, dass die Steuerung bei der Installation gezeigt wird: Deshalb öffnet sich nach einer neuen
      Installation die Einrichtungsanleitung. `web-ext lint` warnt weiter (`MISSING_DATA_COLLECTION_PERMISSIONS`, Firefox-
      Regel); ein Eintrag wäre für TB 128 unbekannt und würde eine neue Manifest-Angabe bedeuten. Bei der Einreichung
      (Phase 9) erneut prüfen.
- [x] Alle Texte in `_locales` passen zum gewählten Backend und zu Store-Nutzern (Ergänzung vom 2026-11-12):
      Fehlermeldungen nennen die Ursache und verweisen per Knopf auf die Anleitung statt auf `npm`-Befehle; die Texte
      dazu, wohin Daten gehen (Einwilligung, Einstellungen), richten sich nach dem gewählten Backend; eigene Meldungen
      für das API-Backend (Schlüssel fehlt, Schlüssel ungültig, Guthaben/Abrechnung, Rate-Limit, Überlastung, keine
      Netzverbindung), nie mit dem Schlüssel; beim CLI-Backend außerhalb von macOS `cli_unsupported`. Test: jeder
      Fehlercode hat einen Text in beiden Sprachen (`test/locales.test.ts`).

Abnahme: Mit API-Key funktionieren Umformulieren, Zusammenfassen und Postfach-Frage ohne installierten Helfer; der
Umschalter wechselt das Backend erkennbar; ein fehlender oder falscher Schlüssel führt zu einer verständlichen
Meldung mit Verweis auf die Anleitung; Anleitung, Privat-Hinweis und Haftungshinweis sind in Deutsch und Englisch
sichtbar; eine bestehende 0.6.0-Installation arbeitet nach dem Update unverändert mit Claude Code weiter.
Nachgewiesen am 2026-11-12 in Thunderbird 160: Abnahme vom Nutzer im Testprofil nach der Testanleitung bestätigt
(Update von 0.6.0 bleibt bei Claude Code, Umschalter, Meldungen bei fehlendem und falschem Schlüssel, Lauf mit echtem
Schlüssel, Anleitung und Hinweise). Zusätzlich verweisen Anleitung und README für Fehler und Wünsche auf GitHub Issues.
Nicht eigens geprüft: ob ein langer API-Lauf weiterläuft, wenn das Popup währenddessen geschlossen wird. Der Link
„Mehr erfahren“ im Berechtigungsdialog von Thunderbird (support.mozilla.org) ging beim Nutzer nicht; er gehört zu
Thunderbird, nicht zum Add-on.

### Phase 9 – Einreichung im Store
- [ ] Datenschutzerklärung als Volltext, Store-Texte (en/de), Quelltext-Paket mit Bauanleitung
- [ ] Einreichung bei addons.thunderbird.net (macht der Nutzer selbst)

## Offene Entscheidungen

- ~~Produktname und Add-on-ID~~: entschieden am 2026-11-12, Name "Mail Assistant", ID `mail-assistant@paulnae.github.io`.
- ~~Lizenz~~: MIT, Urheber "PaulNae" (2026-11-12).
