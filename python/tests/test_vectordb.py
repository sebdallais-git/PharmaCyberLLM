"""Test script for the ChromaDB vector store."""

import sys
from pathlib import Path

# Add parent directory to path so we can import utils
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from utils.vectordb import add_documents, query, document_exists, get_stats


def main():
    print("=" * 60)
    print("ChromaDB Vector Store — Test Script")
    print("=" * 60)

    # Sample pharma documents
    texts = [
        (
            "Pfizer reported $58.5 billion in revenue for 2023, driven largely by "
            "COVID-19 vaccine sales. The company is investing heavily in oncology "
            "and rare disease pipelines. Key acquisitions include Seagen for $43 billion, "
            "expanding their antibody-drug conjugate portfolio. Pfizer operates major "
            "manufacturing plants in Kalamazoo, Michigan and Puurs, Belgium."
        ),
        (
            "Ransomware attacks on pharmaceutical companies increased by 45% in 2024. "
            "The average cost of a cyber incident in pharma is $5.2 million. "
            "Manufacturing execution systems (MES) and SCADA systems are primary targets. "
            "Notable attacks include the 2017 NotPetya attack on Merck, which caused "
            "$1.4 billion in damages and disrupted global vaccine production."
        ),
        (
            "GLP-1 receptor agonists like semaglutide (Ozempic/Wegovy) represent the "
            "fastest growing drug class in pharmaceutical history. Novo Nordisk's "
            "revenue from GLP-1 drugs exceeded $25 billion in 2024. Eli Lilly's "
            "tirzepatide (Mounjaro/Zepbound) is a dual GIP/GLP-1 agonist competing "
            "in the same space with projected peak sales of $30+ billion."
        ),
    ]

    metadatas = [
        {"source": "test://pfizer-overview", "topic": "business"},
        {"source": "test://cyber-threats", "topic": "cybersecurity"},
        {"source": "test://glp1-market", "topic": "science"},
    ]

    # 1. Add documents
    print("\n[1] Adding 3 sample documents...")
    count = add_documents(texts, metadatas)
    print(f"    Added {count} chunks to ChromaDB")

    # 2. Check document_exists
    print("\n[2] Checking document_exists()...")
    exists = document_exists("test://pfizer-overview")
    print(f"    'test://pfizer-overview' exists: {exists}")
    missing = document_exists("test://nonexistent")
    print(f"    'test://nonexistent' exists: {missing}")

    # 3. Query — business question
    print("\n[3] Query: 'What is Pfizer revenue and manufacturing?'")
    results = query("What is Pfizer revenue and manufacturing?", n_results=3)
    for i, r in enumerate(results):
        print(f"\n    Result {i + 1} (distance: {r['distance']:.4f}):")
        print(f"    Source: {r['metadata'].get('source', 'N/A')}")
        print(f"    Text:   {r['document'][:120]}...")

    # 4. Query — cybersecurity question
    print("\n[4] Query: 'ransomware attacks pharma cost'")
    results = query("ransomware attacks pharma cost", n_results=2)
    for i, r in enumerate(results):
        print(f"\n    Result {i + 1} (distance: {r['distance']:.4f}):")
        print(f"    Source: {r['metadata'].get('source', 'N/A')}")
        print(f"    Text:   {r['document'][:120]}...")

    # 5. Stats
    print("\n[5] Knowledge base stats:")
    stats = get_stats()
    print(f"    Total chunks: {stats['total_chunks']}")
    print(f"    Sources: {stats['sources']}")

    print("\n" + "=" * 60)
    print("All tests passed!")
    print("=" * 60)


if __name__ == "__main__":
    main()
