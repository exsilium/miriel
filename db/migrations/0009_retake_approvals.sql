-- Retakes by users, approved by an admin (docs/build-spec-checklist.md §3 decision 13; addendum in
-- docs/build-spec-retakes.md §10). Uploading and validating a photo cost nothing; `confirmed` spends the
-- estimate and replaces the book PDF, so only an admin (or RETAKE_TOKEN) confirms. A user's validated job goes
-- to `submitted`; an admin confirms it (approve) or sets it `declined` with a note. The worker still takes only
-- `uploaded` (to validate) and `confirmed` (to run) jobs.
--
-- status: uploaded -> validated | rejected -> [submitted ->] confirmed -> running -> done | failed -> (rolled_back)
--                                             submitted -> declined
--         uploaded / validated / submitted / rejected / declined / confirmed / failed (PDF not yet replaced) -> discarded

ALTER TABLE retake_jobs DROP CONSTRAINT retake_jobs_status_check;
ALTER TABLE retake_jobs ADD CONSTRAINT retake_jobs_status_check
  CHECK (status IN ('uploaded', 'validated', 'submitted', 'rejected', 'declined', 'confirmed', 'running', 'done', 'failed',
                    'rolled_back', 'discarded'));

ALTER TABLE retake_jobs
  ADD COLUMN uploaded_by    uuid REFERENCES users(id) ON DELETE SET NULL,  -- NULL: RETAKE_TOKEN, the CLI, or before accounts
  ADD COLUMN submitted_at   timestamptz,
  ADD COLUMN decided_by     uuid REFERENCES users(id) ON DELETE SET NULL,  -- who confirmed or declined (NULL: token)
  ADD COLUMN decided_at     timestamptz,
  ADD COLUMN decision_note  text;

CREATE INDEX retake_jobs_uploaded_by_idx ON retake_jobs (uploaded_by, status) WHERE uploaded_by IS NOT NULL;
