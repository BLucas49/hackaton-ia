import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./ChatBox.scss";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
};

const MODEL = "techcorp-chatbox";
const STORAGE_KEY = "techcorp-conversations";

type Lang = "fr" | "en";

const LANG_PRIMER: Record<Lang, { role: "user" | "assistant"; content: string }[] | null> = {
  fr: [
    { role: "user", content: "Pour toute cette conversation, réponds uniquement en français." },
    { role: "assistant", content: "Bien sûr, je répondrai en français pour toute cette conversation." },
  ],
  en: null,
};

const generateId = () => Math.random().toString(36).slice(2, 10);

const loadConversations = (): Conversation[] => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
};

const saveConversations = (convs: Conversation[]) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(convs));
};

const newConversation = (): Conversation => ({
  id: generateId(),
  title: "Nouvelle conversation",
  createdAt: Date.now(),
  messages: [],
});

const ChatBox = () => {
  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const saved = loadConversations();
    return saved.length > 0 ? saved : [newConversation()];
  });
  const [activeId, setActiveId] = useState<string>(
    () => loadConversations()[0]?.id ?? conversations[0]?.id,
  );
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [modelStatus, setModelStatus] = useState<"checking" | "available" | "unavailable">("checking");
  const [lang, setLang] = useState<Lang>("fr");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const active = conversations.find((c) => c.id === activeId) ?? conversations[0];

  useEffect(() => {
    fetch("/api/ollama/api/tags")
      .then((res) => res.json())
      .then((data) => {
        const models: { name: string }[] = data.models ?? [];
        const found = models.some((m) => m.name === MODEL || m.name.startsWith(MODEL + ":"));
        setModelStatus(found ? "available" : "unavailable");
      })
      .catch(() => setModelStatus("unavailable"));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages]);

  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  const updateConversation = (id: string, updater: (c: Conversation) => Conversation) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? updater(c) : c)));
  };

  const appendToAssistant = (chunk: string, convId: string, history: Message[]) => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        const last = c.messages.at(-1);
        if (last?.role === "assistant") {
          return {
            ...c,
            messages: [
              ...c.messages.slice(0, -1),
              { role: "assistant", content: last.content + chunk },
            ],
          };
        }
        return { ...c, messages: [...history, { role: "assistant", content: chunk }] };
      }),
    );
  };

  const processStream = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    convId: string,
    history: Message[],
  ) => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split("\n").filter(Boolean)) {
        try {
          const data = JSON.parse(line);
          if (data.message?.content) appendToAssistant(data.message.content, convId, history);
        } catch {
          // ignore malformed JSON lines
        }
      }
    }
  };

  const sendMessage = async () => {
    const content = input.trim();
    if (!content || loading || !active) return;

    const userMessage: Message = { role: "user", content };
    const history = [...active.messages, userMessage];
    const convId = active.id;

    const isFirstMessage = active.messages.length === 0;
    const truncated = content.length > 40 ? content.slice(0, 40) + "…" : content;
    const title = isFirstMessage ? truncated : active.title;

    updateConversation(convId, (c) => ({ ...c, messages: history, title }));
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/ollama/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [...(LANG_PRIMER[lang] ?? []), ...history],
          stream: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await processStream(response.body!.getReader(), convId, history);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                messages: [
                  ...c.messages,
                  {
                    role: "assistant",
                    content: `Erreur : ${err instanceof Error ? err.message : "Impossible de joindre Ollama"}`,
                  },
                ],
              }
            : c,
        ),
      );
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  };

  const stopGeneration = () => {
    abortRef.current?.abort();
  };

  const createConversation = () => {
    const conv = newConversation();
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    setInput("");
  };

  const deleteConversation = (id: string) => {
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (next.length === 0) {
        const fresh = newConversation();
        setActiveId(fresh.id);
        return [fresh];
      }
      if (activeId === id) setActiveId(next[0].id);
      return next;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  };

  const isWaiting =
    loading &&
    active &&
    (active.messages.length === 0 || active.messages.at(-1)!.role === "user");

  return (
    <div className="app-layout">
      <aside className={`sidebar ${sidebarOpen ? "sidebar--open" : "sidebar--closed"}`}>
        <div className="sidebar-header">
          {sidebarOpen && <span className="sidebar-title">Conversations</span>}
          <button className="sidebar-toggle" onClick={() => setSidebarOpen((v) => !v)} title="Réduire">
            {sidebarOpen ? "‹" : "›"}
          </button>
        </div>
        {sidebarOpen && (
          <>
            <button
              className="new-conv-btn"
              onClick={createConversation}
              disabled={loading}
              title={loading ? "Une réponse est en cours…" : undefined}
            >
              + Nouvelle conversation
            </button>
            <ul className="conv-list">
              {conversations.map((c) => {
                const isActive = c.id === activeId;
                const isBlocked = loading && !isActive;
                return (
                <li
                  key={c.id}
                  className={`conv-item ${isActive ? "conv-item--active" : ""} ${isBlocked ? "conv-item--blocked" : ""}`}
                  title={isBlocked ? "Une réponse est en cours…" : undefined}
                >
                  <button
                    className="conv-select"
                    onClick={() => setActiveId(c.id)}
                    disabled={isBlocked}
                  >
                    {isActive && loading && <span className="conv-generating" />}
                    {c.title}
                  </button>
                  {conversations.length > 1 && (
                    <button
                      className="conv-delete"
                      onClick={() => deleteConversation(c.id)}
                      disabled={isBlocked}
                      title={isBlocked ? undefined : "Supprimer"}
                    >
                      ×
                    </button>
                  )}
                </li>
              );
              })}
            </ul>
          </>
        )}
      </aside>

      <main className="chatbox">
        <header className="chatbox-header">
          <h1>TechCorp Assistant</h1>
          <button
            className="lang-toggle"
            onClick={() => setLang((l) => (l === "fr" ? "en" : "fr"))}
            title="Changer la langue"
          >
            {lang === "fr" ? "🇫🇷 FR" : "🇬🇧 EN"}
          </button>
          <span className={`model-badge model-badge--${modelStatus}`}>
            {modelStatus === "checking" && "Vérification…"}
            {modelStatus === "available" && "Disponible"}
            {modelStatus === "unavailable" && "Indisponible"}
          </span>
        </header>

        <div className="chatbox-messages">
          {active?.messages.length === 0 && (
            <div className="empty-state">
              <span className="empty-icon">◈</span>
              <p className="empty-title">TechCorp Financial Assistant</p>
              <p className="empty-sub">Posez vos questions sur la finance, les marchés ou les données TechCorp.</p>
            </div>
          )}
          {active?.messages.map((msg, i) => (
            <div key={i} className={`message message--${msg.role}`}>
              {msg.role === "assistant" && <span className="msg-author">Assistant</span>}
              <div className="message-bubble">
                {msg.role === "assistant" ? (
                  <div className="md">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {msg.content}
                    </ReactMarkdown>
                  </div>
                ) : (
                  msg.content
                )}
              </div>
            </div>
          ))}
          {isWaiting && (
            <div className="typing-indicator">
              <span />
              <span />
              <span />
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        <div className="chatbox-input">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Tapez votre message... (Entrée pour envoyer, Maj+Entrée pour saut de ligne)"
            disabled={loading}
            rows={1}
          />
          {loading ? (
            <button className="stop-btn" onClick={stopGeneration}>
              Stop
            </button>
          ) : (
            <button onClick={sendMessage} disabled={!input.trim()}>
              Envoyer
            </button>
          )}
        </div>
      </main>
    </div>
  );
};

export default ChatBox;
