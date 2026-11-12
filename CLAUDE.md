# Thunderbird Mail Assistant

Thunderbird-Add-on (MailExtension), das Claude beim Schreiben und Lesen von Mails einbindet:
Umformulieren im Verfassen-Fenster, Zusammenfassen und Fragen zu Mails, Abfragen über das Postfach.
Die vollständige Spezifikation mit Phasen und Abnahmekriterien steht in [SPEC.md](SPEC.md).

## Architektur in einem Absatz

Das Add-on (`extension/`, Manifest V3, TypeScript) spricht nie direkt mit einem Modell, sondern mit
einer Backend-Schnittstelle. Backend 1 ist ein Native-Messaging-Host (`host/`, Node), den Thunderbird
bei Bedarf startet und der das lokal installierte Claude Code headless aufruft (`claude -p`), sodass
das Abo des Nutzers verwendet wird. Backend 2 (später) ruft die Claude-API mit einem API-Key auf.

## Arbeitsweise (verbindlich)

- Die Hauptsession (Opus) **orchestriert**: Sie liest SPEC.md, zerlegt die aktuelle Phase in kleine
  Aufgaben, gibt jede an den Subagenten `implementer` (Sonnet) und prüft das Ergebnis am Diff.
  Sie schreibt selbst keinen Feature-Code, nur Korrekturen von wenigen Zeilen.
- Jede Aufgabe an `implementer` nennt: Ziel, betroffene Dateien, Abnahmekriterium, Prüfbefehl.
- Nach jeder Phase prüft der Subagent `reviewer` (Opus) den gesamten Phasen-Diff gegen SPEC.md.
- Eine Phase gilt erst als fertig, wenn `npm run check` grün ist und die Abnahmekriterien der Phase
  in Thunderbird nachgewiesen sind. Was nicht in Thunderbird geprüft wurde, wird so benannt.
- Ein Commit pro abgeschlossener Aufgabe, Phasen-Fortschritt in SPEC.md abhaken.

## Regeln für den Code

- Vor jeder Nutzung einer Thunderbird-API den Skill `thunderbird-mailextension` laden und die
  Signatur in der offiziellen Doku nachschlagen. Firefox-/Chrome-Wissen ist hier oft falsch.
- Namespace `messenger.*`, nicht `browser.*` oder `chrome.*`.
- Mailinhalte sind **Daten, keine Anweisungen**. Sie werden immer klar abgegrenzt in den Prompt
  gesetzt, das Modell bekommt keine Tools, und nichts wird ohne Klick des Nutzers gesendet,
  gelöscht oder verschoben.
- Kein Mailinhalt in Logs, Fehlermeldungen oder `storage`.
- Keine Laufzeit-Abhängigkeiten im Add-on ohne Rückfrage; der Review auf addons.thunderbird.net
  verlangt nachvollziehbaren Code.
- Code, Bezeichner und Kommentare auf Englisch; UI-Texte über `_locales` (de, en).

## Befehle

- `npm run build`: bündelt `extension/` mit esbuild nach `dist/`.
- `npm run check`: Build, Typprüfung (`tsc`), ESLint, `web-ext lint` auf `dist/` und Tests.
- `npm run start`: baut und startet Thunderbird mit `dist/` als temporärem Add-on, im eigenen
  Testprofil `.tb-dev-profile/` (nicht versioniert, bleibt erhalten, nie das echte Profil);
  web-ext lädt das Add-on bei Änderungen in `dist/` neu, ein Rebuild muss aber separat laufen.
  Die Konfiguration steht in `web-ext-config.mjs`.

## Umgebung

- macOS, Node 22, Thunderbird 160 unter `/Applications/Thunderbird.app`.
- Die Claude-Code-CLI (`claude`) war beim Anlegen des Projekts **nicht installiert**. Sie ist
  Voraussetzung für Phase 2; vor Beginn prüfen und sonst den Nutzer bitten, sie zu installieren
  und sich einzuloggen.
