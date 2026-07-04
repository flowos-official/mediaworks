-- 2026-07-04: extend the compliance `law` axis for Tokyo-TV food commerce.
-- 虎ノ門市場 (food) は薬機法より食品表示法・優良誤認(景表法)・特商法(定期便告知)
-- が考査の中心。CHECK を拡張して食品表示法(shokuhin)・特商法(tokushoho)を受容する。
-- inline column CHECK の既定名は <table>_<column>_check。

BEGIN;

ALTER TABLE compliance_rules DROP CONSTRAINT IF EXISTS compliance_rules_law_check;
ALTER TABLE compliance_rules ADD  CONSTRAINT compliance_rules_law_check
  CHECK (law IN ('yakkiho','keihyo','kenzo','shokuhin','tokushoho'));

ALTER TABLE compliance_references DROP CONSTRAINT IF EXISTS compliance_references_law_check;
ALTER TABLE compliance_references ADD  CONSTRAINT compliance_references_law_check
  CHECK (law IN ('yakkiho','keihyo','kenzo','other','shokuhin','tokushoho'));

COMMIT;
