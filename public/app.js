// PharmaLLM - Client-side application

const chatContainer = document.getElementById("chat-container");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const stackSelect = document.getElementById("stack-select");
const stackStatusEl = document.getElementById("stack-status");
const modelSelect = document.getElementById("model-select");
const fileUpload = document.getElementById("file-upload");
const statusEl = document.getElementById("status");
const knowledgeBtn = document.getElementById("knowledge-btn");
const knowledgeModal = document.getElementById("knowledge-modal");
const closeModal = document.getElementById("close-modal");
const knowledgeStats = document.getElementById("knowledge-stats");
const ingestBtn = document.getElementById("ingest-btn");
const searchBtn = document.getElementById("search-btn");
const searchResults = document.getElementById("search-results");
const webSearchToggle = document.getElementById("web-search-toggle");

// Historique de conversation
let conversationHistory = [];

// Prompt history (arrow up/down to recall past inputs)
const promptHistory = [];
let promptHistoryIndex = -1;
let promptDraft = "";

// Auto-resize du textarea
userInput.addEventListener("input", () => {
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
});

// Keyboard handler: Enter to send, Arrow Up/Down for prompt history
userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
    return;
  }

  if (e.key === "ArrowUp" && promptHistory.length > 0) {
    // Only activate on first line (cursor at start or single-line input)
    const cursorAtTop = userInput.selectionStart === 0 || !userInput.value.includes("\n");
    if (!cursorAtTop) return;

    e.preventDefault();
    if (promptHistoryIndex === -1) {
      promptDraft = userInput.value;
      promptHistoryIndex = promptHistory.length - 1;
    } else if (promptHistoryIndex > 0) {
      promptHistoryIndex--;
    }
    userInput.value = promptHistory[promptHistoryIndex];
    userInput.style.height = "auto";
    userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
    return;
  }

  if (e.key === "ArrowDown" && promptHistoryIndex !== -1) {
    e.preventDefault();
    if (promptHistoryIndex < promptHistory.length - 1) {
      promptHistoryIndex++;
      userInput.value = promptHistory[promptHistoryIndex];
    } else {
      promptHistoryIndex = -1;
      userInput.value = promptDraft;
    }
    userInput.style.height = "auto";
    userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
    return;
  }
});

sendBtn.addEventListener("click", sendMessage);

// Load models from the active LLM stack
async function loadModels() {
  try {
    const res = await fetch("/api/chat/models");
    const data = await res.json();
    const stackLabel = (data.stack || "LLM").toUpperCase();

    if (!res.ok) {
      setStatus(`${stackLabel} stack unavailable - run scripts/switch-stack.sh ${data.stack || ""}`.trim(), "error");
      return;
    }

    // Embedding models can't chat; Ollama also lists the chat model as "<name>:latest"
    const chatModels = (data.models || []).filter(
      (m) => m !== data.embeddingModel && !/embed/i.test(m) && m !== `${data.chatModel}:latest`
    );
    if (data.chatModel && !chatModels.includes(data.chatModel)) {
      chatModels.unshift(data.chatModel);
    }

    if (chatModels.length > 0) {
      const sorted = [...chatModels].sort((a, b) =>
        a === data.chatModel ? -1 : b === data.chatModel ? 1 : 0
      );
      modelSelect.innerHTML = sorted
        .map((m) => `<option value="${m}"${m === data.chatModel ? " selected" : ""}>${m}</option>`)
        .join("");
      setStatus(`${stackLabel} stack connected`, "success");
    } else {
      setStatus(`No chat models found on ${stackLabel}`, "error");
    }
  } catch {
    setStatus("LLM stack unavailable - run scripts/switch-stack.sh", "error");
  }
}

// Copier du texte dans le presse-papiers (avec fallback)
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}

function fallbackCopy(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand("copy");
  } catch {}
  document.body.removeChild(textarea);
  return Promise.resolve();
}

// Ajouter un message dans le chat
function addMessage(role, content) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.innerHTML = `<div class="message-wrapper"><div class="message-content">${formatMessage(content)}</div><button class="copy-btn" title="Copy to clipboard">Copy</button></div>`;
  const copyBtn = div.querySelector(".copy-btn");
  copyBtn.addEventListener("click", () => {
    const text = div.querySelector(".message-content").innerText;
    copyToClipboard(text).then(() => {
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
    });
  });
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  return div;
}

// Formater le texte (markdown basique)
function formatMessage(text) {
  return text
    .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\n/g, "<br>");
}

// Build a reasoning panel that shows thought-process steps (safe DOM methods)
function buildReasoningPanel() {
  const el = document.createElement("div");
  el.className = "reasoning-panel";

  // Header
  const header = document.createElement("div");
  header.className = "reasoning-header";

  const icon = document.createElement("span");
  icon.className = "reasoning-icon";
  icon.textContent = "\u25CB"; // circle icon

  const title = document.createElement("span");
  title.className = "reasoning-title";
  title.textContent = "Thinking\u2026";

  const toggle = document.createElement("span");
  toggle.className = "reasoning-toggle";

  header.appendChild(icon);
  header.appendChild(title);
  header.appendChild(toggle);

  // Steps container
  const steps = document.createElement("div");
  steps.className = "reasoning-steps";

  el.appendChild(header);
  el.appendChild(steps);

  // Toggle collapse on click
  header.addEventListener("click", () => {
    el.classList.toggle("collapsed");
  });

  return {
    el,
    addStep(text, sources) {
      const step = document.createElement("div");
      step.className = "reasoning-step";

      const dot = document.createElement("span");
      dot.className = "reasoning-step-dot";

      const label = document.createElement("span");
      label.className = "reasoning-step-text";
      label.textContent = text;

      step.appendChild(dot);
      step.appendChild(label);

      if (sources && sources.length > 0) {
        const sourcesDiv = document.createElement("div");
        sourcesDiv.className = "reasoning-sources";
        sources.forEach((s) => {
          const tag = document.createElement("span");
          tag.className = "reasoning-source-tag";
          tag.textContent = s;
          sourcesDiv.appendChild(tag);
        });
        step.appendChild(sourcesDiv);
      }

      steps.appendChild(step);
    },
    finish(count) {
      title.textContent = "Reasoned over " + count + " steps";
      el.classList.add("done");
      el.classList.add("collapsed");
    },
  };
}

// Afficher l'indicateur de frappe
function showTyping() {
  const div = document.createElement("div");
  div.className = "message assistant";
  div.id = "typing";
  div.innerHTML = `
    <div class="message-content">
      <div class="typing-indicator">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  chatContainer.appendChild(div);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function removeTyping() {
  const typing = document.getElementById("typing");
  if (typing) typing.remove();
}

// Envoyer un message
async function sendMessage() {
  const message = userInput.value.trim();
  if (!message) return;

  // Save to prompt history
  if (promptHistory[promptHistory.length - 1] !== message) {
    promptHistory.push(message);
  }
  promptHistoryIndex = -1;
  promptDraft = "";

  // Afficher le message utilisateur
  addMessage("user", message);
  userInput.value = "";
  userInput.style.height = "auto";

  // Disable send button during processing (textarea stays editable)
  sendBtn.disabled = true;
  showTyping();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        history: conversationHistory,
        model: modelSelect.value,
        webSearch: webSearchToggle.checked,
      }),
    });

    removeTyping();

    // Lire le stream SSE
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let assistantContent = "";
    const messageDiv = addMessage("assistant", "");
    const wrapperDiv = messageDiv.querySelector(".message-wrapper");
    const contentDiv = wrapperDiv.querySelector(".message-content");

    // Build reasoning panel (shown during processing, collapses when answer starts)
    const reasoningPanel = buildReasoningPanel();
    wrapperDiv.insertBefore(reasoningPanel.el, contentDiv);
    let reasoningCount = 0;
    let firstTokenReceived = false;

    let buffer = "";
    let streamDone = false;
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let data;
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          continue; // skip malformed chunk, wait for next line
        }
        if (data.error) {
          contentDiv.textContent = data.error;
          contentDiv.style.color = "var(--error)";
          streamDone = true;
          break;
        }
        if (data.reasoning) {
          reasoningCount++;
          reasoningPanel.addStep(data.reasoning, data.sources || []);
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }
        if (data.done) {
          if (data.tokenStats && typeof data.tokenStats.tokensPerSecond === "number") {
            const s = data.tokenStats;
            const stackLabel = data.stack ? `${data.stack.toUpperCase()} \u00b7 ` : "";
            const statsDiv = document.createElement("div");
            statsDiv.className = "token-stats";
            statsDiv.textContent = `${stackLabel}TTFT ${((s.ttftMs || 0) / 1000).toFixed(1)}s \u00b7 ${s.tokensPerSecond.toFixed(1)} tok/s \u00b7 ${s.promptTokens || 0} in / ${s.completionTokens || 0} out`;
            wrapperDiv.appendChild(statsDiv);
          }
          if (!firstTokenReceived) {
            reasoningPanel.finish(reasoningCount);
          }
          streamDone = true;
          break;
        }
        if (data.token) {
          // Auto-collapse reasoning on first token
          if (!firstTokenReceived) {
            firstTokenReceived = true;
            reasoningPanel.finish(reasoningCount);
          }
          assistantContent += data.token;
          contentDiv.innerHTML = formatMessage(assistantContent);
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }
      }
    }

    // If no reasoning steps were emitted, remove the panel
    if (reasoningCount === 0) {
      reasoningPanel.el.remove();
    }

    // Ajouter a l'historique
    conversationHistory.push(
      { role: "user", content: message },
      { role: "assistant", content: assistantContent }
    );

    // Garder seulement les 20 derniers messages
    if (conversationHistory.length > 15) {
      conversationHistory = conversationHistory.slice(-15);
    }
  } catch (error) {
    removeTyping();
    addMessage("assistant", "Connection error. Make sure PharmaLLM and its LLM stack are running.");
  } finally {
    sendBtn.disabled = false;
  }
}

// Upload de fichier
fileUpload.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  setStatus(`Uploading ${file.name}...`);

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/knowledge/upload", {
      method: "POST",
      body: formData,
    });
    const data = await res.json();

    if (res.ok) {
      setStatus(`${file.name} ingested (${data.added} chunks)`, "success");
    } else {
      setStatus(data.error, "error");
    }
  } catch {
    setStatus("Upload error", "error");
  }

  fileUpload.value = "";
});

// Modal base de connaissances
knowledgeBtn.addEventListener("click", async () => {
  knowledgeModal.hidden = false;
  await loadKnowledgeStats();
});

closeModal.addEventListener("click", () => {
  knowledgeModal.hidden = true;
});

knowledgeModal.addEventListener("click", (e) => {
  if (e.target === knowledgeModal) knowledgeModal.hidden = true;
});

async function loadKnowledgeStats() {
  try {
    const res = await fetch("/api/knowledge/stats");
    const stats = await res.json();
    knowledgeStats.innerHTML = `
      <p><strong>${stats.totalChunks}</strong> indexed chunks</p>
      <p><strong>Sources:</strong> ${stats.sources.length > 0 ? stats.sources.join(", ") : "None"}</p>
    `;
  } catch {
    knowledgeStats.innerHTML = "<p>Loading error</p>";
  }
}

// Ingerer du texte
ingestBtn.addEventListener("click", async () => {
  const source = document.getElementById("text-source").value.trim();
  const content = document.getElementById("text-content").value.trim();

  if (!source || !content) {
    alert("Please fill in both the source name and text.");
    return;
  }

  try {
    const res = await fetch("/api/knowledge/ingest-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: content, source }),
    });
    const data = await res.json();
    alert(data.message);
    document.getElementById("text-source").value = "";
    document.getElementById("text-content").value = "";
    await loadKnowledgeStats();
  } catch {
    alert("Ingestion error");
  }
});

// Recherche dans la base
searchBtn.addEventListener("click", async () => {
  const query = document.getElementById("search-query").value.trim();
  if (!query) return;

  try {
    const res = await fetch("/api/knowledge/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();

    if (data.results.length === 0) {
      searchResults.innerHTML = "<p>No results</p>";
    } else {
      searchResults.innerHTML = data.results
        .map(
          (r) => `
          <div class="search-result">
            <div class="search-result-source">${r.source}</div>
            <div class="search-result-content">${r.content}</div>
          </div>
        `
        )
        .join("");
    }
  } catch {
    searchResults.innerHTML = "<p>Search error</p>";
  }
});

// News Agent modal
const agentBtn = document.getElementById("agent-btn");
const agentModal = document.getElementById("agent-modal");
const closeAgentModal = document.getElementById("close-agent-modal");
const agentStatusEl = document.getElementById("agent-status");
const agentTopicsEl = document.getElementById("agent-topics");
const runAgentBtn = document.getElementById("run-agent-btn");

agentBtn.addEventListener("click", async () => {
  agentModal.hidden = false;
  await loadAgentStatus();
});

closeAgentModal.addEventListener("click", () => {
  agentModal.hidden = true;
});

agentModal.addEventListener("click", (e) => {
  if (e.target === agentModal) agentModal.hidden = true;
});

async function loadAgentStatus() {
  try {
    const res = await fetch("/api/agent/status");
    const data = await res.json();

    let statusHtml = "";
    if (data.isRunning) {
      statusHtml = `<p class="agent-running">Agent is currently running...</p>`;
    } else if (data.lastRun) {
      const date = new Date(data.lastRun.timestamp).toLocaleString();
      statusHtml = `
        <p><strong>Last run:</strong> ${date}</p>
        <p><strong>Articles found:</strong> ${data.lastRun.newArticles}</p>
        <p><strong>Topics checked:</strong> ${data.lastRun.topics}</p>
      `;
    } else {
      statusHtml = `<p>Agent has not run yet in this session.</p>`;
    }
    agentStatusEl.innerHTML = statusHtml;

    if (data.topics) {
      agentTopicsEl.innerHTML = data.topics
        .map((t) => `<span class="topic-tag">${t}</span>`)
        .join(" ");
    }
  } catch {
    agentStatusEl.innerHTML = "<p>Error loading status</p>";
  }
}

runAgentBtn.addEventListener("click", async () => {
  runAgentBtn.disabled = true;
  runAgentBtn.textContent = "Running...";
  agentStatusEl.innerHTML = `<p class="agent-running">Scrubbing news sources... this may take a minute.</p>`;

  try {
    const res = await fetch("/api/agent/run", { method: "POST" });
    const data = await res.json();

    if (res.ok) {
      agentStatusEl.innerHTML = `
        <p class="agent-success">${data.message}</p>
        <p><strong>Last run:</strong> ${new Date(data.timestamp).toLocaleString()}</p>
      `;
    } else {
      agentStatusEl.innerHTML = `<p class="agent-error">${data.error}</p>`;
    }
  } catch {
    agentStatusEl.innerHTML = `<p class="agent-error">Failed to run agent</p>`;
  }

  runAgentBtn.disabled = false;
  runAgentBtn.textContent = "Run Now";
});

// Status helper
function setStatus(text, type = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${type}`;
  if (type) {
    setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "status";
    }, 5000);
  }
}

// Voice input via MediaRecorder + whisper.cpp backend
const micBtn = document.getElementById("mic-btn");

// Detect supported audio MIME type (Safari = mp4, Chrome/Firefox = webm)
function getAudioMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "",  // empty string = browser default
  ];
  for (const t of types) {
    try {
      if (t === "" || MediaRecorder.isTypeSupported(t)) return t;
    } catch { /* skip */ }
  }
  return "";
}

const audioMimeType = getAudioMimeType();
const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && audioMimeType !== null);

if (canRecord) {
  micBtn.hidden = false;
  let mediaRecorder = null;
  let audioChunks = [];

  micBtn.addEventListener("click", async () => {
    // Stop recording
    if (mediaRecorder && mediaRecorder.state === "recording") {
      mediaRecorder.stop();
      return;
    }

    // Start recording
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const msg = err.name === "NotAllowedError"
        ? "Mic blocked — allow microphone in Safari settings"
        : err.name === "NotFoundError"
          ? "No microphone found"
          : "Mic error: " + (err.message || err.name);
      setStatus(msg, "error");
      return;
    }

    try {
      audioChunks = [];
      const options = audioMimeType ? { mimeType: audioMimeType } : {};
      mediaRecorder = new MediaRecorder(stream, options);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstart = () => {
        micBtn.classList.add("listening");
        userInput.placeholder = "Listening... tap mic to stop";
      };

      mediaRecorder.onstop = async () => {
        micBtn.classList.remove("listening");
        userInput.placeholder = "Transcribing...";

        // Stop all mic tracks
        stream.getTracks().forEach((t) => t.stop());

        if (audioChunks.length === 0) {
          userInput.placeholder = "Ask your pharma question...";
          return;
        }

        // Determine file extension from MIME type
        const ext = (mediaRecorder.mimeType || "").includes("mp4") ? "mp4"
          : (mediaRecorder.mimeType || "").includes("ogg") ? "ogg"
          : "webm";
        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
        const formData = new FormData();
        formData.append("audio", blob, "recording." + ext);

        try {
          const res = await fetch("/api/chat/transcribe", {
            method: "POST",
            body: formData,
          });
          const data = await res.json();

          if (data.text) {
            const before = userInput.value.replace(/\s*$/, "");
            userInput.value = before ? before + " " + data.text : data.text;
            userInput.style.height = "auto";
            userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
          } else if (data.error) {
            setStatus("Transcription failed: " + data.error, "error");
          }
        } catch {
          setStatus("Transcription request failed", "error");
        }

        userInput.placeholder = "Ask your pharma question...";
        userInput.focus();
      };

      mediaRecorder.onerror = (e) => {
        micBtn.classList.remove("listening");
        stream.getTracks().forEach((t) => t.stop());
        setStatus("Recording error: " + (e.error?.message || "unknown"), "error");
        userInput.placeholder = "Ask your pharma question...";
      };

      mediaRecorder.start();
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      setStatus("Recording failed: " + (err.message || err.name), "error");
    }
  });
} else {
  // No MediaRecorder support — keep button hidden
  console.log("[Voice] MediaRecorder not available");
}

// Stack switching: the request needs a Telegram confirmation, so the UI waits and then follows the
// switch it asked for, counting down the confirmation window and reverting if it expires unused.
const STACK_LABELS = { ollama: "Ollama", mlx: "MLX", omlx: "oMLX" };
let stackPollTimer = null;
let lastKnownActive = null;
let watchSince = null; // Date.now() when this browser posted a switch request
let watchExpiresAt = null; // expires_at from the 202 body of that request
const CONFIRM_GRACE_MS = 15000; // the script writes its first phase within a second of the tap

// Same wording as src/services/switch-labels.ts. The browser cannot import TypeScript, so this is a
// deliberate second copy; __tests__/switch-labels.test.ts pins the wording both must produce
function formatCountdown(msRemaining) {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function describeStackStatus(status) {
  if (status.pending) return `Confirm the switch to ${status.pending.target.toUpperCase()} in Telegram`;
  const p = status.progress;
  if (p && p.phase === "failed") return `Switch to ${p.target.toUpperCase()} failed: ${p.error || "unknown error"}`;
  if (p && p.phase === "ready" && p.finishedAt) {
    return `${p.target.toUpperCase()} stack ready (${Math.round((p.finishedAt - p.startedAt) / 1000)} s)`;
  }
  const text = { confirmed: "starting", stopping: "stopping the current stack", starting: "starting the server",
                 warming: "warming up the model", indexing: "checking the indexes" };
  if (p && text[p.phase]) return `Switching to ${p.target.toUpperCase()}: ${text[p.phase]}`;
  return `${status.active.toUpperCase()} stack active`;
}

// Writes the switch status into its own persistent element (#stack-status), not the transient
// #status toast, which erases itself after 5 seconds and would never show a completed switch.
function renderStackStatus(status) {
  const options = (status.stacks || ["ollama", "mlx", "omlx"])
    .map((name) => {
      const selected = (status.pending ? status.pending.target : status.active) === name ? " selected" : "";
      return `<option value="${name}"${selected}>${STACK_LABELS[name] || name}</option>`;
    })
    .join("");
  if (stackSelect.innerHTML !== options) stackSelect.innerHTML = options;
  stackSelect.disabled = Boolean(status.pending) || !status.telegram_configured;
  stackSelect.title = status.telegram_configured
    ? "LLM stack (deployment environment)"
    : "Telegram confirmation not configured - run scripts/switch-stack.sh telegram";

  // A progress entry counts as "ours" once it started at or after the request this browser posted;
  // right after the Telegram tap, pending is already cleared but progress here still holds the
  // PREVIOUS switch's terminal state, so following pending alone would stop tracking too early.
  const oursHasAppeared = watchSince !== null && status.progress && status.progress.startedAt >= watchSince;
  let label, cls, busy;

  if (watchSince !== null && !oursHasAppeared) {
    if (Date.now() < watchExpiresAt + CONFIRM_GRACE_MS) {
      label = `${describeStackStatus(status)} (${formatCountdown(watchExpiresAt - Date.now())} left)`;
      cls = "busy";
      busy = true;
    } else {
      watchSince = null;
      watchExpiresAt = null;
      label = "Switch request expired";
      cls = "error";
      busy = false;
      stackSelect.value = status.active;
    }
  } else if (oursHasAppeared) {
    const phase = status.progress.phase;
    busy = phase !== "ready" && phase !== "failed";
    if (!busy) {
      watchSince = null;
      watchExpiresAt = null;
    }
    label = describeStackStatus(status);
    cls = phase === "ready" ? "ready" : phase === "failed" ? "error" : "busy";
  } else {
    // Not watching: page load, or another browser's switch
    const phase = status.progress && status.progress.phase;
    busy = Boolean(status.pending) || (phase && phase !== "ready" && phase !== "failed");
    label = describeStackStatus(status);
    cls = phase === "failed" ? "error" : phase === "ready" ? "ready" : busy ? "busy" : "";
  }

  stackStatusEl.textContent = label;
  stackStatusEl.className = cls ? `stack-status ${cls}` : "stack-status";

  if (status.active !== lastKnownActive) {
    lastKnownActive = status.active;
    loadModels();
  }
  return busy;
}

async function pollStackStatus() {
  try {
    const res = await fetch("/api/stack/status");
    if (!res.ok) return true;
    return renderStackStatus(await res.json());
  } catch {
    // The app restarts mid-switch: keep polling rather than reporting an error
    stackStatusEl.textContent = "Switching stack: waiting for PharmaLLM to come back";
    stackStatusEl.className = "stack-status busy";
    return true;
  }
}

function watchStackSwitch() {
  if (stackPollTimer) return;
  stackPollTimer = setInterval(async () => {
    const busy = await pollStackStatus();
    if (!busy) {
      clearInterval(stackPollTimer);
      stackPollTimer = null;
    }
  }, 3000);
}

stackSelect.addEventListener("change", async () => {
  const target = stackSelect.value;
  const previousValue = lastKnownActive;
  stackSelect.disabled = true;
  // Set before the POST: the server can write the first progress phase before the response
  // resolves, and "ours" is decided by comparing against this timestamp.
  watchSince = Date.now();
  try {
    const res = await fetch("/api/stack/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stack: target }),
    });
    const data = await res.json();
    if (!res.ok) {
      watchSince = null;
      watchExpiresAt = null;
      if (previousValue) stackSelect.value = previousValue;
      setStatus(data.error || "Stack switch refused", "error");
      await pollStackStatus();
      return;
    }
    watchExpiresAt = data.expires_at;
    watchStackSwitch();
    await pollStackStatus();
  } catch {
    watchSince = null;
    watchExpiresAt = null;
    if (previousValue) stackSelect.value = previousValue;
    setStatus("Could not reach PharmaLLM", "error");
  }
});

pollStackStatus().then((busy) => {
  if (busy) watchStackSwitch();
});

// Init
loadModels();
