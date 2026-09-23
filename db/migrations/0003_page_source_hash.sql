-- sha256 of the extraction file a page row was built from; `indexer ingest` skips pages whose hash is
-- unchanged (unless --force), so post-retake re-indexing touches only the changed pages.
ALTER TABLE pages ADD COLUMN source_hash text;
