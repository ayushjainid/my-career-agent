-- Applying in Italian: each fact records the language it is written in, and can carry translations
-- ({"it": "..."}), so an Italian CV or answer uses the person's own Italian wording.
ALTER TABLE mca.fact ADD COLUMN IF NOT EXISTS lang text NOT NULL DEFAULT 'en' CHECK (lang IN ('en', 'it'));
ALTER TABLE mca.fact ADD COLUMN IF NOT EXISTS translations jsonb NOT NULL DEFAULT '{}'::jsonb;
