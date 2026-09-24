-- "Mark as accepted" (docs/build-spec-retakes.md §6.1): the operator judges a flagged page fine without a
-- retake. Stored as a retake_jobs row (kind 'accept', status 'done'; undone by setting it 'discarded'), never
-- by editing the extraction JSON. The worker ignores these rows (it only takes 'uploaded' and 'confirmed').
ALTER TABLE retake_jobs DROP CONSTRAINT retake_jobs_kind_check;
ALTER TABLE retake_jobs ADD CONSTRAINT retake_jobs_kind_check CHECK (kind IN ('retake', 'rollback', 'accept'));
