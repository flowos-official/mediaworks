-- 2026-06-03: compliance_rules — NG-expression lexicon for the screenplay
-- check tool (薬機法 / 景品表示法 / 健康増進法). Group B RLS: read member|admin,
-- write admin only. Seeded with a public-source starter set; admins extend it.

BEGIN;

CREATE TABLE IF NOT EXISTS compliance_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  law            text NOT NULL CHECK (law IN ('yakkiho','keihyo','kenzo')),
  category_scope text[] NOT NULL DEFAULT '{}',     -- empty = all product categories
  pattern        text NOT NULL,                    -- literal phrase or regex
  is_regex       boolean NOT NULL DEFAULT false,
  allowed        boolean NOT NULL DEFAULT false,    -- true = whitelist (e.g. 56効能), suppresses a flag
  severity       text NOT NULL DEFAULT 'med' CHECK (severity IN ('high','med','low')),
  reason         text NOT NULL DEFAULT '',
  safe_rewrite   text NOT NULL DEFAULT '',
  citation       text NOT NULL DEFAULT '',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (law, pattern)
);

CREATE INDEX IF NOT EXISTS compliance_rules_active_idx ON compliance_rules (active) WHERE active;

ALTER TABLE compliance_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "compliance_rules_read"      ON compliance_rules;
DROP POLICY IF EXISTS "compliance_rules_admin_all" ON compliance_rules;

CREATE POLICY "compliance_rules_read" ON compliance_rules
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

CREATE POLICY "compliance_rules_admin_all" ON compliance_rules
  FOR ALL TO authenticated
  USING (public.current_user_role() = 'admin')
  WITH CHECK (public.current_user_role() = 'admin');

-- Starter seed (public sources: 東京都 化粧品等適正広告ガイド / 消費者庁 景表法運用基準 /
-- 厚労省 化粧品56効能). Idempotent via ON CONFLICT (law,pattern).
INSERT INTO compliance_rules (law, category_scope, pattern, is_regex, allowed, severity, reason, safe_rewrite, citation) VALUES
  ('yakkiho', '{化粧品,医薬部外品}', 'シミが消える',      false, false, 'high', '化粧品で「シミが消える」は治療的効果の標榜にあたり不可。', 'メーキャップ効果でシミを目立たなくする', '薬機法/東京都広告ガイド'),
  ('yakkiho', '{化粧品}',            'シワが消える',      false, false, 'high', '化粧品でシワが「消える」は不可。56効能の範囲外。',        '乾燥による小じわを目立たなくする（効能評価試験済み）', '化粧品56効能'),
  ('yakkiho', '{化粧品}',            'アンチエイジング',  false, false, 'med',  '老化防止の標榜は不可。',                                  'エイジングケア（年齢に応じたお手入れ）',               '東京都広告ガイド'),
  ('yakkiho', '{健康食品}',          '治る',              false, false, 'high', '健康食品で疾病の治癒を標榜することは不可。',              '健康維持をサポート',                                   '薬機法/健康増進法'),
  ('yakkiho', '{健康食品}',          '効く',              false, false, 'med',  '健康食品で効果効能の断定は不可。',                        '健康的な毎日を応援',                                   '薬機法'),
  ('yakkiho', '{医療機器,健康食品}', '血圧を下げる',      false, false, 'high', '医薬品的効能効果の標榜は不可。',                          '（承認範囲内の表現に限定）',                           '薬機法'),
  ('yakkiho', '{化粧品}',            '乾燥による小じわを目立たなくする', false, true,  'low',  '56効能の範囲内（効能評価試験済みが前提）。許容表現。',     '',                                                     '化粧品56効能'),
  ('yakkiho', '{化粧品}',            '肌にうるおいを与える', false, true,  'low',  '56効能の範囲内。許容表現。',                              '',                                                     '化粧品56効能'),
  ('keihyo',  '{}',                  '業界初',            false, false, 'med',  'No.1/初表示は客観的根拠（調査出典・時点）が必要。',        '当社調べ（2026年5月時点）等の出典を明記',              '景表法 No.1表示ガイド'),
  ('keihyo',  '{}',                  '日本一',            false, false, 'med',  '最上級表示は客観的根拠が必要。優良誤認のおそれ。',        '出典・調査範囲を明記、または表現を削除',               '景表法 優良誤認'),
  ('keihyo',  '{}',                  '完全',              false, false, 'low',  '「完全」等の断定は優良誤認のおそれ。',                    '効果には個人差があります 等の打消し表示を併記',         '景表法'),
  ('keihyo',  '{}',                  '永久',              false, false, 'med',  '「永久」効果の標榜は優良誤認のおそれ。',                  '長期間（条件を明記）',                                 '景表法'),
  ('kenzo',   '{健康食品}',          '痩せる',            false, false, 'high', '健康増進法の誇大表示。痩身効果の標榜は不可。',            '（標榜不可。体験談も不可）',                           '健康増進法 誇大表示')
ON CONFLICT (law, pattern) DO NOTHING;

COMMIT;
