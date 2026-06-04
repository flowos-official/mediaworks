-- 2026-06-04: compliance_references seed — grounding corpus from PUBLIC JP
-- regulatory sources. Reviewer aid, NOT legal authority. All source_url values
-- were verified to resolve at authoring time. Idempotent via ON CONFLICT (law, topic).

BEGIN;

INSERT INTO compliance_references (law, category_scope, topic, body, keywords, citation, source_url) VALUES
  ('yakkiho', '{化粧品,医薬部外品}', '化粧品の効能の範囲（56効能）',
   '化粧品が標榜できる効能効果は、厚生労働省通知で定められた56項目の範囲に限られる。これを超える効能（治療・予防・身体機能の改善等）は標榜できない。「乾燥による小じわを目立たなくする」は効能評価試験を行った場合に限り可。',
   '{56効能,化粧品,効能,小じわ,うるおい,肌,標榜}',
   '厚生労働省「化粧品の効能の範囲」', 'https://www.mhlw.go.jp/bunya/iyakuhin/keshouhin/'),
  ('yakkiho', '{化粧品,医薬部外品}', '化粧品等の適正広告ガイドライン',
   '化粧品の広告では、医薬品的な効能効果（治癒・改善・予防・細胞活性化・若返り等）、安全性の保証表現、最大級表現を標榜できない。メーキャップ効果（物理的効果）は事実の範囲で可。',
   '{広告,化粧品,医薬品的,効能効果,メーキャップ,安全性,最大級}',
   '東京都「化粧品等の適正広告ガイドライン」', ''),
  ('keihyo', '{}', 'No.1表示の根拠要件',
   'No.1・第1位等の表示は、客観的な調査に基づき、調査範囲・出典・時点を明示する必要がある。根拠のないNo.1表示は優良誤認のおそれ。',
   '{No.1,ナンバーワン,第1位,調査,根拠,出典,優良誤認}',
   '消費者庁「No.1表示に関する実態調査報告書」', 'https://www.caa.go.jp/notice/entry/039459/'),
  ('keihyo', '{}', '打消し表示の考え方',
   '強調表示に対する例外・限定（打消し表示）は、消費者が認識できる文字サイズ・配置・タイミングで明瞭に表示する必要がある。読めない打消し表示は不当表示のおそれ。',
   '{打消し表示,強調表示,個人差,注釈,例外}',
   '消費者庁「打消し表示に関する実態調査報告書」', 'https://www.caa.go.jp/policies/policy/representation/fair_labeling/survey'),
  ('keihyo', '{}', '不当な価格表示（二重価格）',
   '「通常価格」等との比較（二重価格表示）は、比較対照価格が最近相当期間にわたり実際に販売された価格である等の根拠が必要。根拠のない比較は有利誤認のおそれ。',
   '{二重価格,通常価格,割引,比較,有利誤認,価格表示}',
   '消費者庁「不当な価格表示についての景品表示法上の考え方」', 'https://www.caa.go.jp/policies/policy/representation/fair_labeling/representation_regulation/double_price'),
  ('kenzo', '{健康食品,食品}', '健康増進法の誇大表示',
   '食品について、健康保持増進効果等を著しく事実に相違して、または著しく人を誤認させる広告は禁止。痩身・疾病治癒・身体機能の著しい改善等の標榜は誇大表示のおそれ。',
   '{健康増進法,誇大表示,健康保持増進,痩身,健康食品,効果}',
   '消費者庁「健康増進法に基づく虚偽誇大広告等の禁止」', 'https://www.caa.go.jp/policies/policy/representation/extravagant_advertisement')
ON CONFLICT (law, topic) DO NOTHING;

COMMIT;
