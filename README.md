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
