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

- Add-on → Host: `{id, type:"run", system, prompt, model}`, `{id, type:"cancel"}`, `{type:"check"}`
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
- [ ] Einwilligungsdialog beim ersten Start (welche Daten wohin gehen)
- [ ] Einstellungsseite: Backend, Modelle, Limits, Backend-Check
- [ ] Prompt-Injection-Tests mit präparierten Mails
- [ ] Lokalisierung de/en vollständig, Tastaturbedienung, helles und dunkles Theme
- [ ] `security-review` über das gesamte Projekt

### Phase 7 – Veröffentlichung
- [ ] `ApiBackend` mit API-Key (Standard für veröffentlichte Version)
- [ ] Host-Installer für Windows und Linux
- [ ] Nutzungsbedingungen von Anthropic für das CLI-Backend prüfen; Produktname ohne "Claude" vorn
- [ ] Datenschutzerklärung, Store-Texte, Einreichung bei addons.thunderbird.net

## Offene Entscheidungen

- Produktname und Add-on-ID (bis dahin Arbeitstitel "Mail Assistant").
- Lizenz (vor einer Veröffentlichung festlegen).
