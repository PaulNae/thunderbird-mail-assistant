// Chat tab for mailbox queries. The background script runs the queries and holds the conversation
// (memory only, bound to this tab's port); this page renders snapshots. Model text is only ever set via
// textContent; citations become buttons that open the mail.
import { localizeDocument } from "../shared/i18n.ts";
import { errorMessage } from "../shared/errors.ts";
import { BackendError } from "../backend/backend.ts";
import { openPort } from "../shared/job-client.ts";
import type { JobPort } from "../shared/job-client.ts";
import { PORT_CHAT, SETTING_MAX_MESSAGES, parseChatEvent, sanitizeMaxMessages } from "../shared/chat-messages.ts";
import type { ChatEvent, ChatSearchInfo, ChatSnapshot, ChatSource, ChatTurn } from "../shared/chat-messages.ts";
import { splitAnswer } from "../prompts/query.ts";
import type { SearchField } from "../prompts/query.ts";
import { MAX_QUESTION_CHARS } from "../prompts/read.ts";
import { isSubmitKey } from "../display/popup-state.ts";

localizeDocument();

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const logEl = $<HTMLOListElement>("log");
const statusEl = $("status");
const questionEl = $<HTMLInputElement>("question");
const askBtn = $<HTMLButtonElement>("ask");
const cancelBtn = $<HTMLButtonElement>("cancel");
const clearBtn = $<HTMLButtonElement>("clear");
const maxEl = $<HTMLInputElement>("max-messages");

const t = (key: string, subs?: string[]): string => messenger.i18n.getMessage(key, subs);

let port: JobPort | null = null;
let connecting: Promise<JobPort | null> | null = null;
let snapshot: ChatSnapshot = { turns: [] };
// The answer element and text of the running turn, updated by deltas.
let liveAnswer: HTMLElement | null = null;
let liveText = "";
let liveSources: ChatSource[] = [];

const running = (): boolean => snapshot.turns.some((x) => x.status === "running");

function renderControls(): void {
  const busy = running();
  askBtn.disabled = busy || questionEl.value.trim() === "";
  cancelBtn.hidden = !busy;
  clearBtn.disabled = snapshot.turns.length === 0;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (iso === "" || Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(messenger.i18n.getUILanguage(), { year: "numeric", month: "short", day: "numeric" });
}

async function openMail(source: ChatSource): Promise<void> {
  statusEl.textContent = "";
  try {
    await messenger.messageDisplay.open({ messageId: source.messageId, location: "tab", active: true });
  } catch {
    statusEl.textContent = t("chatOpenFailed");
  }
}

function sourceLabel(s: ChatSource): string {
  return [s.from, s.subject || t("chatNoSubject"), formatDate(s.date)].filter((x) => x !== "").join(" – ");
}

/** Fills `el` with the answer: text nodes and, for valid citations, buttons that open the mail. */
function renderAnswer(el: HTMLElement, text: string, sources: readonly ChatSource[]): void {
  el.replaceChildren();
  for (const seg of splitAnswer(text, sources.length)) {
    if (seg.kind === "text") {
      el.append(document.createTextNode(seg.text));
      continue;
    }
    const src = sources[seg.index - 1];
    if (!src) {
      el.append(document.createTextNode(`[${seg.index}]`));
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ref";
    b.textContent = `[${seg.index}]`;
    b.title = sourceLabel(src);
    b.setAttribute("aria-label", t("chatOpenMail", [String(seg.index), src.subject || t("chatNoSubject")]));
    b.addEventListener("click", () => void openMail(src));
    el.append(b);
  }
}

const FIELD_KEYS: Record<SearchField, string> = {
  text: "chatFieldText",
  from: "chatFieldFrom",
  to: "chatFieldTo",
  subject: "chatFieldSubject",
  after: "chatFieldAfter",
  before: "chatFieldBefore",
};

function describeSearch(info: ChatSearchInfo): string {
  const queries = info.queries.map((q) =>
    (Object.keys(FIELD_KEYS) as SearchField[])
      .filter((k) => q[k] !== undefined)
      .map((k) => `${t(FIELD_KEYS[k])} ${t("chatQuoted", [q[k] ?? ""])}`)
      .join(", "),
  );
  let text = t("chatSearchUsed", [queries.join(` ${t("chatOr")} `)]);
  if (info.source === "fallback") text += " " + t("chatSearchFallback");
  if (info.relaxed) text += " " + t("chatSearchRelaxed");
  return text;
}

function stageText(turn: ChatTurn): string {
  switch (turn.stage) {
    case "params":
      return t("chatStageParams");
    case "search":
      return t("chatStageSearch");
    case "load":
      return t("chatStageLoad");
    default:
      return t("chatStageAnswer");
  }
}

function p(className: string, text: string): HTMLParagraphElement {
  const el = document.createElement("p");
  el.className = className;
  el.textContent = text;
  return el;
}

function renderTurn(turn: ChatTurn, live: boolean): HTMLLIElement {
  const li = document.createElement("li");
  li.append(p("question", turn.question));
  if (turn.search) li.append(p("meta", describeSearch(turn.search)));
  if (turn.status === "running") li.append(p("status", stageText(turn)));

  const answer = document.createElement("div");
  answer.className = "answer";
  answer.tabIndex = 0;
  if (turn.status === "done" || turn.status === "running") {
    renderAnswer(answer, live ? liveText : turn.answer, turn.sources);
    li.append(answer);
  } else if (turn.status === "no_results") {
    li.append(p("answer", t("chatNoResults")));
  } else if (turn.status === "error") {
    const msg =
      turn.error === "search_failed" ? t("chatSearchFailed") : turn.error === "empty_result" ? t("composeEmptyResult") : errorMessage(new BackendError(turn.error ?? "internal"));
    li.append(p("answer", msg));
  } else if (turn.status === "cancelled") {
    li.append(p("answer", errorMessage(new BackendError("cancelled"))));
  }
  if (live) liveAnswer = answer;

  if (turn.sent > 0) {
    const counts = turn.foundComplete ? t("chatSent", [String(turn.sent), String(turn.found)]) : t("chatSentMore", [String(turn.sent), String(turn.found)]);
    li.append(p("meta", turn.truncated ? `${counts} ${t("chatTruncated")}` : counts));
  }
  if (turn.sources.length > 0 && turn.status !== "error" && turn.status !== "cancelled") {
    const heading = document.createElement("h2");
    heading.textContent = t("chatSources");
    const list = document.createElement("ol");
    list.className = "sources";
    for (const s of turn.sources) {
      const item = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "source";
      b.textContent = sourceLabel(s);
      b.addEventListener("click", () => void openMail(s));
      item.append(b);
      list.append(item);
    }
    li.append(heading, list);
  }
  return li;
}

function render(): void {
  liveAnswer = null;
  const items = snapshot.turns.map((turn, i) => renderTurn(turn, turn.status === "running" && i === snapshot.turns.length - 1));
  logEl.replaceChildren(...items);
  renderControls();
}

function onEvent(event: ChatEvent): void {
  if (event.type === "snapshot") {
    const before = running();
    snapshot = event.snapshot;
    const last = snapshot.turns[snapshot.turns.length - 1];
    if (last?.status === "running") {
      liveText = last.answer;
      liveSources = last.sources;
    } else {
      liveText = "";
      liveSources = [];
    }
    render();
    if (before && !running()) questionEl.focus();
    return;
  }
  if (!liveAnswer) return;
  liveText += event.text;
  renderAnswer(liveAnswer, liveText, liveSources);
}

function connect(): Promise<JobPort | null> {
  if (port) return Promise.resolve(port);
  if (connecting) return connecting;
  connecting = openPort(PORT_CHAT, parseChatEvent, onEvent, () => {
    port = null;
    // The background script went away: the conversation it held is lost.
    if (snapshot.turns.length > 0) statusEl.textContent = t("chatDisconnected");
    snapshot = { turns: [] };
    render();
  })
    .then((p) => (port = p))
    .catch(() => null)
    .finally(() => {
      connecting = null;
    });
  return connecting;
}

async function ask(): Promise<void> {
  const question = questionEl.value.trim();
  if (question === "" || running()) return;
  if (question.length > MAX_QUESTION_CHARS) {
    statusEl.textContent = t("displayQuestionTooLong", [String(MAX_QUESTION_CHARS)]);
    return;
  }
  statusEl.textContent = "";
  const p = await connect();
  if (!p?.post({ type: "ask", question })) {
    statusEl.textContent = t("errorInternal");
    return;
  }
  questionEl.value = "";
  renderControls();
}

async function loadSetting(): Promise<void> {
  try {
    maxEl.value = String(sanitizeMaxMessages((await messenger.storage.local.get(SETTING_MAX_MESSAGES))[SETTING_MAX_MESSAGES]));
  } catch {
    maxEl.value = String(sanitizeMaxMessages(undefined));
  }
}

async function saveSetting(): Promise<void> {
  const value = sanitizeMaxMessages(maxEl.value);
  maxEl.value = String(value);
  try {
    await messenger.storage.local.set({ [SETTING_MAX_MESSAGES]: value });
  } catch {
    statusEl.textContent = t("errorInternal");
  }
}

askBtn.addEventListener("click", () => void ask());
questionEl.addEventListener("input", renderControls);
questionEl.addEventListener("keydown", (ev) => {
  if (isSubmitKey(ev)) {
    ev.preventDefault();
    void ask();
  }
});
cancelBtn.addEventListener("click", () => port?.post({ type: "cancel" }));
clearBtn.addEventListener("click", () => {
  statusEl.textContent = "";
  port?.post({ type: "clear" });
});
maxEl.addEventListener("change", () => void saveSetting());

render();
void loadSetting();
void connect();
questionEl.focus();
