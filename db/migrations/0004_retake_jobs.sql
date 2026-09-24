-- Page retake jobs (docs/build-spec-retakes.md §4). The api inserts and confirms jobs; the retake worker
-- validates, runs and reports them. One row per photo (or per rollback); photos uploaded together share a
-- batch_id and are run as one retake (one PDF write) when confirmed together. txn_id is the id of the
-- retake journal under DATA_DIR/_versions/retakes/<book>/, which lets a restarted worker resume the job.
--
-- status: uploaded -> validated | rejected -> confirmed -> running -> done | failed -> (rolled_back)
--         uploaded / validated / rejected / confirmed / failed (PDF not yet replaced) -> discarded
-- stage:  the step of scripts/retake.py in progress (validate, stage, build, splice, commit_pdf, ...)

CREATE TABLE retake_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id       text NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  page          int,                        -- printed page; NULL until validation identifies it from the folio
  kind          text NOT NULL DEFAULT 'retake' CHECK (kind IN ('retake', 'rollback')),
  status        text NOT NULL DEFAULT 'uploaded'
                CHECK (status IN ('uploaded', 'validated', 'rejected', 'confirmed', 'running', 'done', 'failed',
                                  'rolled_back', 'discarded')),
  stage         text,
  message       text,                       -- one line: the latest progress or why the job waits
  upload_path   text,                       -- relative to the uploads volume (UPLOAD_DIR)
  upload_name   text,                       -- file name as uploaded
  image_sha256  text,                       -- of the normalised JPEG that will replace the page photo
  folio_check   jsonb,                      -- {folio, match, errors[], warnings[], notes[]}
  estimate_usd  numeric(8, 4),
  cost_usd      numeric(8, 4),
  before        jsonb,                      -- quality summary of the page before / after the retake
  after         jsonb,
  error         text,
  pdf_committed boolean NOT NULL DEFAULT false,  -- the book PDF was replaced: a failed job can only be resumed
  txn_id        text,
  batch_id      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX retake_jobs_status_idx ON retake_jobs (status, created_at);
CREATE INDEX retake_jobs_book_page_idx ON retake_jobs (book_id, page);
CREATE INDEX retake_jobs_batch_idx ON retake_jobs (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX retake_jobs_txn_idx ON retake_jobs (txn_id) WHERE txn_id IS NOT NULL;

-- Progress lines per job, for GET /api/retakes/:id and its SSE stream.
CREATE TABLE retake_events (
  id       bigserial PRIMARY KEY,
  job_id   uuid NOT NULL REFERENCES retake_jobs(id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT now(),
  stage    text,
  message  text NOT NULL
);

CREATE INDEX retake_events_job_idx ON retake_events (job_id, id);
