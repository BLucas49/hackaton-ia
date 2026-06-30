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

type ModelKey = "financial" | "medical";

type ModelState = {
  conversations: Conversation[];
  activeId: string;
};

const MODEL_CONFIG: Record<
  ModelKey,
  { model: string; storageKey: string; label: string; description: string }
> = {
  financial: {
    model: "techcorp-chatbox-financial",
    storageKey: "techcorp-conversations-financial",
    label: "Finance",
    description:
      "Posez vos questions sur la finance, les marchés ou les données TechCorp.",
  },
  medical: {
    model: "techcorp-chatbox-medical",
    storageKey: "techcorp-conversations-medical",
    label: "Médical",
    description:
      "Posez vos questions sur les données médicales et la santé TechCorp.",
  },
};

const ACTIVE_MODEL_KEY = "techcorp-active-model";

type Lang = "fr" | "en";

const LANG_PRIMER: Record<
  Lang,
  { role: "user" | "assistant"; content: string }[] | null
> = {
  fr: [
    {
      role: "user",
      content: "Pour toute cette conversation, réponds uniquement en français.",
    },
    {
      role: "assistant",
      content:
        "Bien sûr, je répondrai en français pour toute cette conversation.",
    },
  ],
  en: null,
};

const generateId = () => Math.random().toString(36).slice(2, 10);

const loadConversations = (key: string): Conversation[] => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
};

const saveConversations = (key: string, convs: Conversation[]) => {
  localStorage.setItem(key, JSON.stringify(convs));
};

const newConversation = (): Conversation => ({
  id: generateId(),
  title: "Nouvelle conversation",
  createdAt: Date.now(),
  messages: [],
});

const ChatBox = () => {
  const [activeModel, setActiveModel] = useState<ModelKey>(() => {
    const saved = localStorage.getItem(ACTIVE_MODEL_KEY);
    return saved === "medical" ? "medical" : "financial";
  });

  const [models, setModels] = useState<Record<ModelKey, ModelState>>(() => {
    // Migrate old storage key to the new financial key
    const old = localStorage.getItem("techcorp-conversations");
    if (old && !localStorage.getItem(MODEL_CONFIG.financial.storageKey)) {
      localStorage.setItem(MODEL_CONFIG.financial.storageKey, old);
      localStorage.removeItem("techcorp-conversations");
    }

    const initModel = (storageKey: string): ModelState => {
      const convs = loadConversations(storageKey);
      const conversations = convs.length > 0 ? convs : [newConversation()];
      return { conversations, activeId: conversations[0].id };
    };

    return {
      financial: initModel(MODEL_CONFIG.financial.storageKey),
      medical: initModel(MODEL_CONFIG.medical.storageKey),
    };
  });

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [modelStatuses, setModelStatuses] = useState<
    Record<ModelKey, "checking" | "available" | "unavailable">
  >({ financial: "checking", medical: "checking" });
  const [lang, setLang] = useState<Lang>("fr");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { conversations, activeId } = models[activeModel];
  const active = conversations.find((c) => c.id === activeId) ?? conversations[0];

  useEffect(() => {
    fetch("/api/ollama/api/tags")
      .then((res) => res.json())
      .then((data) => {
        const list: { name: string }[] = data.models ?? [];
        const check = (name: string) =>
          list.some((m) => m.name === name || m.name.startsWith(name + ":"))
            ? ("available" as const)
            : ("unavailable" as const);
        setModelStatuses({
          financial: check(MODEL_CONFIG.financial.model),
          medical: check(MODEL_CONFIG.medical.model),
        });
      })
      .catch(() =>
        setModelStatuses({ financial: "unavailable", medical: "unavailable" }),
      );
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [active?.messages]);

  useEffect(() => {
    saveConversations(
      MODEL_CONFIG.financial.storageKey,
      models.financial.conversations,
    );
    saveConversations(
      MODEL_CONFIG.medical.storageKey,
      models.medical.conversations,
    );
  }, [models]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_MODEL_KEY, activeModel);
  }, [activeModel]);

  const setActiveId = (id: string) => {
    setModels((prev) => ({
      ...prev,
      [activeModel]: { ...prev[activeModel], activeId: id },
    }));
  };

  const appendToAssistant = (
    chunk: string,
    convId: string,
    history: Message[],
    modelKey: ModelKey,
  ) => {
    setModels((prev) => ({
      ...prev,
      [modelKey]: {
        ...prev[modelKey],
        conversations: prev[modelKey].conversations.map((c) => {
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
      },
    }));
  };

  const processStream = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    convId: string,
    history: Message[],
    modelKey: ModelKey,
  ) => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split("\n").filter(Boolean)) {
        try {
          const data = JSON.parse(line);
          if (data.message?.content)
            appendToAssistant(data.message.content, convId, history, modelKey);
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
    const modelKey = activeModel;
    const modelName = MODEL_CONFIG[modelKey].model;

    const isFirstMessage = active.messages.length === 0;
    const truncated =
      content.length > 40 ? content.slice(0, 40) + "…" : content;
    const title = isFirstMessage ? truncated : active.title;

    setModels((prev) => ({
      ...prev,
      [modelKey]: {
        ...prev[modelKey],
        conversations: prev[modelKey].conversations.map((c) =>
          c.id === convId ? { ...c, messages: history, title } : c,
        ),
      },
    }));
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
          model: modelName,
          messages: [...(LANG_PRIMER[lang] ?? []), ...history],
          stream: true,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await processStream(response.body!.getReader(), convId, history, modelKey);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setModels((prev) => ({
        ...prev,
        [modelKey]: {
          ...prev[modelKey],
          conversations: prev[modelKey].conversations.map((c) =>
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
        },
      }));
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
    setModels((prev) => ({
      ...prev,
      [activeModel]: {
        conversations: [conv, ...prev[activeModel].conversations],
        activeId: conv.id,
      },
    }));
    setInput("");
  };

  const deleteConversation = (id: string) => {
    setModels((prev) => {
      const current = prev[activeModel];
      const next = current.conversations.filter((c) => c.id !== id);
      if (next.length === 0) {
        const fresh = newConversation();
        return { ...prev, [activeModel]: { conversations: [fresh], activeId: fresh.id } };
      }
      const newActiveId = current.activeId === id ? next[0].id : current.activeId;
      return { ...prev, [activeModel]: { conversations: next, activeId: newActiveId } };
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
      <aside
        className={`sidebar ${sidebarOpen ? "sidebar--open" : "sidebar--closed"}`}
      >
        <div className="sidebar-header">
          {sidebarOpen && <span className="sidebar-title">Conversations</span>}
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            title="Réduire"
          >
            {sidebarOpen ? "‹" : "›"}
          </button>
        </div>
        {sidebarOpen && (
          <>
            <div className="model-tabs">
              {(Object.keys(MODEL_CONFIG) as ModelKey[]).map((key) => (
                <button
                  key={key}
                  className={`model-tab ${activeModel === key ? "model-tab--active" : ""}`}
                  onClick={() => setActiveModel(key)}
                  disabled={loading}
                  title={
                    loading
                      ? "Une réponse est en cours…"
                      : MODEL_CONFIG[key].label
                  }
                >
                  {MODEL_CONFIG[key].label}
                </button>
              ))}
            </div>
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
                      {isActive && loading && (
                        <span className="conv-generating" />
                      )}
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
          <h1>TechCorp {MODEL_CONFIG[activeModel].label} Assistant</h1>
          <button
            className="lang-toggle"
            onClick={() => setLang((l) => (l === "fr" ? "en" : "fr"))}
            title="Changer la langue"
          >
            {lang === "fr" ? "🇫🇷 FR" : "🇬🇧 EN"}
          </button>
          <span
            className={`model-badge model-badge--${modelStatuses[activeModel]}`}
          >
            {modelStatuses[activeModel] === "checking" && "Vérification…"}
            {modelStatuses[activeModel] === "available" && "Disponible"}
            {modelStatuses[activeModel] === "unavailable" && "Indisponible"}
          </span>
        </header>

        <div className="chatbox-messages">
          {active?.messages.length === 0 && (
            <div className="empty-state">
              <span className="empty-icon">◈</span>
              <p className="empty-title">
                TechCorp {MODEL_CONFIG[activeModel].label} Assistant
              </p>
              <p className="empty-sub">
                {MODEL_CONFIG[activeModel].description}
              </p>
            </div>
          )}
          {active?.messages.map((msg, i) => (
            <div key={i} className={`message message--${msg.role}`}>
              {msg.role === "assistant" && (
                <span className="msg-author">Assistant</span>
              )}
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
