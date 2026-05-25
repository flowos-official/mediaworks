-- 2026-05-25: products.status lifecycle 을 4단계로 좁힘.
-- 이 SQL 은 application code 가 이미 'extracted' 를 쓰지 않게 배포된 뒤에 적용한다.

BEGIN;

-- 1) 잔존 row 정리 (찰나만 거치는 단계라 보통 0건이지만 방어적으로).
UPDATE products SET status = 'analyzing' WHERE status = 'extracted';

-- 2) CHECK 제약 갱신.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check;
ALTER TABLE products
  ADD CONSTRAINT products_status_check
  CHECK (status IN ('pending', 'analyzing', 'completed', 'failed'));

COMMIT;
