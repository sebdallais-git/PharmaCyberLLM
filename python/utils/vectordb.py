"""ChromaDB vector store for RAG with Ollama embeddings and LLM re-ranking."""

import hashlib
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import chromadb
import requests

OLLAMA_URL = "http://localhost:11434/api/embeddings"
OLLAMA_GENERATE_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "gemma2:9b"
CHROMADB_PATH = str(Path(__file__).resolve().parents[2] / "data" / "chromadb")
COLLECTION_NAME = "knowledge_base"

# Smart chunking parameters (in tokens, ~4 chars per token)
TARGET_CHUNK_MIN = 300
TARGET_CHUNK_MAX = 500
PARAGRAPH_SPLIT_THRESHOLD = 600  # split paragraphs longer than this
PARAGRAPH_MERGE_THRESHOLD = 100  # merge paragraphs shorter than this

# Re-ranking
RERANK_RETRIEVE_K = 15
RERANK_FINAL_K = 5
RERANK_MIN_SCORE = 5
RERANK_MIN_FALLBACK = 3

LOG_DIR = Path(__file__).resolve().parents[2] / "data" / "logs"
RERANK_LOG = LOG_DIR / "reranking.log"

# Set up reranking logger
LOG_DIR.mkdir(parents=True, exist_ok=True)
_rerank_logger = logging.getLogger("reranking")
_rerank_logger.setLevel(logging.INFO)
_rerank_handler = logging.FileHandler(RERANK_LOG)
_rerank_handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
_rerank_logger.addHandler(_rerank_handler)


# ---------------------------------------------------------------------------
# ChromaDB client
# ---------------------------------------------------------------------------

def _get_client() -> chromadb.ClientAPI:
    """Return a persistent ChromaDB client."""
    return chromadb.PersistentClient(path=CHROMADB_PATH)


def _get_collection(client: chromadb.ClientAPI) -> chromadb.Collection:
    """Get or create the knowledge_base collection."""
    return client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )


# ---------------------------------------------------------------------------
# Ollama helpers
# ---------------------------------------------------------------------------

def _get_embedding(text: str) -> list[float]:
    """Generate an embedding via Ollama API."""
    resp = requests.post(
        OLLAMA_URL,
        json={"model": OLLAMA_MODEL, "prompt": text, "keep_alive": "30m"},
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()["embedding"]


def _call_ollama_generate(prompt: str, temperature: float = 0.1) -> str:
    """Call Ollama generate endpoint and return the response text."""
    resp = requests.post(
        OLLAMA_GENERATE_URL,
        json={
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": temperature},
        },
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json().get("response", "")


# ---------------------------------------------------------------------------
# Smart chunking
# ---------------------------------------------------------------------------

_HEADING_RE = re.compile(
    r"^(?:"
    r"#{1,6}\s+.+"          # Markdown headings
    r"|[A-Z][A-Z0-9 ,/&-]{2,80}$"  # ALL CAPS lines (titles)
    r"|\d+(?:\.\d+)*\s+.+"  # Numbered sections like "3.1 Title"
    r"|Section\s+\d+.+"     # "Section 3.1 ..."
    r")",
    re.MULTILINE,
)


def _estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token."""
    return len(text) // 4


def _extract_document_title(text: str) -> str:
    """Extract title from the first line or <title> tag."""
    # HTML title
    match = re.search(r"<title>(.*?)</title>", text, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    # First non-empty line
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped[:200]
    return "Untitled"


def _detect_heading(line: str) -> str | None:
    """Return the line as a heading if it matches heading patterns."""
    stripped = line.strip()
    if not stripped or len(stripped) > 200:
        return None
    if _HEADING_RE.match(stripped):
        # Clean markdown heading markers
        return re.sub(r"^#{1,6}\s+", "", stripped).strip()
    return None


def _split_sentences(text: str) -> list[str]:
    """Split text on sentence boundaries."""
    # Split on period/question/exclamation followed by space or end
    parts = re.split(r"(?<=[.!?])\s+", text)
    return [s.strip() for s in parts if s.strip()]


def _chunk_text_smart(
    text: str,
    source_url: str = "",
) -> list[dict]:
    """Split text into chunks with smart boundaries and metadata.

    Returns list of dicts with keys:
        text, section_header, chunk_index, source_url, ingested_at, document_title
    """
    document_title = _extract_document_title(text)
    ingested_at = datetime.now(timezone.utc).isoformat()

    paragraphs = text.split("\n\n")
    current_heading = ""
    raw_blocks: list[tuple[str, str]] = []  # (text, heading)

    for para in paragraphs:
        stripped = para.strip()
        if not stripped:
            continue

        # Check each line for headings
        for line in stripped.splitlines():
            heading = _detect_heading(line)
            if heading:
                current_heading = heading

        raw_blocks.append((stripped, current_heading))

    # Phase 1: split oversized paragraphs on sentence boundaries
    split_blocks: list[tuple[str, str]] = []
    for block_text, heading in raw_blocks:
        tokens = _estimate_tokens(block_text)
        if tokens > PARAGRAPH_SPLIT_THRESHOLD:
            sentences = _split_sentences(block_text)
            current = ""
            for sentence in sentences:
                if _estimate_tokens(current + " " + sentence) > TARGET_CHUNK_MAX and current:
                    split_blocks.append((current.strip(), heading))
                    current = ""
                current += (" " if current else "") + sentence
            if current.strip():
                split_blocks.append((current.strip(), heading))
        else:
            split_blocks.append((block_text, heading))

    # Phase 2: merge small paragraphs
    merged_blocks: list[tuple[str, str]] = []
    current_text = ""
    current_heading_val = ""

    for block_text, heading in split_blocks:
        if not current_text:
            current_text = block_text
            current_heading_val = heading
            continue

        combined_tokens = _estimate_tokens(current_text + "\n\n" + block_text)

        if _estimate_tokens(current_text) < PARAGRAPH_MERGE_THRESHOLD and combined_tokens <= TARGET_CHUNK_MAX:
            current_text += "\n\n" + block_text
            if heading:
                current_heading_val = heading
        elif combined_tokens <= TARGET_CHUNK_MAX:
            current_text += "\n\n" + block_text
            if heading:
                current_heading_val = heading
        else:
            merged_blocks.append((current_text, current_heading_val))
            current_text = block_text
            current_heading_val = heading

    if current_text.strip():
        merged_blocks.append((current_text.strip(), current_heading_val))

    # Build final chunks with metadata
    chunks = []
    for i, (chunk_text, heading) in enumerate(merged_blocks):
        chunks.append({
            "text": chunk_text,
            "section_header": heading,
            "chunk_index": i,
            "source_url": source_url,
            "ingested_at": ingested_at,
            "document_title": document_title,
        })

    return chunks


# Legacy chunking function kept for compatibility
def _chunk_text(text: str, max_tokens: int = 500) -> list[str]:
    """Split text into chunks of roughly max_tokens tokens (legacy)."""
    chunks = _chunk_text_smart(text)
    return [c["text"] for c in chunks]


def _make_id(text: str) -> str:
    """Generate a deterministic ID from text content."""
    return hashlib.sha256(text.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Re-ranking
# ---------------------------------------------------------------------------

def _rerank_chunks(question: str, chunks: list[dict]) -> list[dict]:
    """Re-rank chunks using Ollama as a relevance judge.

    Args:
        question: The user's question.
        chunks: List of chunk dicts from ChromaDB query.

    Returns:
        Re-ranked and filtered list of chunks (top 5 with score >= 5).
    """
    if not chunks:
        return []

    original_ids = [c.get("id", f"chunk_{i}") for i, c in enumerate(chunks)]

    # Build the prompt
    chunk_list = ""
    for i, chunk in enumerate(chunks):
        text = chunk.get("document", "")[:500]  # Limit each chunk in prompt
        chunk_list += f"[{i + 1}] {text}\n\n"

    prompt = (
        "You are a relevance judge. Given a user question and a list of text chunks, "
        "score each chunk from 0 to 10 on how relevant and useful it is for answering "
        "the question. Consider:\n"
        "- Does it directly answer the question? (high score)\n"
        "- Does it provide useful background context? (medium score)\n"
        "- Is it only tangentially related or irrelevant? (low score)\n\n"
        f"Question: {question}\n\n"
        f"Chunks:\n{chunk_list}\n"
        "Respond with ONLY a JSON array of objects, no other text:\n"
        '[{"chunk_id": 1, "score": 8, "reason": "directly answers dosage question"},\n'
        ' {"chunk_id": 2, "score": 3, "reason": "mentions the drug but not dosage"}, ...]'
    )

    try:
        response = _call_ollama_generate(prompt, temperature=0.1)

        # Parse JSON from response
        json_match = re.search(r"\[[\s\S]*\]", response)
        if not json_match:
            _rerank_logger.warning(
                "RERANK_PARSE_FAIL question=%r response_preview=%r — falling back to top 5",
                question[:100], response[:200],
            )
            return chunks[:RERANK_FINAL_K]

        scores = json.loads(json_match.group())

        # Build scored results
        scored: list[tuple[int, float, str, dict]] = []
        for item in scores:
            idx = int(item.get("chunk_id", 0)) - 1
            score = float(item.get("score", 0))
            reason = str(item.get("reason", ""))
            if 0 <= idx < len(chunks):
                scored.append((idx, score, reason, chunks[idx]))

        # Sort by score descending
        scored.sort(key=lambda x: x[1], reverse=True)

        # Filter: top chunks with score >= RERANK_MIN_SCORE
        above_threshold = [(idx, s, r, c) for idx, s, r, c in scored if s >= RERANK_MIN_SCORE]

        if len(above_threshold) >= RERANK_MIN_FALLBACK:
            selected = above_threshold[:RERANK_FINAL_K]
        else:
            # Fallback: take top 3 regardless of score
            selected = scored[:RERANK_MIN_FALLBACK]

        # Log results
        reranked_info = [
            {"chunk_id": original_ids[idx], "score": s, "reason": r}
            for idx, s, r, _c in selected
        ]
        _rerank_logger.info(
            "RERANK question=%r original_ids=%r reranked=%r",
            question[:100], original_ids, reranked_info,
        )

        return [c for _, _, _, c in selected]

    except (json.JSONDecodeError, requests.RequestException, KeyError, ValueError) as exc:
        _rerank_logger.warning(
            "RERANK_ERROR question=%r error=%s — falling back to top 5",
            question[:100], exc,
        )
        return chunks[:RERANK_FINAL_K]


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def add_documents(texts: list[str], metadatas: list[dict]) -> int:
    """Chunk texts with smart chunking, embed via Ollama, and upsert into ChromaDB.

    Args:
        texts: List of document texts to ingest.
        metadatas: List of metadata dicts (one per text). Should include
                   a "source" key for document_exists() lookups.

    Returns:
        Number of chunks added.
    """
    client = _get_client()
    collection = _get_collection(client)

    all_ids: list[str] = []
    all_chunks: list[str] = []
    all_embeddings: list[list[float]] = []
    all_metadatas: list[dict] = []

    for text, meta in zip(texts, metadatas):
        source_url = meta.get("source", "")
        smart_chunks = _chunk_text_smart(text, source_url=source_url)

        for chunk_data in smart_chunks:
            chunk_id = _make_id(chunk_data["text"])
            embedding = _get_embedding(chunk_data["text"])

            chunk_meta = {
                **meta,
                "chunk_index": chunk_data["chunk_index"],
                "section_header": chunk_data["section_header"],
                "source_url": chunk_data["source_url"],
                "ingested_at": chunk_data["ingested_at"],
                "document_title": chunk_data["document_title"],
            }

            all_ids.append(chunk_id)
            all_chunks.append(chunk_data["text"])
            all_embeddings.append(embedding)
            all_metadatas.append(chunk_meta)

    if all_ids:
        collection.upsert(
            ids=all_ids,
            documents=all_chunks,
            embeddings=all_embeddings,
            metadatas=all_metadatas,
        )

    return len(all_ids)


def query(question: str, n_results: int = 5) -> list[dict]:
    """Embed a question, retrieve top 15 from ChromaDB, re-rank to top 5.

    Args:
        question: The search query.
        n_results: Number of final results to return (after re-ranking).

    Returns:
        List of dicts with keys: id, document, metadata, distance.
        Each document is prefixed with section context for RAG.
    """
    client = _get_client()
    collection = _get_collection(client)

    if collection.count() == 0:
        return []

    question_embedding = _get_embedding(question)
    retrieve_k = min(RERANK_RETRIEVE_K, collection.count())

    results = collection.query(
        query_embeddings=[question_embedding],
        n_results=retrieve_k,
    )

    # Build candidate list
    candidates: list[dict] = []
    for i in range(len(results["ids"][0])):
        candidates.append({
            "id": results["ids"][0][i],
            "document": results["documents"][0][i],
            "metadata": results["metadatas"][0][i],
            "distance": results["distances"][0][i],
        })

    # Re-rank using Ollama
    reranked = _rerank_chunks(question, candidates)

    # Add section context to documents for RAG
    for chunk in reranked:
        meta = chunk.get("metadata", {})
        header = meta.get("section_header", "")
        source = meta.get("source_url", "") or meta.get("source", "")
        original_doc = chunk["document"]

        if header and source:
            chunk["document"] = f"From section '{header}' of {source}: {original_doc}"
        elif header:
            chunk["document"] = f"From section '{header}': {original_doc}"
        elif source:
            chunk["document"] = f"From {source}: {original_doc}"

    return reranked[:n_results]


def document_exists(source_url: str) -> bool:
    """Check if content from a given source URL is already in the DB."""
    client = _get_client()
    collection = _get_collection(client)

    results = collection.get(
        where={"source": source_url},
        limit=1,
    )

    return len(results["ids"]) > 0


def delete_collection() -> None:
    """Delete the knowledge_base collection entirely."""
    client = _get_client()
    try:
        client.delete_collection(COLLECTION_NAME)
    except Exception:
        pass  # Collection doesn't exist


def get_stats() -> dict:
    """Return basic stats about the knowledge base."""
    client = _get_client()
    collection = _get_collection(client)
    count = collection.count()

    sources: set[str] = set()
    if count > 0:
        all_meta = collection.get(include=["metadatas"])
        for meta in all_meta["metadatas"]:
            if "source" in meta:
                sources.add(meta["source"])

    return {
        "total_chunks": count,
        "sources": sorted(sources),
    }
