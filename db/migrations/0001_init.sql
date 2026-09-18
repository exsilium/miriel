-- Miriel schema, v1. Applied by `indexer migrate` (packages/indexer/src/migrate.ts).
-- The only templated value is ${EMBEDDING_DIM}, substituted from the shared
-- EMBEDDING_DIM constant so the vector width lives in exactly one place.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE books (
  id                     text PRIMARY KEY,
  title                  text NOT NULL,
  source_book            text NOT NULL,          -- `book` field in the extraction JSON
  pdf_path               text NOT NULL,          -- relative to DATA_DIR
  image_dir              text NOT NULL,          -- relative to DATA_DIR
  image_pattern          text NOT NULL,          -- "{n}" = printed page + offset
  printed_to_pdf_offset  int  NOT NULL,          -- printed + offset = 1-based PDF page
  page_count             int  NOT NULL
);

CREATE TABLE pages (
  book_id     text NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page        int  NOT NULL,                     -- printed page number
  chapter     text,
  region      text,
  page_type   text NOT NULL,
  markdown    text NOT NULL,
  quality     jsonb NOT NULL,
  indexed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, page)
);

CREATE TABLE chunks (
  id            bigserial PRIMARY KEY,
  book_id       text NOT NULL,
  page          int  NOT NULL,
  chunk_idx     int  NOT NULL,
  text          text NOT NULL,                   -- raw chunk text, no heading prefix
  heading_path  text NOT NULL,                   -- "Liurnia > Lenne's Rise > Items"
  token_count   int  NOT NULL,                   -- cl100k estimate of `text`
  embedding     vector(${EMBEDDING_DIM}) NOT NULL,
  -- Heading path is weighted above body text so a heading hit outranks a mention.
  tsv           tsvector GENERATED ALWAYS AS (
                  setweight(to_tsvector('english', heading_path), 'A') ||
                  setweight(to_tsvector('english', text), 'B')
                ) STORED,
  UNIQUE (book_id, page, chunk_idx),
  FOREIGN KEY (book_id, page) REFERENCES pages(book_id, page) ON DELETE CASCADE
);
CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_tsv_gin ON chunks USING gin (tsv);
CREATE INDEX chunks_book_page ON chunks (book_id, page);

CREATE TABLE figures (
  id           bigserial PRIMARY KEY,
  book_id      text NOT NULL,
  page         int  NOT NULL,
  figure_idx   int  NOT NULL,                    -- 1-based, matches [FIGURE n] placeholders
  kind         text NOT NULL,
  description  text NOT NULL,
  labels       text[] NOT NULL DEFAULT '{}',
  legend       text,
  UNIQUE (book_id, page, figure_idx),
  FOREIGN KEY (book_id, page) REFERENCES pages(book_id, page) ON DELETE CASCADE
);

CREATE TABLE entities (
  id             bigserial PRIMARY KEY,
  book_id        text NOT NULL,
  page           int  NOT NULL,
  entity_idx     int  NOT NULL,                  -- position in the page's entities[]
  type           text NOT NULL,
  name           text NOT NULL,                  -- exact as printed
  name_norm      text NOT NULL,                  -- shared normalizeName()
  location       text,
  how_to_obtain  text,
  connects_to    text[] NOT NULL DEFAULT '{}',
  UNIQUE (book_id, page, entity_idx),
  FOREIGN KEY (book_id, page) REFERENCES pages(book_id, page) ON DELETE CASCADE
);
CREATE INDEX entities_name_norm_trgm ON entities USING gin (name_norm gin_trgm_ops);
CREATE INDEX entities_name_norm ON entities (name_norm);
CREATE INDEX entities_type ON entities (type);
CREATE INDEX entities_book_page ON entities (book_id, page);

-- connects_to expanded one row per target, normalized for joining back to entities.name_norm
CREATE TABLE entity_links (
  from_entity   bigint NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_name       text   NOT NULL,
  to_name_norm  text   NOT NULL,
  PRIMARY KEY (from_entity, to_name_norm)
);
CREATE INDEX entity_links_to_name_norm ON entity_links (to_name_norm);
