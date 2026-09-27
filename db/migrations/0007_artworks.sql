-- Art books (docs/build-spec-artbooks.md §6). An art book is a books row with kind 'artbook'; its "page" number is
-- the 1-based PDF page (one spread), printed_to_pdf_offset is 0 and `spread` maps it to printed folios:
-- {"pdfPage": 2, "leftFolio": 2} = PDF page p >= 2 shows folios 2 + 2(p - 2) and the next one.
ALTER TABLE books ADD COLUMN kind text NOT NULL DEFAULT 'guide' CHECK (kind IN ('guide', 'artbook'));
ALTER TABLE books ADD COLUMN spread jsonb;

-- One row per labelled spread (out/<art id>/sNNNN.json + its _overrides.json entry).
CREATE TABLE art_spreads (
  book_id             text NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  pdf_page            int  NOT NULL,
  folios              int[] NOT NULL DEFAULT '{}',
  contents            jsonb NOT NULL DEFAULT '[]',   -- [{chapter, section, section_ja, region}]
  section_heading_ja  text,
  notes               text,
  source_hash         text NOT NULL,                  -- sha256 of the label file + the spread's overrides
  image_sha256        text,                           -- sha256 of the spread JPEG: imageVersion / crop cache key
  indexed_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (book_id, pdf_page)
);

CREATE TABLE artworks (
  id            bigserial PRIMARY KEY,
  book_id       text NOT NULL,
  pdf_page      int  NOT NULL,
  art_idx       int  NOT NULL,                  -- 1-based position in the spread's artworks (after overrides)
  bbox          real[] NOT NULL,                -- [x0, y0, x1, y1] as fractions of the spread
  kind          text NOT NULL,
  caption_ja    text,
  names         jsonb NOT NULL DEFAULT '[]',    -- [{name, source, verified, entity, match}]
  name_norms    text[] NOT NULL DEFAULT '{}',   -- normalizeName() of every name
  entity_norms  text[] NOT NULL DEFAULT '{}',   -- normalizeName() of the guide spelling of every verified name
  confidence    text NOT NULL,
  description   text NOT NULL,
  section       text,                           -- contents section (or chapter) of the spread
  region        text,
  search_text   text NOT NULL,                  -- what is embedded: names, kind, section, description
  embedding     vector(${EMBEDDING_DIM}) NOT NULL,
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED,
  UNIQUE (book_id, pdf_page, art_idx),
  FOREIGN KEY (book_id, pdf_page) REFERENCES art_spreads(book_id, pdf_page) ON DELETE CASCADE
);
CREATE INDEX artworks_name_norms ON artworks USING gin (name_norms);
CREATE INDEX artworks_entity_norms ON artworks USING gin (entity_norms);
CREATE INDEX artworks_tsv ON artworks USING gin (tsv);
CREATE INDEX artworks_embedding_hnsw ON artworks USING hnsw (embedding vector_cosine_ops);
