import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat, type AnchorsEvent, type AnswerStats, type ChatEvent, type Citation } from "../api.js";
import { useAppState } from "../state.js";
import { Composer } from "./Composer.js";
import { AssistantMessage, UserMessage } from "./Message.js";

export type Segment = { kind: "text"; text: string } | { kind: "citation"; citation: Citation };

export interface UserMsg {
  id: number;
  role: "user";
  content: string;
}

export interface AssistantMsg {
  id: number;
  role: "assistant";
  segments: Segment[];
  anchors: AnchorsEvent | null;
  status: "streaming" | "done" | "error";
  error: string | null;
  stats: AnswerStats | null;
  /** The question this answered, for retry. */
  question: string;
}

export type ChatMessage = UserMsg | AssistantMsg;

export const messageText = (m: AssistantMsg): string =>
  m.segments.map((s) => (s.kind === "text" ? s.text : "")).join("");

const EXAMPLES = [
  "Where is the Giant Rat Ashes and how do I get it?",
  "What does the Godskin Apostle drop in Dominula?",
  "Which enemies are in Miquella's Haligtree?",
  "How much HP do bosses have with 2 allies in co-op?",
];

export function ChatPane({ onShowBook }: { onShowBook: () => void }) {
  const { book, books, scope, setScope, goTo } = useAppState();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const listRef = useRef<HTMLDivElement>(null);

  // keep the newest content in view while streaming
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const updateAssistant = useCallback((id: number, fn: (m: AssistantMsg) => AssistantMsg) => {
    setMessages((ms) => ms.map((m) => (m.id === id && m.role === "assistant" ? fn(m) : m)));
  }, []);

  const send = useCallback(
    async (question: string, history: ChatMessage[]) => {
      const userId = nextId.current++;
      const assistantId = nextId.current++;
      const assistant: AssistantMsg = { id: assistantId, role: "assistant", segments: [], anchors: null, status: "streaming", error: null, stats: null, question };
      setMessages([...history, { id: userId, role: "user", content: question }, assistant]);
      setBusy(true);

      // entities from the previous answer let "how do I get there?" resolve "there"
      const lastAnswer = [...history].reverse().find((m): m is AssistantMsg => m.role === "assistant" && m.anchors !== null);
      const priorEntities = lastAnswer?.anchors?.entities.map((e) => e.nameNorm);

      const apiMessages = history
        .map((m) => (m.role === "user" ? { role: m.role, content: m.content } : { role: m.role, content: messageText(m) }))
        .filter((m) => m.content.trim() !== "");
      apiMessages.push({ role: "user", content: question });

      const controller = new AbortController();
      abortRef.current = controller;
      let gotDone = false;
      try {
        // scope "all" omits bookIds: the API then retrieves across every indexed book
        const body = {
          messages: apiMessages,
          ...(scope === "book" ? { bookIds: [book.id] } : {}),
          ...(priorEntities && priorEntities.length ? { priorEntities } : {}),
        };
        for await (const ev of streamChat(body, controller.signal)) {
          applyEvent(ev, assistantId, updateAssistant);
          if (ev.type === "done") gotDone = true;
          if (ev.type === "error") gotDone = true; // server reported; not a transport failure
        }
        if (!gotDone) {
          updateAssistant(assistantId, (m) => ({ ...m, status: "error", error: "The connection closed before the answer finished." }));
        }
      } catch (err) {
        if (controller.signal.aborted) {
          updateAssistant(assistantId, (m) => ({ ...m, status: "done", error: m.segments.length ? null : "Stopped." }));
        } else {
          const message = err instanceof Error ? err.message : String(err);
          updateAssistant(assistantId, (m) => ({ ...m, status: "error", error: "Lost the connection to the server: " + message }));
        }
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [book.id, scope, updateAssistant],
  );

  const onSend = useCallback((text: string) => void send(text, messages), [send, messages]);
  const onStop = useCallback(() => abortRef.current?.abort(), []);
  const onRetry = useCallback(
    (m: AssistantMsg) => {
      const idx = messages.findIndex((x) => x.id === m.id);
      // drop the failed answer and its question, then ask again
      const history = messages.slice(0, Math.max(idx - 1, 0));
      void send(m.question, history);
    },
    [messages, send],
  );

  const jump = useCallback(
    (bookId: string, page: number, quote?: string | null) => {
      goTo(bookId, page, quote ?? null);
      onShowBook();
    },
    [goTo, onShowBook],
  );

  return (
    <section className="chat" aria-label="Chat">
      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty-hint">
            <p>
              Ask about the indexed pages of {scope === "book" || books.length === 1 ? book.title : "all " + books.length + " books"}. Every claim in an
              answer carries a page citation; click one to open that page.
            </p>
            <ul>
              {EXAMPLES.map((q) => (
                <li key={q} onClick={() => onSend(q)}>
                  {q}
                </li>
              ))}
            </ul>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? <UserMessage key={m.id} message={m} /> : <AssistantMessage key={m.id} message={m} onJump={jump} onRetry={onRetry} />,
        )}
      </div>
      <Composer
        disabled={busy}
        bookId={scope === "book" ? book.id : undefined}
        scope={books.length > 1 ? { value: scope, bookLabel: book.label, onChange: setScope } : null}
        onSend={onSend}
        onStop={busy ? onStop : null}
      />
    </section>
  );
}

function applyEvent(ev: ChatEvent, id: number, update: (id: number, fn: (m: AssistantMsg) => AssistantMsg) => void): void {
  switch (ev.type) {
    case "anchors":
      update(id, (m) => ({ ...m, anchors: ev }));
      break;
    case "text":
      update(id, (m) => {
        const last = m.segments[m.segments.length - 1];
        if (last && last.kind === "text") {
          return { ...m, segments: [...m.segments.slice(0, -1), { kind: "text", text: last.text + ev.text }] };
        }
        return { ...m, segments: [...m.segments, { kind: "text", text: ev.text }] };
      });
      break;
    case "citation":
      update(id, (m) => ({ ...m, segments: [...m.segments, { kind: "citation", citation: ev.citation }] }));
      break;
    case "done":
      update(id, (m) => ({ ...m, status: "done", stats: ev.stats }));
      break;
    case "error":
      update(id, (m) => ({ ...m, status: "error", error: ev.message }));
      break;
  }
}
