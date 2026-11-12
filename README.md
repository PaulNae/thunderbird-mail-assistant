# Mail Assistant for Thunderbird

A Thunderbird add-on that brings an AI assistant to your mail: rewrite text in the compose window,
summarize a message or thread, ask questions about it, and ask questions across your mailbox.

The add-on reaches Claude in one of two ways, chosen in its settings:

- **API key (default):** requests go directly to Anthropic's API under your own API key, billed by
  usage to your API account. Works on every system Thunderbird runs on.
- **Claude subscription via Claude Code (macOS only):** requests go to the copy of
  [Claude Code](https://code.claude.com/docs) installed on your Mac, through a small helper from this
  repository, and run under your Claude subscription. For private use only (see below).

**This is an independent project. It is not made, endorsed or supported by Anthropic.**

Status: version 0.7.0. The user interface is available in English and German and includes a setup
guide (it opens after a new installation and from the settings). The specification ([SPEC.md](SPEC.md)) and the development rules
([CLAUDE.md](CLAUDE.md)) are written in German.

## What it does

- **Compose window:** rewrite, shorten, change the tone of or translate the selected text (or the
  whole message), or draft a message from an instruction. Quoted text and the signature are left
  alone.
- **Message view:** summarize the displayed message or thread, ask questions about it, draft a reply.
- **Mailbox:** ask a question in a separate tab; the add-on searches your mail and answers from the
  messages it found.

Nothing happens without a click, and the add-on never sends, deletes or moves a message.

## Privacy

Read this before you use the add-on with a real mailbox.

- **What leaves your computer:** the text you selected, the message or thread on display, or, for a
  mailbox question, up to 15 messages found by the search (configurable up to 50).
- **When:** only when you trigger an action, and only after you agreed in the consent dialog shown
  before the first action. You can withdraw consent in the settings at any time.
- **Where it goes:** to Anthropic, depending on the setting either directly to Anthropic's API
  (`api.anthropic.com`, encrypted) under your API key, or through your local Claude Code under your
  Claude account. What Anthropic does with it (retention, use for model training) is governed by your
  agreement with Anthropic and its [privacy policy](https://www.anthropic.com/legal/privacy).
- **What the author of this add-on receives:** nothing. There is no server, no telemetry and no
  analytics.
- **What is stored:** your settings, your consent and, if you use the API backend, your API key,
  locally in your Thunderbird profile (the key unencrypted, as all add-on storage; it is never shown
  again, never logged and sent only to `api.anthropic.com`). Mail content and
  results are kept in memory only and are discarded when you display another message, close the tab
  or window, or quit Thunderbird. Nothing of it is written to disk or to logs by the add-on.
- **Other people's data:** mail contains personal data of the people you correspond with. Whether
  you may pass it to Anthropic, especially at work, is for you to decide.

Message content is passed to the model as clearly delimited data, not as instructions, and the model
gets no tools. A message can therefore not make the assistant do anything beyond producing text.

## Anthropic terms

You need your own account with Anthropic for either backend. The add-on never sees or handles your
Claude login; with the subscription backend it only starts the unmodified `claude` command you signed
in to yourself, with the API backend it sends the API key you entered. Your use is subject to
[Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance), and it is your
responsibility to comply with them.

- **API key:** an API account in the [Claude Console](https://platform.claude.com/settings/keys) is
  separate from a Claude subscription and is billed by usage. Use this for business mail.
- **Subscription (Free, Pro, Max):** according to Anthropic's Consumer Terms it is for private,
  non-commercial use only. Requests count against the usage limits of your plan.

Anthropic's terms were last checked on 2026-11-12. Anthropic can change them; if using the
subscription through Claude Code in this way is no longer allowed, that option must no longer be
used. Anthropic's current terms apply, not this notice.

**No warranty:** the add-on is provided as is under the [MIT License](LICENSE). The model's answers
can be wrong; check them before you send anything. You are responsible for complying with
Anthropic's terms and for what mail content you pass on.

## Requirements

- Thunderbird 128 or newer (developed and tested with Thunderbird 160)
- API backend: an Anthropic API key
- Subscription backend: macOS, Node 22, Claude Code (`claude`) installed and signed in

`strict_min_version` is `128.0`: Manifest V3 for MailExtensions is officially supported from
Thunderbird 128 ESR on (https://webextension-api.thunderbird.net/en/mv3/).

## Install

1. Build: `npm install`, then `npm run package`. This runs all checks and writes
   `web-ext-artifacts/mail-assistant-0.7.0.xpi`. A prebuilt `.xpi` is attached to each
   [release](https://github.com/PaulNae/thunderbird-mail-assistant/releases).
2. Only for the subscription backend: install the helper with `npm run host:install` (see below).
3. In Thunderbird: Tools → Add-ons and Themes → gear icon → "Install Add-on From File…" → choose
   the `.xpi` and confirm. Thunderbird does not require a signature (see below), and the add-on
   stays installed after a restart.
4. The setup guide opens. For the API backend, create a key in the Claude Console and enter it in
   the settings; for the subscription backend, choose it in the settings. Then run the connection
   test.
5. The buttons appear in the compose window, in the message view, and as "Ask mailbox" in the
   toolbar of the main window (if it is not visible: right-click the toolbar → Customize).

Settings are under Add-ons and Themes → Mail Assistant → Preferences: the backend and the API key,
the model for each task, the limits (messages per mailbox question, amount of text, time limit), a
connection test, and your consent.

**Update:** build the new `.xpi` and install it the same way. After changes to `host/host.mjs`, run
`npm run host:install` again. There are no automatic updates. An installation of 0.6.0 or older keeps
using Claude Code after the update to 0.7.0; the consent dialog asks once more because its text now
covers both backends and the liability notice.

**Remove:** Add-ons and Themes → Mail Assistant → "…" → Remove, then delete the helper with
`npm run host:install -- --uninstall`.

**Signature:** Thunderbird is built without mandatory add-on signing
(`imply_option("MOZ_REQUIRE_SIGNING", False)` in
[`mail/moz.configure`](https://searchfox.org/comm-central/source/mail/moz.configure)), so an
unsigned `.xpi` can be installed permanently.

### The helper (native messaging host, subscription backend only)

```sh
npm run host:install
```

Thunderbird starts a small helper program on demand, which in turn runs `claude`. The script
registers it as native messaging host `mail_assistant` for the current user:

- `~/Library/Application Support/mail-assistant/host.mjs`: a **copy** of `host/host.mjs`
  (Thunderbird should not execute files from `~/Documents`, otherwise macOS asks for access).
- `~/Library/Application Support/mail-assistant/launcher.sh`: start script with absolute paths to
  `node` and `claude`, because Thunderbird starts the helper without your shell's `PATH`.
- `~/Library/Mozilla/NativeMessagingHosts/mail_assistant.json`: the manifest pointing to the
  launcher, restricted to this add-on's ID.

`claude` is looked up through your login shell, `~/.local/bin`, `/opt/homebrew/bin` and
`/usr/local/bin`; `--claude <path>` sets the path explicitly and `--install-dir <dir>` changes the
installation directory. Run the script again whenever `host.mjs` changes or you switch `node` or
`claude`. `--print` only shows what would be written.

## Development

```sh
npm install
npm run check   # build, type check, lint, web-ext lint, tests
npm run start   # builds and starts Thunderbird with the add-on
```

`npm run start` uses its own test profile in `.tb-dev-profile/` (not in Git), never your real
Thunderbird profile. On first start that profile has no account. Without a real account you can
still try the add-on:

- Message view: File → Open → Saved Message… → `test/fixtures/hello.eml` (do not double-click it in
  Finder, that opens your regular Thunderbird).
- Compose: create a newsgroup account with made-up values (for example server
  `news.example.invalid`); it needs no server connection but provides a sender identity.

The helper installed by `npm run host:install` serves all Thunderbird profiles, including the test
profile.

## Bugs and feature requests

Please report bugs and suggest features as
[GitHub issues](https://github.com/PaulNae/thunderbird-mail-assistant/issues). Do not paste mail
content or your API key into an issue.

## License

[MIT](LICENSE)
