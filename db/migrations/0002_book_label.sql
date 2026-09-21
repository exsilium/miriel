-- Short book label used in citation titles and inline markers ("Vol 1").
ALTER TABLE books ADD COLUMN label text;
UPDATE books SET label = id WHERE label IS NULL;
ALTER TABLE books ALTER COLUMN label SET NOT NULL;
