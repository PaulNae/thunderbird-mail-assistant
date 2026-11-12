# Mail Assistant for Thunderbird

A Thunderbird add-on that brings an AI assistant to your mail: rewrite text in the compose window,
summarize a message or thread, ask questions about it, and ask questions across your mailbox.

The add-on does not talk to a model itself. It hands each request to the copy of
[Claude Code](https://code.claude.com/docs) installed on your computer, so requests run under your
own Anthropic account. **This is an independent project. It is not made, endorsed or supported by
Anthropic.**

Status: version 0.6.0. macOS only, and only with a locally installed Claude Code. The user interface
is available in English and German. The specification ([SPEC.md](SPEC.md)) and the development rules
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
- **Where it goes:** to Anthropic, through your local Claude Code and under your own account. What
  Anthropic does with it (retention, use for model training, which you can switch off in your
  account settings) is governed by your agreement with Anthropic and its
  [privacy policy](https://www.anthropic.com/legal/privacy).
- **What the author of this add-on receives:** nothing. There is no server, no telemetry and no
  analytics.
- **What is stored:** your settings and your consent, locally in Thunderbird. Mail content and
  results are kept in memory only and are discarded when you display another message, close the tab
  or window, or quit Thunderbird. Nothing of it is written to disk or to logs by the add-on.
- **Other people's data:** mail contains personal data of the people you correspond with. Whether
  you may pass it to Anthropic, especially at work, is for you to decide.

Message content is passed to the model as clearly delimited data, not as instructions, and the model
gets no tools. A message can therefore not make the assistant do anything beyond producing text.

## Anthropic terms

You need your own Claude Code installation and you sign in to it yourself. The add-on never sees or
handles your credentials; it only starts the unmodified `claude` command. Your use is subject to
[Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance), and it is your
responsibility to comply with them. Two points worth knowing:

- Requests count against the usage limits of your plan.
- Anthropic's consumer terms (Free, Pro, Max) cover personal, non-commercial use. For business mail,
  check which terms apply to your account.

Anthropic may change its terms or how it enforces them. If this way of using Claude Code stops being
permitted, the add-on will stop working until it is adapted.

## Requirements

- macOS
- Thunderbird 128 or newer (developed and tested with Thunderbird 160)
- Node 22
- Claude Code (`claude`), installed and signed in

`strict_min_version` is `128.0`: Manifest V3 for MailExtensions is officially supported from
Thunderbird 128 ESR on (https://webextension-api.thunderbird.net/en/mv3/).

## Install

1. Build: `npm install`, then `npm run package`. This runs all checks and writes
   `web-ext-artifacts/mail-assistant-0.6.0.xpi`. A prebuilt `.xpi` is attached to each
   [release](https://github.com/PaulNae/thunderbird-mail-assistant/releases); you still need this
   repository for step 2.
2. Install the helper: `npm run host:install` (see below).
3. In Thunderbird: Tools → Add-ons and Themes → gear icon → "Install Add-on From File…" → choose
   the `.xpi` and confirm. Thunderbird does not require a signature (see below), and the add-on
   stays installed after a restart.
4. The buttons appear in the compose window, in the message view, and as "Ask mailbox" in the
   toolbar of the main window (if it is not visible: right-click the toolbar → Customize).

Settings are under Add-ons and Themes → Mail Assistant → Preferences: the model for each task, the
limits (messages per mailbox question, amount of text, time limit), a connection test for the
helper, and your consent.

**Update:** build the new `.xpi` and install it the same way. After changes to `host/host.mjs`, run
`npm run host:install` again. There are no automatic updates.

**Remove:** Add-ons and Themes → Mail Assistant → "…" → Remove, then delete the helper with
`npm run host:install -- --uninstall`.

**Signature:** Thunderbird is built without mandatory add-on signing
(`imply_option("MOZ_REQUIRE_SIGNING", False)` in
[`mail/moz.configure`](https://searchfox.org/comm-central/source/mail/moz.configure)), so an
unsigned `.xpi` can be installed permanently.

### The helper (native messaging host)

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

## License

[MIT](LICENSE)
