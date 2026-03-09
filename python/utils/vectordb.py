"""ChromaDB vector store for RAG with Ollama embeddings."""

import hashlib
import uuid
from pathlib import Path

import chromadb
import requests

OLLAMA_URL = "http://localhost:11434/api/embeddings"
OLLAMA_MODEL = "gemma2:9b"
CHROMADB_PATH = str(Path(__file__).resolve().parents[2] / "data" / "chromadb")
COLLECTION_NAME = "knowledge_base"
CHUNK_SIZE = 500  # approximate token target per chunk


def _get_client() -> chromadb.ClientAPI:
    """Return a persistent ChromaDB client."""
    return chromadb.PersistentClient(path=CHROMADB_PATH)


def _get_collection(client: chromadb.ClientAPI) -> chromadb.Collection:
    """Get or create the knowledge_base collection."""
    return client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )


def _get_embedding(text: str) -> list[float]:
    """Generate an embedding via Ollama API."""
    resp = requests.post(
        OLLAMA_URL,
        json={"model": OLLAMA_MODEL, "prompt": text, "keep_alive": "30m"},
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()["embedding"]


def _chunk_text(text: str, max_tokens: int = CHUNK_SIZE) -> list[str]:
    """Split text into chunks of roughly max_tokens tokens.

    Uses a simple heuristic: 1 token ≈ 4 characters.
    Splits on paragraph boundaries, falling back to sentence boundaries.
    """
    char_limit = max_tokens * 4
    paragraphs = text.split("\n\n")
    chunks: list[str] = []
    current = ""

    for paragraph in paragraphs:
        stripped = paragraph.strip()
        if not stripped:
            continue

        if len(current) + len(stripped) + 2 > char_limit and current:
            chunks.append(current.strip())
            current = ""

        # If a single paragraph exceeds the limit, split on sentences
        if len(stripped) > char_limit:
            sentences = stripped.replace(". ", ".\n").split("\n")
            for sentence in sentences:
                sentence = sentence.strip()
                if not sentence:
                    continue
                if len(current) + len(sentence) + 1 > char_limit and current:
                    chunks.append(current.strip())
                    current = ""
                current += (" " if current else "") + sentence
        else:
            current += ("\n\n" if current else "") + stripped

    if current.strip():
        chunks.append(current.strip())

    return chunks


def _make_id(text: str) -> str:
    """Generate a deterministic ID from text content."""
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def add_documents(texts: list[str], metadatas: list[dict]) -> int:
    """Chunk texts, embed via Ollama, and upsert into ChromaDB.

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
        chunks = _chunk_text(text)
        for i, chunk in enumerate(chunks):
            chunk_id = _make_id(chunk)
            embedding = _get_embedding(chunk)
            chunk_meta = {**meta, "chunk_index": i, "total_chunks": len(chunks)}

            all_ids.append(chunk_id)
            all_chunks.append(chunk)
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
    """Embed a question and return the top matching chunks.

    Args:
        question: The search query.
        n_results: Number of results to return.

    Returns:
        List of dicts with keys: id, document, metadata, distance.
    """
    client = _get_client()
    collection = _get_collection(client)

    if collection.count() == 0:
        return []

    question_embedding = _get_embedding(question)
    results = collection.query(
        query_embeddings=[question_embedding],
        n_results=min(n_results, collection.count()),
    )

    output: list[dict] = []
    for i in range(len(results["ids"][0])):
        output.append({
            "id": results["ids"][0][i],
            "document": results["documents"][0][i],
            "metadata": results["metadatas"][0][i],
            "distance": results["distances"][0][i],
        })

    return output


def document_exists(source_url: str) -> bool:
    """Check if content from a given source URL is already in the DB.

    Args:
        source_url: The source identifier to check.

    Returns:
        True if at least one chunk with this source exists.
    """
    client = _get_client()
    collection = _get_collection(client)

    results = collection.get(
        where={"source": source_url},
        limit=1,
    )

    return len(results["ids"]) > 0


def get_stats() -> dict:
    """Return basic stats about the knowledge base."""
    client = _get_client()
    collection = _get_collection(client)
    count = collection.count()

    # Get unique sources
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
