-- Split actual product category from search seed keyword in discovered_products.
ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS seed_keyword text;

-- Historical rows stored the search seed in category.
UPDATE discovered_products
SET seed_keyword = category
WHERE seed_keyword IS NULL
  AND category IS NOT NULL;

-- Existing category values are known to be corrupted seed labels rather than
-- real product categories, so clear them to avoid poisoning learning.
UPDATE discovered_products
SET category = NULL
WHERE category IS NOT NULL
  AND category = seed_keyword;

CREATE INDEX IF NOT EXISTS idx_dp_seed_keyword
  ON discovered_products (seed_keyword);
