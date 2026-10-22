"""Manage ChromaDB vector store for document section search."""

import logging

logger = logging.getLogger(__name__)


class RetrievalService:
    """Manages ChromaDB vector store for document search."""

    def __init__(self, persist_dir: str):
        self._available = False
        self._collection = None
        try:
            import chromadb

            self._client = chromadb.PersistentClient(path=persist_dir)
            self._collection = self._client.get_or_create_collection(
                name="brihaspati_docs",
                metadata={"hnsw:space": "cosine"},
            )
            self._available = True
        except Exception:
            logger.warning(
                "ChromaDB not available — retrieval will return empty results. "
                "Install with: pip install chromadb"
            )

    @property
    def available(self) -> bool:
        return self._available

    def add_document_sections(self, document_id: int, sections: list[dict]) -> int:
        """Embed and store document sections. Returns count added."""
        if not self._available or not sections:
            return 0

        ids = []
        documents = []
        metadatas = []

        for idx, sec in enumerate(sections):
            content = sec.get("content", "").strip()
            if not content:
                continue
            doc_key = f"doc{document_id}_sec{idx}"
            ids.append(doc_key)
            documents.append(content[:8000])  # cap to avoid token limits
            metadatas.append({
                "document_id": document_id,
                "subject_id": sec.get("subject_id"),
                "section_index": idx,
                "page": sec.get("page", 0),
                "title": sec.get("title", "")[:200],
            })

        if not ids:
            return 0

        self._collection.upsert(ids=ids, documents=documents, metadatas=metadatas)
        return len(ids)

    def search(
        self,
        query: str,
        subject_id: int = None,
        document_ids: list[int] = None,
        top_k: int = 5,
    ) -> list[dict]:
        """Search the vector store. Returns list of matching sections."""
        if not self._available:
            return []

        where = None
        # Handle subject_id filtering specifically
        if subject_id:
            where = {"subject_id": subject_id}

        # Handle document_ids filtering
        doc_where = None
        if document_ids and len(document_ids) == 1:
            doc_where = {"document_id": document_ids[0]}
        elif document_ids and len(document_ids) > 1:
            doc_where = {"document_id": {"$in": document_ids}}

        if doc_where:
            if where:
                where = {"$and": [where, doc_where]}
            else:
                where = doc_where

        try:
            results = self._collection.query(
                query_texts=[query],
                n_results=min(top_k, max(self._collection.count(), 1)),
                where=where if where else None,
            )
        except Exception as e:
            logger.error("ChromaDB query failed: %s", e)
            return []

        hits = []
        if results and results.get("documents"):
            docs = results["documents"][0]
            metas = results["metadatas"][0] if results.get("metadatas") else [{}] * len(docs)
            dists = results["distances"][0] if results.get("distances") else [0.0] * len(docs)
            for doc, meta, dist in zip(docs, metas, dists):
                hits.append({
                    "content": doc,
                    "metadata": meta,
                    "score": 1.0 - dist,  # cosine distance → similarity
                })

        return hits

    def delete_document(self, document_id: int) -> None:
        """Remove all sections for a given document."""
        if not self._available:
            return
        try:
            # Get IDs matching this document
            results = self._collection.get(
                where={"document_id": document_id},
            )
            if results and results["ids"]:
                self._collection.delete(ids=results["ids"])
        except Exception as e:
            logger.error("Failed to delete document %d from index: %s", document_id, e)
