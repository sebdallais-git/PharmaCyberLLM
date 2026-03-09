"""Web search via local SearXNG instance + page content extraction."""

import requests
from bs4 import BeautifulSoup

SEARXNG_URL = "http://localhost:8888/search"
MAX_PAGE_CHARS = 10000


def search_web(query: str, num_results: int = 5) -> list[dict]:
    """Search the web via the local SearXNG instance.

    Args:
        query: Search query string.
        num_results: Maximum number of results to return.

    Returns:
        List of dicts with keys: title, url, snippet.
    """
    resp = requests.get(
        SEARXNG_URL,
        params={"q": query, "format": "json"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()

    results: list[dict] = []
    for item in data.get("results", [])[:num_results]:
        results.append({
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "snippet": item.get("content", ""),
        })

    return results


def fetch_page_content(url: str) -> str:
    """Fetch a URL and extract clean text content.

    Strips HTML tags, scripts, styles, and navigation elements.
    Returns at most MAX_PAGE_CHARS characters.

    Args:
        url: The page URL to fetch.

    Returns:
        Clean text content of the page.
    """
    resp = requests.get(
        url,
        timeout=30,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            )
        },
    )
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "lxml")

    # Remove non-content elements
    for tag in soup(["script", "style", "nav", "header", "footer", "aside",
                     "iframe", "noscript", "form", "button", "svg"]):
        tag.decompose()

    # Try to find the main content area
    main = soup.find("main") or soup.find("article") or soup.find("body")
    if main is None:
        main = soup

    text = main.get_text(separator="\n", strip=True)

    # Collapse multiple blank lines
    lines = [line.strip() for line in text.splitlines()]
    cleaned = "\n".join(line for line in lines if line)

    return cleaned[:MAX_PAGE_CHARS]
