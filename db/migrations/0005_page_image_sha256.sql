-- sha256 of the page photo (DATA_DIR/<imageDir>/<imagePattern>), filled by `indexer ingest` for every page it
-- sees (also pages whose extraction is unchanged) and so refreshed by each retake's ingest. The api serves its
-- prefix as imageVersion; the web client appends it as ?v= to image and thumbnail URLs so a replaced photo is a
-- new cache entry while `immutable` stays true (docs/build-spec-retakes.md §5). Separate from source_hash,
-- which hashes the extraction JSON.
ALTER TABLE pages ADD COLUMN image_sha256 text;
