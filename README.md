# Thunderbird Mail Assistant

Thunderbird-Add-on, das Claude beim Schreiben und Lesen von Mails einbindet: Umformulieren im
Verfassen-Fenster, Zusammenfassen und Fragen zu Mails, Abfragen über das Postfach.

Status: Version 0.5.0, Phasen 1 bis 5 umgesetzt (Schreiben, Lesen, Postfach-Abfrage), nur macOS und
nur mit lokal installiertem Claude Code. Spezifikation und Phasen stehen in
[SPEC.md](SPEC.md), die Arbeitsregeln für die Entwicklung mit Claude Code in [CLAUDE.md](CLAUDE.md).

## Mindestversion

`strict_min_version` ist `128.0`. Laut Thunderbird-Doku wird Manifest V3 für MailExtensions
offiziell ab Thunderbird 128 ESR unterstützt (https://webextension-api.thunderbird.net/en/mv3/ und
https://developer.thunderbird.net/add-ons/mailextensions, dort: "Supported versions are 2 and 3
(since Thunderbird 128)"). 128 ist zugleich eine ESR-Linie und damit die älteste sinnvolle Basis;
entwickelt und getestet wird mit Thunderbird 160.

## Entwicklung

```
npm install
npm run check   # Build, Typprüfung, Lint, web-ext lint, Tests
npm run start   # baut und startet Thunderbird mit dem Add-on
```

`npm run start` verwendet ein eigenes Testprofil in `.tb-dev-profile/` (nicht im Git), niemals das
echte Thunderbird-Profil. Beim ersten Start ist dort noch kein Konto eingerichtet: Lege ein
Testkonto an, damit sich eine Mail anzeigen und ein Verfassen-Fenster öffnen lässt, in denen die
Buttons des Add-ons erscheinen. Ohne echtes Konto geht es so:

- Mailansicht: Datei → Öffnen → Gespeicherte Nachricht… → `test/fixtures/hello.eml`
  (nicht im Finder doppelklicken, das öffnet das normale Thunderbird).
- Verfassen: ein Newsgruppen-Konto mit Fantasiewerten anlegen (z. B. Server
  `news.example.invalid`); es braucht keine Serververbindung, liefert aber eine Absender-Identität.

## Native-Messaging-Host installieren

```sh
npm run host:install
```

Das Skript registriert den Host `mail_assistant` für Thunderbird (nur macOS, aktueller Nutzer):

- `~/Library/Application Support/mail-assistant/host.mjs`: **Kopie** von `host/host.mjs`
  (Thunderbird soll keine Dateien aus `~/Documents` ausführen, sonst fragt macOS nach Zugriff).
  Nach jeder Änderung an `host/host.mjs` das Installationsskript erneut ausführen!
- `~/Library/Application Support/mail-assistant/launcher.sh`: Startskript mit absoluten Pfaden
  zu `node` und `claude`, weil Thunderbird den Host ohne Shell-`PATH` startet.
- `~/Library/Mozilla/NativeMessagingHosts/mail_assistant.json`: Manifest mit Verweis auf den
  Launcher und der Add-on-ID aus `extension/manifest.json`.

`claude` wird über die Login-Shell, `~/.local/bin`, `/opt/homebrew/bin` und `/usr/local/bin`
gesucht; mit `--claude <pfad>` lässt sich der Pfad vorgeben. Mit `--install-dir <ordner>` lässt sich das Installationsverzeichnis ändern. Erneut ausführen, wenn
`host.mjs` geändert oder `node` bzw. `claude` gewechselt wird. `--print` zeigt nur an, was
geschrieben würde; `npm run host:install -- --uninstall` entfernt Manifest, Launcher und Host-Kopie.

## Im eigenen Thunderbird installieren

Name "Mail Assistant", Add-on-ID `mail-assistant@paulnae.github.io`.

**Was dabei mit dem echten Postfach passiert:** Sobald du eine Aktion auslöst (Umformulieren,
Zusammenfassen, Frage zu einer Mail, Postfach-Frage), gehen die betroffenen Mailinhalte über das
lokale Claude Code an Anthropic; bei einer Postfach-Frage sind das bis zu 15 (einstellbar bis 50)
gefundene Mails. Ohne Klick passiert nichts, und das Add-on sendet, löscht oder verschiebt nie eine
Mail. Einen Einwilligungsdialog gibt es noch nicht (kommt in Phase 6).

Voraussetzungen: Thunderbird 128 oder neuer, Node 22, Claude Code (`claude`) installiert und
eingeloggt.

1. Bauen: `npm install`, dann `npm run package`. Das prüft alles (`npm run check`) und schreibt
   `web-ext-artifacts/mail-assistant-0.5.0.xpi`.
2. Helfer installieren: `npm run host:install` (schreibt nur nach
   `~/Library/Mozilla/NativeMessagingHosts/` und `~/Library/Application Support/mail-assistant/`;
   gilt für alle Thunderbird-Profile, also auch für das Testprofil von `npm run start`).
3. In Thunderbird: Extras → Add-ons und Themes → Zahnrad → "Add-on aus Datei installieren…" →
   die `.xpi` wählen und bestätigen. Thunderbird verlangt keine Signatur (siehe unten); das Add-on
   bleibt nach einem Neustart installiert.
4. Die Knöpfe erscheinen im Verfassen-Fenster, in der Mailansicht und als "Postfach fragen" in der
   Werkzeugleiste des Hauptfensters (falls nicht sichtbar: Rechtsklick auf die Leiste → Anpassen).

Aktualisieren: neue `.xpi` bauen und genauso installieren (gleiche ID, höhere Versionsnummer in
`extension/manifest.json`). Nach Änderungen an `host/host.mjs` zusätzlich `npm run host:install`.

Entfernen: Add-ons und Themes → Mail Assistant → "…" → Entfernen; danach den Helfer mit
`npm run host:install -- --uninstall` löschen (dann funktioniert auch das Testprofil nicht mehr,
bis der Helfer wieder installiert ist).

Signatur: Thunderbird wird ohne Signaturpflicht gebaut (`imply_option("MOZ_REQUIRE_SIGNING", False)`
in [`mail/moz.configure`](https://searchfox.org/comm-central/source/mail/moz.configure)), daher
lässt sich eine unsignierte `.xpi` dauerhaft installieren. Die Entwicklerdoku beschreibt die
Installation einer `.xpi` über das Zahnrad-Menü
(https://developer.thunderbird.net/add-ons/hello-world-add-on), sagt aber nichts zur Signatur.
