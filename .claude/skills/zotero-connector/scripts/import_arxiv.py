#!/usr/bin/env python3
"""Import arXiv papers into Zotero via the local connector API.

Usage:
    python import_arxiv.py [OPTIONS] ARXIV_ID [ARXIV_ID ...]

Features:
    - Batch import with progress display
    - Duplicate detection (ZoFiles index → Zotero SQLite → none)
    - Parallel import support
    - Optional collection targeting

Requirements:
    - Python 3.8+
    - Zotero 7/8 running locally (connector on localhost:23119)
    - No third-party dependencies (stdlib only)
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import pathlib
import platform
import random
import re
import sqlite3
import string
import sys
import textwrap
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple


# =============================================================================
# Constants
# =============================================================================

ZOTERO_CONNECTOR_URL = "http://localhost:23119"
ARXIV_API_URL = "http://export.arxiv.org/api/query"
ARXIV_BATCH_SIZE = 20
ARXIV_RATE_LIMIT = 3.0  # seconds between requests
IMPORT_DELAY = 1.0  # seconds between connector calls
MAX_PARALLEL = 5
PDF_DOWNLOAD_TIMEOUT = 60  # seconds for downloading PDF from arXiv

# Atom XML namespaces
NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
    "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
}

# arXiv ID regexes — ported from ZoFiles src/modules/arxiv-id.ts
NEW_STYLE_RE = re.compile(
    r"(?:arXiv[:\s]*)?((?:0[7-9]|[12]\d)(?:0[1-9]|1[0-2])\.\d{4,5})(?:v\d+)?",
    re.IGNORECASE,
)
OLD_STYLE_RE = re.compile(
    r"(?:arXiv[:\s]*)?((?:astro-ph|cond-mat|gr-qc|hep-(?:ex|lat|ph|th)"
    r"|math-ph|nlin|nucl-(?:ex|th)|physics|quant-ph|cs|math|q-bio|q-fin"
    r"|stat|eess)(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?",
    re.IGNORECASE,
)
ARXIV_URL_RE = re.compile(
    r"arxiv\.org/(?:abs|pdf)/([^\s?#]+?)(?:\.pdf)?(?:\?|#|$)", re.IGNORECASE
)
ARXIV_DOI_RE = re.compile(r"10\.48550/arXiv\.(.+)", re.IGNORECASE)
VERSION_RE = re.compile(r"v\d+$")


# =============================================================================
# Data classes
# =============================================================================


class ImportStatus(Enum):
    PENDING = "pending"
    IMPORTED = "imported"
    DUPLICATE = "duplicate"
    FAILED = "failed"
    DRY_RUN = "dry_run"


@dataclass
class ArxivPaper:
    arxiv_id: str  # canonical ID (no version)
    raw_input: str = ""
    title: Optional[str] = None
    authors: List[str] = field(default_factory=list)
    abstract: Optional[str] = None
    categories: List[str] = field(default_factory=list)
    primary_category: Optional[str] = None
    doi: Optional[str] = None
    published: Optional[str] = None
    updated: Optional[str] = None
    journal_ref: Optional[str] = None
    comment: Optional[str] = None
    status: ImportStatus = ImportStatus.PENDING
    error: Optional[str] = None


@dataclass
class ImportResult:
    total: int = 0
    imported: int = 0
    duplicates: int = 0
    failed: int = 0
    papers: List[ArxivPaper] = field(default_factory=list)


# =============================================================================
# arXiv ID normalization
# =============================================================================


def strip_version(arxiv_id: str) -> str:
    """Strip version suffix: '2301.07041v2' → '2301.07041'."""
    return VERSION_RE.sub("", arxiv_id)


def normalize_arxiv_id(raw: str) -> str:
    """Normalize any arXiv ID input to canonical form (no version).

    Supports: bare IDs, versioned IDs, full URLs, arXiv: prefix, DOI form.
    Raises ValueError if not a recognized arXiv ID.
    """
    raw = raw.strip()
    if not raw:
        raise ValueError("Empty input")

    # Try URL form first
    m = ARXIV_URL_RE.search(raw)
    if m:
        extracted = m.group(1)
        return strip_version(extracted)

    # Try DOI form: 10.48550/arXiv.2301.07041
    m = ARXIV_DOI_RE.search(raw)
    if m:
        extracted = m.group(1)
        return strip_version(extracted)

    # Try new-style: 2301.07041 or arXiv:2301.07041
    m = NEW_STYLE_RE.search(raw)
    if m:
        return m.group(1)  # already without version due to regex

    # Try old-style: hep-th/0601001
    m = OLD_STYLE_RE.search(raw)
    if m:
        return m.group(1)

    raise ValueError(f"Not a recognized arXiv ID: {raw}")


# =============================================================================
# arXiv API client
# =============================================================================


class ArxivAPI:
    """Fetches paper metadata from the arXiv API."""

    def __init__(self):
        self._last_request_time = 0.0

    def _rate_limit(self):
        elapsed = time.time() - self._last_request_time
        if elapsed < ARXIV_RATE_LIMIT:
            time.sleep(ARXIV_RATE_LIMIT - elapsed)
        self._last_request_time = time.time()

    def fetch_metadata(self, arxiv_ids: List[str]) -> Dict[str, ArxivPaper]:
        """Batch fetch metadata. Returns dict mapping arxiv_id → ArxivPaper."""
        results: Dict[str, ArxivPaper] = {}

        # Process in batches
        for i in range(0, len(arxiv_ids), ARXIV_BATCH_SIZE):
            batch = arxiv_ids[i : i + ARXIV_BATCH_SIZE]
            self._rate_limit()

            id_list = ",".join(batch)
            url = f"{ARXIV_API_URL}?id_list={urllib.parse.quote(id_list)}&max_results={len(batch)}"

            try:
                req = urllib.request.Request(url)
                req.add_header("User-Agent", "ZoFiles-ArxivImporter/1.0")
                with urllib.request.urlopen(req, timeout=30) as resp:
                    xml_text = resp.read().decode("utf-8")
                batch_results = self._parse_atom(xml_text, batch)
                results.update(batch_results)
            except (urllib.error.URLError, TimeoutError) as e:
                # Mark all papers in batch as failed
                for aid in batch:
                    paper = ArxivPaper(arxiv_id=aid)
                    paper.status = ImportStatus.FAILED
                    paper.error = f"arXiv API error: {e}"
                    results[aid] = paper

        return results

    def _parse_atom(self, xml_text: str, expected_ids: List[str]) -> Dict[str, ArxivPaper]:
        """Parse Atom XML response from arXiv API."""
        results: Dict[str, ArxivPaper] = {}
        root = ET.fromstring(xml_text)

        for entry in root.findall("atom:entry", NS):
            # Extract arXiv ID from <id> element
            id_elem = entry.find("atom:id", NS)
            if id_elem is None or id_elem.text is None:
                continue

            # <id> is like "http://arxiv.org/abs/2301.07041v1"
            id_url = id_elem.text.strip()

            # Check for error entries
            title_elem = entry.find("atom:title", NS)
            if title_elem is not None and title_elem.text and title_elem.text.strip() == "Error":
                # This is an error entry — try to find which ID it corresponds to
                summary = entry.find("atom:summary", NS)
                error_msg = summary.text.strip() if summary is not None and summary.text else "Not found"
                # Error entries have the query URL as <id>, not a paper URL
                # We'll match them below
                continue

            try:
                arxiv_id = normalize_arxiv_id(id_url)
            except ValueError:
                continue

            paper = ArxivPaper(arxiv_id=arxiv_id)

            # Title (normalize whitespace)
            if title_elem is not None and title_elem.text:
                paper.title = " ".join(title_elem.text.split())

            # Authors
            for author in entry.findall("atom:author", NS):
                name_elem = author.find("atom:name", NS)
                if name_elem is not None and name_elem.text:
                    paper.authors.append(name_elem.text.strip())

            # Abstract
            summary = entry.find("atom:summary", NS)
            if summary is not None and summary.text:
                paper.abstract = summary.text.strip()

            # Categories
            primary_cat = entry.find("arxiv:primary_category", NS)
            if primary_cat is not None:
                paper.primary_category = primary_cat.get("term", "")

            for cat in entry.findall("atom:category", NS):
                term = cat.get("term", "")
                if term:
                    paper.categories.append(term)

            # DOI
            doi_elem = entry.find("arxiv:doi", NS)
            if doi_elem is not None and doi_elem.text:
                paper.doi = doi_elem.text.strip()

            # Dates
            pub = entry.find("atom:published", NS)
            if pub is not None and pub.text:
                paper.published = pub.text.strip()

            upd = entry.find("atom:updated", NS)
            if upd is not None and upd.text:
                paper.updated = upd.text.strip()

            # Journal ref
            jref = entry.find("arxiv:journal_ref", NS)
            if jref is not None and jref.text:
                paper.journal_ref = jref.text.strip()

            # Comment
            comment = entry.find("arxiv:comment", NS)
            if comment is not None and comment.text:
                paper.comment = comment.text.strip()

            results[arxiv_id] = paper

        # Mark missing IDs as failed
        for aid in expected_ids:
            if aid not in results:
                paper = ArxivPaper(arxiv_id=aid)
                paper.status = ImportStatus.FAILED
                paper.error = "Not found on arXiv"
                results[aid] = paper

        return results


# =============================================================================
# Duplicate detection
# =============================================================================


class DuplicateDetector:
    """Multi-strategy duplicate detection for arXiv papers in Zotero."""

    def __init__(
        self,
        zofiles_index_path: Optional[str] = None,
        zotero_data_dir: Optional[str] = None,
    ):
        self._zofiles_index_path = zofiles_index_path
        self._zotero_data_dir = zotero_data_dir
        self._existing_ids: Optional[Set[str]] = None
        self._method: Optional[str] = None
        self._count: int = 0

    def load(self) -> bool:
        """Load existing arXiv IDs. Returns True if a source was loaded."""
        # Strategy 1: ZoFiles index
        if self._zofiles_index_path:
            ids = self._load_from_zofiles_index(self._zofiles_index_path)
            if ids is not None:
                self._existing_ids = ids
                self._method = "zofiles_index"
                self._count = len(ids)
                return True

        # Auto-detect ZoFiles index from Zotero prefs
        auto_index = self._find_zofiles_index()
        if auto_index:
            ids = self._load_from_zofiles_index(auto_index)
            if ids is not None:
                self._existing_ids = ids
                self._method = "zofiles_index"
                self._count = len(ids)
                return True

        # Strategy 2: Zotero SQLite
        zotero_dir = self._zotero_data_dir or self._find_zotero_data_dir()
        if zotero_dir:
            db_path = os.path.join(zotero_dir, "zotero.sqlite")
            if os.path.exists(db_path):
                ids = self._load_from_zotero_sqlite(db_path)
                if ids is not None:
                    self._existing_ids = ids
                    self._method = "zotero_sqlite"
                    self._count = len(ids)
                    return True

        return False

    def is_duplicate(self, arxiv_id: str) -> bool:
        if self._existing_ids is None:
            return False
        return strip_version(arxiv_id) in self._existing_ids

    @property
    def method(self) -> Optional[str]:
        return self._method

    @property
    def count(self) -> int:
        return self._count

    def _load_from_zofiles_index(self, path: str) -> Optional[Set[str]]:
        """Read .zofiles-index.json and extract arXiv IDs."""
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            entries = data.get("entries", {})
            ids: Set[str] = set()
            for entry in entries.values():
                aid = entry.get("arxivId", "")
                if aid:
                    ids.add(strip_version(aid))
            return ids
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            return None

    def _load_from_zotero_sqlite(self, db_path: str) -> Optional[Set[str]]:
        """Read Zotero's SQLite database (read-only) for arXiv IDs."""
        try:
            # Use immutable mode — Zotero holds a WAL lock on the DB while
            # running, so ?mode=ro will fail with "database is locked".
            # immutable=1 skips locking entirely (safe for read-only access).
            uri = f"file:{db_path}?immutable=1"
            conn = sqlite3.connect(uri, uri=True, timeout=5)

            ids: Set[str] = set()

            # Query fields: archiveID, DOI, url, extra
            target_fields = ["archiveID", "DOI", "url", "extra"]
            for field_name in target_fields:
                try:
                    cursor = conn.execute(
                        """
                        SELECT idv.value
                        FROM itemData id
                        JOIN itemDataValues idv ON id.valueID = idv.valueID
                        JOIN fields f ON id.fieldID = f.fieldID
                        WHERE f.fieldName = ?
                        """,
                        (field_name,),
                    )
                    for (value,) in cursor:
                        if value:
                            # Try to extract arXiv ID using same logic as ZoFiles
                            m = NEW_STYLE_RE.search(str(value))
                            if m:
                                ids.add(m.group(1))
                                continue
                            m = OLD_STYLE_RE.search(str(value))
                            if m:
                                ids.add(m.group(1))
                except sqlite3.OperationalError:
                    continue

            conn.close()
            return ids if ids else None
        except (sqlite3.OperationalError, sqlite3.DatabaseError):
            return None

    def _find_zotero_data_dir(self) -> Optional[str]:
        """Auto-detect Zotero data directory."""
        # Check environment variable
        env_dir = os.environ.get("ZOTERO_DATA_DIR")
        if env_dir and os.path.isdir(env_dir):
            return env_dir

        # Platform defaults — check common locations
        home = pathlib.Path.home()
        candidates = [
            home / "Zotero",
            home / "Local" / "Zotero",
            home / "Documents" / "Zotero",
        ]
        # macOS: also check Application Support
        if platform.system() == "Darwin":
            candidates.append(
                home / "Library" / "Application Support" / "Zotero" / "Profiles"
            )

        for path in candidates:
            if path.is_dir() and (path / "zotero.sqlite").exists():
                return str(path)

        return None

    def _find_zofiles_index(self) -> Optional[str]:
        """Try to find ZoFiles index by reading Zotero prefs."""
        zotero_dir = self._zotero_data_dir or self._find_zotero_data_dir()
        if not zotero_dir:
            return None

        # Try to find the ZoFiles export root from Zotero prefs
        prefs_path = os.path.join(zotero_dir, "prefs.js")
        if not os.path.exists(prefs_path):
            return None

        try:
            with open(prefs_path, "r", encoding="utf-8") as f:
                content = f.read()
            # Look for: user_pref("extensions.zotero.zofiles.exportRoot", "/path/...");
            m = re.search(
                r'user_pref\("extensions\.zotero\.zofiles\.exportRoot",\s*"([^"]+)"\)',
                content,
            )
            if m:
                export_root = m.group(1)
                index_path = os.path.join(export_root, ".zofiles-index.json")
                if os.path.exists(index_path):
                    return index_path
        except OSError:
            pass

        return None


# =============================================================================
# Zotero Connector
# =============================================================================


class ZoteroConnector:
    """Communicates with Zotero's local connector HTTP server."""

    def __init__(self, base_url: str = ZOTERO_CONNECTOR_URL, zotero_data_dir: Optional[str] = None):
        self.base_url = base_url
        self._zotero_data_dir = zotero_data_dir

    def ping(self) -> bool:
        """Check if Zotero is running."""
        try:
            req = urllib.request.Request(f"{self.base_url}/connector/ping")
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status == 200
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            return False

    def get_collections(self) -> List[dict]:
        """Fetch all collections via getSelectedCollection endpoint."""
        try:
            data = json.dumps({}).encode("utf-8")
            req = urllib.request.Request(
                f"{self.base_url}/connector/getSelectedCollection",
                data=data,
                method="POST",
            )
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                # The targets array contains all collections as a flat list
                targets = result.get("targets", [])
                # Filter to only collection targets (id starts with 'C')
                return [t for t in targets if t.get("id", "").startswith("C")]
        except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
            return []

    def resolve_collection(self, name_or_key: str) -> Optional[Tuple[str, str]]:
        """Resolve a collection name/key to (id, name). Returns None if not found.

        Supports:
          - Exact connector ID: "C156" or "156"
          - Exact name (case-insensitive): "Agent"
          - Path with "/" for disambiguation: "Agent/Agent", "By Topic/Agent"
          - Substring match (only if unambiguous): "CoAgent" → "CodeAgent"
        """
        collections = self.get_collections()
        if not collections:
            return None

        # Exact id match (e.g., "C156" or just the number "156")
        for c in collections:
            cid = c.get("id", "")
            if cid == name_or_key or cid == f"C{name_or_key}":
                return (cid, c.get("name", ""))

        # Build full paths for each collection from the flat level-ordered list.
        # The list is in pre-order traversal; each item has a "level" field (1-based).
        # We maintain a stack of ancestor names to reconstruct paths.
        ancestor_stack: List[str] = []  # stack of (name) at each level
        collection_paths: List[Tuple[str, dict]] = []  # (full_path, collection)

        for c in collections:
            level = c.get("level", 1)
            name = c.get("name", "")
            # Trim stack to parent level
            ancestor_stack = ancestor_stack[: level - 1]
            ancestor_stack.append(name)
            full_path = "/".join(ancestor_stack)
            collection_paths.append((full_path, c))

        is_path_query = "/" in name_or_key

        if is_path_query:
            # Path match: compare the query as a suffix of the full path
            lower_query = name_or_key.lower()
            query_parts = [p.strip() for p in lower_query.split("/")]

            # Exact suffix match (e.g. "Agent/Agent" matches "By Topic/Agent/Agent")
            for full_path, c in collection_paths:
                path_parts = [p.lower() for p in full_path.split("/")]
                if len(path_parts) >= len(query_parts):
                    if path_parts[-len(query_parts) :] == query_parts:
                        return (c["id"], c["name"])

            # Substring match on full path — only if unambiguous
            matches = [
                (fp, c)
                for fp, c in collection_paths
                if lower_query in fp.lower()
            ]
            if len(matches) == 1:
                return (matches[0][1]["id"], matches[0][1]["name"])

            return None

        # Simple name match (no "/" in query)
        lower_name = name_or_key.lower()

        # Exact name match (case-insensitive) — only if unambiguous
        exact_matches = [c for c in collections if c.get("name", "").lower() == lower_name]
        if len(exact_matches) == 1:
            return (exact_matches[0]["id"], exact_matches[0]["name"])

        # Substring match (case-insensitive) — only if unambiguous
        sub_matches = [c for c in collections if lower_name in c.get("name", "").lower()]
        if len(sub_matches) == 1:
            return (sub_matches[0]["id"], sub_matches[0]["name"])

        # Ambiguous — show candidates
        if exact_matches or sub_matches:
            candidates = exact_matches or sub_matches
            print(
                f'WARNING: "{name_or_key}" matches {len(candidates)} collections. '
                f"Use a path to disambiguate:",
                file=sys.stderr,
            )
            for fp, c in collection_paths:
                if c in candidates:
                    print(f'  --collection "{fp}" ({c["id"]})', file=sys.stderr)
            print("", file=sys.stderr)

        return None

    def update_session(self, session_id: str, target_id: str) -> bool:
        """Move saved items to a target collection via /connector/updateSession.

        Zotero's saveItems endpoint ignores the 'collections' field in item
        payloads — it always saves to the currently selected collection in
        the UI. To place items in a specific collection we must call
        updateSession *after* saveItems, which moves the already-saved items.

        Args:
            session_id: The session ID used in the saveItems call.
            target_id: Connector-format target ID (e.g. 'C156' for collection 156).
        """
        payload = json.dumps({
            "sessionID": session_id,
            "target": target_id,
        }).encode("utf-8")

        try:
            req = urllib.request.Request(
                f"{self.base_url}/connector/updateSession",
                data=payload,
                method="POST",
            )
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status in (200, 201)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError):
            return False

    def save_item(
        self,
        paper: ArxivPaper,
        collection_target: Optional[str] = None,
    ) -> bool:
        """Import a paper via /connector/saveItems + /connector/saveAttachment.

        This is a multi-step process:
        1. POST /connector/saveItems — saves metadata (goes to currently selected
           collection in Zotero's UI, since the connector ignores the 'collections'
           field in the item payload).
        2. POST /connector/updateSession — if a target collection is specified,
           moves the item to that collection.
        3. Download PDF from arXiv, then POST /connector/saveAttachment — streams
           the PDF binary to Zotero, linking it to the parent item via session.
        """
        # Generate unique session & item IDs (matches Zotero.Utilities.randomString())
        session_id = self._random_string(32)
        connector_item_id = self._random_string(32)

        item = self._build_item(paper, session_id=session_id, connector_item_id=connector_item_id)
        payload = json.dumps(item).encode("utf-8")

        # Step 1: Save metadata
        try:
            req = urllib.request.Request(
                f"{self.base_url}/connector/saveItems",
                data=payload,
                method="POST",
            )
            req.add_header("Content-Type", "application/json")
            with urllib.request.urlopen(req, timeout=30) as resp:
                if resp.status not in (200, 201):
                    paper.error = f"saveItems returned {resp.status}"
                    return False
        except urllib.error.HTTPError as e:
            paper.error = f"Connector HTTP {e.code}: {e.reason}"
            return False
        except (urllib.error.URLError, TimeoutError) as e:
            paper.error = f"Connector error: {e}"
            return False

        # Step 2: Move to target collection via updateSession
        if collection_target:
            if not self.update_session(session_id, collection_target):
                paper.error = (
                    f"updateSession failed for target {collection_target} "
                    f"(metadata saved to default collection)"
                )
                # Not fatal — item was created, just in wrong collection

        # Step 3: Download PDF from arXiv and push to Zotero
        pdf_url = f"https://arxiv.org/pdf/{paper.arxiv_id}"
        try:
            pdf_data = self._download_pdf(pdf_url)
        except Exception as e:
            # Metadata saved successfully but PDF download failed — not fatal
            paper.error = f"PDF download failed (metadata saved): {e}"
            return True  # item was created, just missing PDF

        if pdf_data:
            try:
                self._save_attachment(
                    session_id=session_id,
                    parent_item_id=connector_item_id,
                    title="arXiv Full Text PDF",
                    url=pdf_url,
                    content_type="application/pdf",
                    data=pdf_data,
                )
            except Exception as e:
                # Metadata saved but attachment upload failed — not fatal
                paper.error = f"PDF upload failed (metadata saved): {e}"

        return True

    @staticmethod
    def _random_string(length: int = 32) -> str:
        """Generate a random alphanumeric string (matches Zotero.Utilities.randomString)."""
        chars = string.ascii_letters + string.digits
        return "".join(random.choices(chars, k=length))

    def _download_pdf(self, url: str) -> Optional[bytes]:
        """Download PDF from a URL. Returns bytes or None on failure."""
        req = urllib.request.Request(url)
        req.add_header("User-Agent", "Mozilla/5.0 (Zotero)")
        with urllib.request.urlopen(req, timeout=PDF_DOWNLOAD_TIMEOUT) as resp:
            if resp.status != 200:
                return None
            return resp.read()

    def _save_attachment(
        self,
        session_id: str,
        parent_item_id: str,
        title: str,
        url: str,
        content_type: str,
        data: bytes,
    ) -> bool:
        """Push attachment binary to Zotero via /connector/saveAttachment.

        Metadata is passed in the X-Metadata header (JSON). The request body
        is the raw file bytes. This mirrors how the browser Connector works.
        """
        metadata = json.dumps({
            "sessionID": session_id,
            "parentItemID": parent_item_id,
            "title": title,
            "url": url,
        })

        req = urllib.request.Request(
            f"{self.base_url}/connector/saveAttachment",
            data=data,
            method="POST",
        )
        req.add_header("Content-Type", content_type)
        req.add_header("Content-Length", str(len(data)))
        req.add_header("X-Metadata", metadata)

        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status in (200, 201)

    def _build_item(
        self,
        paper: ArxivPaper,
        session_id: Optional[str] = None,
        connector_item_id: Optional[str] = None,
    ) -> dict:
        """Construct Zotero-compatible item JSON."""
        # Determine item type
        item_type = "preprint"
        if paper.journal_ref and paper.doi:
            item_type = "journalArticle"

        # Build creators
        creators = []
        for author in paper.authors:
            parts = author.rsplit(" ", 1)
            if len(parts) == 2:
                creators.append({
                    "firstName": parts[0],
                    "lastName": parts[1],
                    "creatorType": "author",
                })
            else:
                creators.append({
                    "firstName": "",
                    "lastName": author,
                    "creatorType": "author",
                })

        # Build extra field
        extra_parts = [f"arXiv:{paper.arxiv_id}"]
        if paper.primary_category:
            extra_parts[0] += f" [{paper.primary_category}]"
        if paper.comment:
            extra_parts.append(paper.comment)
        extra = "\n".join(extra_parts)

        # Format date
        date = ""
        if paper.published:
            date = paper.published[:10]  # "2023-01-17"

        # Build tags from categories
        tags = [{"tag": cat} for cat in paper.categories]

        # Build attachments — kept in payload for compatibility, but Zotero's
        # saveItems uses ATTACHMENT_MODE_IGNORE so these won't be downloaded.
        # The actual PDF is pushed separately via /connector/saveAttachment.
        attachments = [
            {
                "title": "arXiv Full Text PDF",
                "mimeType": "application/pdf",
                "url": f"https://arxiv.org/pdf/{paper.arxiv_id}",
            }
        ]

        item = {
            "sessionID": session_id or self._random_string(32),
            "items": [
                {
                    "id": connector_item_id or self._random_string(32),
                    "itemType": item_type,
                    "title": paper.title or f"arXiv:{paper.arxiv_id}",
                    "creators": creators,
                    "abstractNote": paper.abstract or "",
                    "date": date,
                    "url": f"https://arxiv.org/abs/{paper.arxiv_id}",
                    "DOI": paper.doi or "",
                    "archiveID": f"arXiv:{paper.arxiv_id}",
                    "repository": "arXiv",
                    "libraryCatalog": "arXiv.org",
                    "extra": extra,
                    "tags": tags,
                    "attachments": attachments,
                    "notes": [],
                }
            ],
            "uri": f"https://arxiv.org/abs/{paper.arxiv_id}",
        }

        return item


# =============================================================================
# Progress display
# =============================================================================


class ProgressDisplay:
    """Thread-safe progress display to stderr."""

    SYMBOLS = {
        ImportStatus.IMPORTED: "\033[32m\u2713\033[0m",   # ✓ green
        ImportStatus.DUPLICATE: "\033[33m\u2298\033[0m",   # ⊘ yellow
        ImportStatus.FAILED: "\033[31m\u2717\033[0m",      # ✗ red
        ImportStatus.DRY_RUN: "\033[36m\u25c7\033[0m",     # ◇ cyan
        ImportStatus.PENDING: " ",
    }

    LABELS = {
        ImportStatus.IMPORTED: "Imported",
        ImportStatus.DUPLICATE: "Duplicate",
        ImportStatus.FAILED: "Failed",
        ImportStatus.DRY_RUN: "Would import",
    }

    def __init__(self, total: int, dry_run: bool = False, ignore_duplicates: bool = False):
        self._total = total
        self._current = 0
        self._lock = threading.Lock()
        self._dry_run = dry_run
        self._ignore_duplicates = ignore_duplicates

    def header(
        self,
        connected: bool,
        dedup_method: Optional[str],
        dedup_count: int,
        collection: Optional[Tuple[str, str]],
    ):
        """Print header section."""
        title = "ZoFiles arXiv Importer"
        if self._dry_run:
            title += " (DRY RUN)"
        self._err(f"\n{title}")
        self._err("\u2501" * 42)

        # Connection status
        if connected:
            self._err("Zotero:     \033[32m\u2713\033[0m Connected (localhost:23119)")
        else:
            self._err("Zotero:     \033[31m\u2717\033[0m Not connected")

        # Duplicate detection status
        if dedup_method == "zofiles_index":
            self._err(f"Duplicates: \033[32m\u2713\033[0m Using ZoFiles index ({dedup_count} papers)")
        elif dedup_method == "zotero_sqlite":
            self._err(f"Duplicates: \033[32m\u2713\033[0m Using Zotero SQLite ({dedup_count} papers)")
        else:
            self._err("Duplicates: \033[33m\u26a0\033[0m No detection source available")

        # Collection
        if collection:
            key, name = collection
            self._err(f'Collection: \033[32m\u2713\033[0m "{name}" ({key})')

        self._err("")

    def update(self, paper: ArxivPaper):
        """Print a progress line for a paper."""
        with self._lock:
            self._current += 1
            sym = self.SYMBOLS.get(paper.status, " ")
            label = self.LABELS.get(paper.status, "Unknown")

            # Truncate title for display
            title = paper.title or paper.error or "Unknown"
            if len(title) > 50:
                title = title[:47] + "..."

            self._err(
                f"[{self._current}/{self._total}] {sym} {label:12s} "
                f"{paper.arxiv_id} \u2014 \"{title}\""
            )

    def summary(self, result: ImportResult):
        """Print final summary."""
        self._err("")
        self._err("\u2501" * 42)

        parts = []
        if self._dry_run:
            would_import = sum(
                1 for p in result.papers if p.status == ImportStatus.DRY_RUN
            )
            parts.append(f"\033[36m\u25c7\033[0m Would import: {would_import}")
        else:
            parts.append(f"\033[32m\u2713\033[0m Imported: {result.imported}")

        if not self._ignore_duplicates:
            parts.append(f"\033[33m\u2298\033[0m Duplicates: {result.duplicates}")
        parts.append(f"\033[31m\u2717\033[0m Failed: {result.failed}")

        self._err("  " + "  ".join(parts))
        self._err("\u2501" * 42)

    def _err(self, msg: str):
        print(msg, file=sys.stderr, flush=True)


# =============================================================================
# Main
# =============================================================================


def print_collections(connector: ZoteroConnector) -> None:
    """Print all Zotero collections with hierarchy."""
    collections = connector.get_collections()
    if not collections:
        print("No collections found (or Zotero not connected).", file=sys.stderr)
        return

    print(f"\nZotero Collections ({len(collections)} total):", file=sys.stderr)
    print("━" * 50, file=sys.stderr)
    for c in collections:
        indent = "  " * c.get("level", 1)
        cid = c.get("id", "")
        name = c.get("name", "")
        print(f"  {indent}{cid:6s}  {name}", file=sys.stderr)
    print("━" * 50, file=sys.stderr)
    print(
        '\nUsage: --collection "Name" or --collection C123',
        file=sys.stderr,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import arXiv papers into Zotero via local connector API.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Input formats:
              2301.07041                  new-style arXiv ID
              2301.07041v2                with version (stripped for dedup)
              hep-th/0601001              old-style arXiv ID
              https://arxiv.org/abs/...   full URL
              arXiv:2301.07041            prefixed form

            Examples:
              %(prog)s --list-collections
              %(prog)s 2301.07041
              %(prog)s --collection "LLM Papers" 2301.07041 2310.06825
              %(prog)s --dry-run 2301.07041 2310.06825 1706.03762
              %(prog)s --parallel 3 --force ID1 ID2 ID3 ID4 ID5
        """),
    )
    parser.add_argument(
        "arxiv_ids",
        nargs="*",
        metavar="ARXIV_ID",
        help="arXiv IDs to import (any format)",
    )
    parser.add_argument(
        "--list-collections",
        action="store_true",
        help="List all Zotero collections with IDs and exit",
    )
    parser.add_argument(
        "--collection",
        metavar="NAME",
        help="Target collection (fuzzy name match or connector ID like C123)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Check duplicates and fetch metadata without importing",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Import even if duplicates are detected",
    )
    parser.add_argument(
        "--ignore-duplicates",
        action="store_true",
        help="Silently skip duplicates without showing them in progress or output",
    )
    parser.add_argument(
        "--parallel",
        type=int,
        default=1,
        metavar="N",
        help=f"Number of parallel imports (default: 1, max: {MAX_PARALLEL})",
    )
    parser.add_argument(
        "--zofiles-index",
        metavar="PATH",
        help="Path to .zofiles-index.json for duplicate detection",
    )
    parser.add_argument(
        "--zotero-data",
        metavar="DIR",
        help="Path to Zotero data directory (default: auto-detect)",
    )
    return parser.parse_args()


def import_single_paper(
    paper: ArxivPaper,
    connector: ZoteroConnector,
    collection_target: Optional[str],
    progress: ProgressDisplay,
    dry_run: bool,
    import_lock: threading.Lock,
) -> ArxivPaper:
    """Import a single paper (called from main or thread pool)."""
    if paper.status == ImportStatus.FAILED:
        # Already failed during metadata fetch
        progress.update(paper)
        return paper

    if dry_run:
        paper.status = ImportStatus.DRY_RUN
        progress.update(paper)
        return paper

    # Throttle connector calls
    with import_lock:
        time.sleep(IMPORT_DELAY)

    success = connector.save_item(paper, collection_target)
    if success:
        paper.status = ImportStatus.IMPORTED
    else:
        paper.status = ImportStatus.FAILED
        if not paper.error:
            paper.error = "Connector returned error"

    progress.update(paper)
    return paper


def main():
    args = parse_args()

    connector = ZoteroConnector(zotero_data_dir=args.zotero_data)

    # ── List collections and exit ──
    if args.list_collections:
        if not connector.ping():
            print(
                "ERROR: Zotero is not running. Please start Zotero and try again.",
                file=sys.stderr,
            )
            sys.exit(1)
        print_collections(connector)
        sys.exit(0)

    # ── Require at least one arXiv ID for import ──
    if not args.arxiv_ids:
        print(
            "ERROR: No arXiv IDs provided. Use --list-collections or provide ARXIV_IDs.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Clamp parallel
    parallel = max(1, min(args.parallel, MAX_PARALLEL))
    arxiv_api = ArxivAPI()

    # ── Step 1: Normalize IDs ──
    papers: List[ArxivPaper] = []
    invalid_ids: List[Tuple[str, str]] = []
    seen: Set[str] = set()

    for raw_id in args.arxiv_ids:
        try:
            canonical = normalize_arxiv_id(raw_id)
            if canonical in seen:
                continue  # skip duplicate input
            seen.add(canonical)
            p = ArxivPaper(arxiv_id=canonical, raw_input=raw_id)
            papers.append(p)
        except ValueError as e:
            invalid_ids.append((raw_id, str(e)))

    if not papers and invalid_ids:
        print("ERROR: No valid arXiv IDs provided.", file=sys.stderr)
        for raw, err in invalid_ids:
            print(f"  - {raw}: {err}", file=sys.stderr)
        sys.exit(1)

    total_count = len(papers) + len(invalid_ids)

    # ── Step 2: Ping Zotero ──
    connected = connector.ping()
    if not connected and not args.dry_run:
        print(
            "ERROR: Zotero is not running. Please start Zotero and try again.",
            file=sys.stderr,
        )
        sys.exit(1)

    # ── Step 3: Duplicate detection ──
    detector = DuplicateDetector(
        zofiles_index_path=args.zofiles_index,
        zotero_data_dir=args.zotero_data,
    )
    detector.load()

    # ── Step 4: Resolve collection ──
    collection_info: Optional[Tuple[str, str]] = None
    collection_target: Optional[str] = None  # connector ID like "C156"
    if args.collection:
        if connected:
            collection_info = connector.resolve_collection(args.collection)
            if collection_info:
                # Use the connector ID (e.g. "C156") directly — updateSession
                # expects this format, not the 8-char Zotero key
                collection_target = collection_info[0]
            else:
                print(
                    f'ERROR: Collection "{args.collection}" not found.',
                    file=sys.stderr,
                )
                # List available collections
                collections = connector.get_collections()
                if collections:
                    print("\nAvailable collections:", file=sys.stderr)
                    for c in collections[:20]:
                        indent = "  " * c.get("level", 1)
                        print(f'  {indent}"{c.get("name", "")}" ({c.get("id", "")})', file=sys.stderr)
                    if len(collections) > 20:
                        print(f"  ... and {len(collections) - 20} more", file=sys.stderr)
                sys.exit(1)
        elif args.dry_run:
            print(
                f'WARNING: Cannot resolve collection "{args.collection}" (Zotero not running).',
                file=sys.stderr,
            )

    # ── Step 5: Display header ──
    progress = ProgressDisplay(total=len(papers) + len(invalid_ids), dry_run=args.dry_run, ignore_duplicates=args.ignore_duplicates)
    progress.header(connected, detector.method, detector.count, collection_info)

    # ── Step 6: Report invalid IDs ──
    result = ImportResult(total=total_count)

    for raw, err in invalid_ids:
        p = ArxivPaper(arxiv_id=raw, raw_input=raw)
        p.status = ImportStatus.FAILED
        p.error = err
        result.failed += 1
        result.papers.append(p)
        progress.update(p)

    # ── Step 7: Check duplicates ──
    to_fetch: List[ArxivPaper] = []
    ignored_duplicates = 0
    for paper in papers:
        if not args.force and detector.is_duplicate(paper.arxiv_id):
            if args.ignore_duplicates:
                # Silently skip — don't display, don't count, don't add to result
                ignored_duplicates += 1
            else:
                paper.status = ImportStatus.DUPLICATE
                paper.title = f"(existing in {detector.method})"
                result.duplicates += 1
                result.papers.append(paper)
                progress.update(paper)
        else:
            to_fetch.append(paper)

    # Adjust progress total to exclude silently ignored duplicates
    if ignored_duplicates > 0:
        progress._total -= ignored_duplicates
        result.total -= ignored_duplicates

    # ── Step 8: Fetch metadata ──
    if to_fetch:
        fetch_ids = [p.arxiv_id for p in to_fetch]
        print("Fetching metadata from arXiv API...", file=sys.stderr, flush=True)
        metadata = arxiv_api.fetch_metadata(fetch_ids)

        for paper in to_fetch:
            fetched = metadata.get(paper.arxiv_id)
            if fetched:
                paper.title = fetched.title
                paper.authors = fetched.authors
                paper.abstract = fetched.abstract
                paper.categories = fetched.categories
                paper.primary_category = fetched.primary_category
                paper.doi = fetched.doi
                paper.published = fetched.published
                paper.updated = fetched.updated
                paper.journal_ref = fetched.journal_ref
                paper.comment = fetched.comment
                if fetched.status == ImportStatus.FAILED:
                    paper.status = ImportStatus.FAILED
                    paper.error = fetched.error

        print("", file=sys.stderr, flush=True)

    # ── Step 9: Import ──
    to_import = [p for p in to_fetch if p.status != ImportStatus.FAILED]
    failed_fetch = [p for p in to_fetch if p.status == ImportStatus.FAILED]

    # Report fetch failures
    for paper in failed_fetch:
        result.failed += 1
        result.papers.append(paper)
        progress.update(paper)

    import_lock = threading.Lock()

    if to_import:
        if parallel > 1 and len(to_import) > 1:
            # Parallel import
            with concurrent.futures.ThreadPoolExecutor(max_workers=parallel) as executor:
                futures = [
                    executor.submit(
                        import_single_paper,
                        paper, connector, collection_target, progress,
                        args.dry_run, import_lock,
                    )
                    for paper in to_import
                ]
                for future in concurrent.futures.as_completed(futures):
                    paper = future.result()
                    result.papers.append(paper)
                    if paper.status == ImportStatus.IMPORTED:
                        result.imported += 1
                    elif paper.status == ImportStatus.FAILED:
                        result.failed += 1
        else:
            # Sequential import
            for paper in to_import:
                import_single_paper(
                    paper, connector, collection_target, progress,
                    args.dry_run, import_lock,
                )
                result.papers.append(paper)
                if paper.status == ImportStatus.IMPORTED:
                    result.imported += 1
                elif paper.status == ImportStatus.FAILED:
                    result.failed += 1
                elif paper.status == ImportStatus.DRY_RUN:
                    pass  # counted in summary display

    # ── Step 10: Summary ──
    progress.summary(result)

    # ── Step 11: JSON output ──
    status = "success"
    if args.dry_run:
        status = "dry_run"
    elif result.failed > 0 and result.imported > 0:
        status = "partial"
    elif result.failed > 0 and result.imported == 0:
        status = "failed"

    output = {
        "status": status,
        "imported": [
            {"id": p.arxiv_id, "title": p.title}
            for p in result.papers
            if p.status == ImportStatus.IMPORTED
        ],
        "failed": [
            {"id": p.arxiv_id, "error": p.error}
            for p in result.papers
            if p.status == ImportStatus.FAILED
        ],
        "would_import": [
            {"id": p.arxiv_id, "title": p.title}
            for p in result.papers
            if p.status == ImportStatus.DRY_RUN
        ],
        "collection": collection_target,
        "detection_method": detector.method,
    }
    if not args.ignore_duplicates:
        output["duplicates"] = [
            {"id": p.arxiv_id, "title": p.title}
            for p in result.papers
            if p.status == ImportStatus.DUPLICATE
        ]
    print(json.dumps(output, indent=2, ensure_ascii=False))

    # Exit code
    if result.failed > 0 and result.imported == 0 and not args.dry_run:
        sys.exit(1 if len(to_import) == 0 and len(invalid_ids) > 0 else 2)
    elif result.failed > 0:
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
