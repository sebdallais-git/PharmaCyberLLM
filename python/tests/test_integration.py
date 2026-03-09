"""Integration test: SearXNG search → fetch page → ChromaDB ingest → query."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from utils.search import search_web, fetch_page_content
from utils.vectordb import add_documents, query, document_exists


def main():
    print("=" * 60)
    print("Integration Test: SearXNG + ChromaDB")
    print("=" * 60)

    # 1. Search via SearXNG
    search_query = "Python FastAPI tutorial"
    print(f"\n[1] Searching SearXNG for: '{search_query}'")
    results = search_web(search_query, num_results=5)
    print(f"    Got {len(results)} results:")
    for i, r in enumerate(results):
        print(f"    {i + 1}. {r['title'][:70]}")
        print(f"       {r['url']}")

    if not results:
        print("\n    ERROR: No search results. Is SearXNG running on port 8888?")
        return

    # 2. Fetch top result content
    top_url = results[0]["url"]
    print(f"\n[2] Fetching page content from: {top_url}")
    content = fetch_page_content(top_url)
    print(f"    Extracted {len(content)} characters of clean text")
    print(f"    Preview: {content[:150]}...")

    # 3. Check if already in ChromaDB
    print(f"\n[3] Checking if already indexed...")
    if document_exists(top_url):
        print(f"    Already exists in ChromaDB, skipping ingest")
    else:
        print(f"    Not found, adding to ChromaDB...")
        count = add_documents(
            texts=[content],
            metadatas=[{
                "source": top_url,
                "title": results[0]["title"],
                "topic": "tutorial",
            }],
        )
        print(f"    Added {count} chunks to ChromaDB")

    # 4. Query ChromaDB
    print(f"\n[4] Querying ChromaDB for: '{search_query}'")
    matches = query(search_query, n_results=3)
    for i, m in enumerate(matches):
        print(f"\n    Result {i + 1} (distance: {m['distance']:.4f}):")
        print(f"    Source: {m['metadata'].get('source', 'N/A')}")
        print(f"    Text:   {m['document'][:120]}...")

    # 5. Verify the fetched page appears in results
    sources = [m["metadata"].get("source") for m in matches]
    if top_url in sources:
        print(f"\n    SUCCESS: Fetched page found in ChromaDB results")
    else:
        print(f"\n    NOTE: Fetched page not in top 3 (other pharma docs may rank higher)")

    print("\n" + "=" * 60)
    print("Integration test complete!")
    print("=" * 60)


if __name__ == "__main__":
    main()
