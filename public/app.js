// PharmaLLM - Client-side application

const chatContainer = document.getElementById("chat-container");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
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

// Auto-resize du textarea
userInput.addEventListener("input", () => {
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
});

// Envoi avec Enter (Shift+Enter pour nouvelle ligne)
userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);

// Charger les modeles disponibles
async function loadModels() {
  try {
    const res = await fetch("/api/chat/models");
    const data = await res.json();
    if (data.models && data.models.length > 0) {
      modelSelect.innerHTML = data.models
        .map((m) => `<option value="${m}">${m}</option>`)
        .join("");
      setStatus("Ollama connected", "success");
    } else {
      setStatus("No models found", "error");
    }
  } catch {
    setStatus("Ollama unavailable - run 'ollama serve'", "error");
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

  // Afficher le message utilisateur
  addMessage("user", message);
  userInput.value = "";
  userInput.style.height = "auto";

  // Desactiver l'input
  sendBtn.disabled = true;
  userInput.disabled = true;
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
    const contentDiv = messageDiv.querySelector(".message-wrapper .message-content");

    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = JSON.parse(line.slice(6));
          if (data.error) {
            contentDiv.innerHTML = `<span style="color: var(--error)">${data.error}</span>`;
            break;
          }
          if (data.done) break;
          if (data.token) {
            assistantContent += data.token;
            contentDiv.innerHTML = formatMessage(assistantContent);
            chatContainer.scrollTop = chatContainer.scrollHeight;
          }
        }
      }
    }

    // Ajouter a l'historique
    conversationHistory.push(
      { role: "user", content: message },
      { role: "assistant", content: assistantContent }
    );

    // Garder seulement les 20 derniers messages
    if (conversationHistory.length > 20) {
      conversationHistory = conversationHistory.slice(-20);
    }
  } catch (error) {
    removeTyping();
    addMessage("assistant", "Connection error. Make sure Ollama is running.");
  }

  sendBtn.disabled = false;
  userInput.disabled = false;
  userInput.focus();
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

// Init
loadModels();
