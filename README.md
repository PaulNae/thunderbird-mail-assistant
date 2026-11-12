# Thunderbird Mail Assistant

Thunderbird-Add-on, das Claude beim Schreiben und Lesen von Mails einbindet: Umformulieren im
Verfassen-Fenster, Zusammenfassen und Fragen zu Mails, Abfragen über das Postfach.

Status: in Planung, noch kein lauffähiger Code. Spezifikation und Phasen stehen in
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
