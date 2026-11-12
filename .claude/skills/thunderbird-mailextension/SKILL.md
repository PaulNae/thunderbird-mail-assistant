---
name: thunderbird-mailextension
description: Regeln und Nachschlagewege für Thunderbird-MailExtensions (Manifest V3) - compose, messages, messageDisplay, Native Messaging, Review-Anforderungen. Laden, bevor Code geschrieben oder geprüft wird, der eine messenger.*-API, das Manifest oder den Native-Messaging-Host berührt.
---

# Thunderbird-MailExtensions

Thunderbird ist kein Firefox. Viele APIs heißen ähnlich, verhalten sich aber anders, und sie
ändern sich zwischen Versionen. Dieser Skill enthält Orientierung; **verbindlich ist nur die
offizielle Doku**. Schlage jede API vor der Verwendung dort nach und halte dich an das, was dort
für die Zielversion steht, auch wenn es von dieser Datei abweicht. Korrigiere diese Datei dann.

## Quellen

- API-Referenz MV3: https://webextension-api.thunderbird.net/en/mv3/
- Entwicklerhandbuch: https://developer.thunderbird.net/add-ons/mailextensions
- Beispiele: https://github.com/thunderbird/webext-examples
- Native Messaging (Format und Manifest-Pfade; Thunderbird-Abweichungen im Entwicklerhandbuch prüfen):
  https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging
- Review-Regeln: https://thunderbird.github.io/atn-review-policy/

## Grundlagen

- Namespace `messenger.*` (Promise-basiert).
- Manifest V3: Hintergrund als `background.scripts` mit `"type": "module"`, kein Service Worker.
  Das Hintergrundskript kann beendet werden; Zustand nicht in Modulvariablen halten, Listener
  auf oberster Ebene registrieren.
- Add-on-ID unter `browser_specific_settings.gecko.id`; sie muss mit `allowed_extensions` im
  Host-Manifest übereinstimmen.
- UI-Einstiegspunkte: `compose_action` (Verfassen-Fenster), `message_display_action`
  (Mailansicht), `action` (Hauptfenster), `options_ui`.
- Berechtigungen, die dieses Projekt voraussichtlich braucht: `compose`, `messagesRead`,
  `accountsRead`, `nativeMessaging`, `storage`. Nur anfordern, was tatsächlich benutzt wird.

## Stolperstellen, die hier relevant sind

**Verfassen**
- Inhalt lesen und setzen über `compose.getComposeDetails` / `compose.setComposeDetails`.
  `isPlainText` entscheidet, ob `body` (HTML) oder `plainTextBody` gilt; nie beide setzen.
- `setComposeDetails` ersetzt den ganzen Text. Für "nur die Markierung ersetzen" braucht es ein
  Skript im Editor-Dokument des Verfassen-Fensters. Wie man es in MV3 einschleust
  (`scripting`-API für Compose-Tabs), in der Doku nachschlagen.
- Zitate (`blockquote[type=cite]`) und Signatur (`.moz-signature` bzw. `-- ` im Nur-Text) erkennen
  und unangetastet lassen.
- Das Popup der `compose_action` bekommt die Tab-ID des Verfassen-Fensters über `tabs.query`
  bzw. den Klick-Kontext; nicht annehmen, dass der aktive Tab ein Mail-Tab ist.

**Lesen**
- Angezeigte Mail über `messageDisplay`; in MV3 liefern die Funktionen Listen, weil mehrere
  Mails gewählt sein können.
- Text einer Mail: bevorzugt die API, die die Textteile direkt liefert, statt den MIME-Baum von
  `messages.getFull` selbst zu durchlaufen. Verfügbarkeit je Version prüfen.
- `messages.query` und `messages.list` liefern Seiten; mit `messages.continueList` weiterlesen
  und früh abbrechen, wenn die Obergrenze erreicht ist.
- Thread-Zusammenhang gibt es nicht als fertige API für alle Fälle; über `headerMessageId`,
  `References` und Betreff annähern.

**Native Messaging**
- Rahmen: 4 Byte Länge (native Byte-Reihenfolge) plus UTF-8-JSON, über stdin und stdout.
  stdout gehört ausschließlich dem Protokoll; Diagnose nur nach stderr.
- Host → Add-on höchstens 1 MB pro Nachricht, daher Antworten in Stücken senden.
- Host-Manifest: `name`, `description`, `path` (absolut), `type: "stdio"`, `allowed_extensions`.
  Den Ablageort für Thunderbird auf macOS in der Doku prüfen und durch einen echten
  Verbindungsversuch bestätigen; er ist nicht zwingend derselbe wie bei Firefox.
- `connectNative` für Streaming (Port bleibt offen), `sendNativeMessage` nur für Einzelabfragen.
- Thunderbird startet den Host mit minimaler Umgebung: kein Shell-PATH, anderes
  Arbeitsverzeichnis. Alle Pfade absolut.

**Review auf addons.thunderbird.net**
- Kein nachgeladener oder minifizierter, nicht nachvollziehbarer Code; bei gebündeltem Code
  Quellen und Build-Anleitung mitliefern.
- Datenweitergabe an Dritte braucht ausdrückliche Zustimmung des Nutzers und eine
  Datenschutzerklärung.

## Entwickeln und Testen

- Temporär laden: Add-ons-Verwaltung → Zahnrad → "Add-ons debuggen" → "Temporäres Add-on laden",
  oder `web-ext run` mit Thunderbird als Ziel-Binary (`/Applications/Thunderbird.app/Contents/MacOS/thunderbird`).
  Für Tests ein eigenes Profil verwenden, nie das echte des Nutzers.
- `web-ext lint` kennt nicht alle Thunderbird-Schlüssel; Warnungen zu `compose_action` usw.
  gegen die Doku prüfen, nicht blind beheben.
- Logik (Prompt-Bau, HTML-zu-Text, Protokoll, Host) so schneiden, dass sie ohne Thunderbird in
  Node testbar ist; `messenger.*` nur an den Rändern.
