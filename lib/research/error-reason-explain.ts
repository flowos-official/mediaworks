export type ErrorReasonLocale = "ja" | "ko";

export const ERROR_REASON_LABELS_JA: Record<string, string> = {
  safety_blocked: "コンテンツが安全フィルタで拒否されました。内容を見直して再アップロードしてください",
  rate_limited: "AI処理が混雑しています。数分後にもう一度お試しください",
  server_error: "AIサーバーが一時的に応答していません。再アップロードをお試しください",
  parse_failed: "AIの出力解析に失敗しました。管理者が確認します",
  schema_validation_failed: "AIの出力形式に問題がありました。管理者が確認します",
  extract_empty: "AIから空の応答が返りました。再アップロードをお試しください",
  context_load_failed: "市場データの読み込みに失敗しました。再アップロードで通常は回復します",
  cron_secret_missing: "システム設定エラー — 管理者対応中",
  trigger_not_invoked: "処理が開始されませんでした。再アップロードしてください",
  analysis_timeout: "分析がタイムアウトしました。再アップロードしてください",
  extract_failed: "ファイル解析に失敗しました。ファイル形式をご確認ください (PDF/PPTX/DOCX/画像)",
  synthesis_failed: "市場調査の生成に失敗しました。再アップロードをお試しください",
  file_too_large: "ファイルサイズが上限 (15MB) を超えています",
  no_files: "ファイルが添付されていません",
  unknown: "原因不明 — 管理者にお問い合わせください",
};

export const ERROR_REASON_LABELS_KO: Record<string, string> = {
  safety_blocked: "콘텐츠가 안전 필터에 의해 거부되었습니다. 내용을 수정 후 다시 업로드해 주세요",
  rate_limited: "AI 처리가 혼잡합니다. 몇 분 후 다시 시도해 주세요",
  server_error: "AI 서버가 일시적으로 응답하지 않습니다. 다시 업로드해 주세요",
  parse_failed: "AI 출력 파싱에 실패했습니다. 관리자가 확인 중입니다",
  schema_validation_failed: "AI 출력 형식에 문제가 있었습니다. 관리자가 확인 중입니다",
  extract_empty: "AI 가 빈 응답을 반환했습니다. 다시 업로드해 주세요",
  context_load_failed: "시장 데이터 로딩에 실패했습니다. 재업로드로 보통 회복됩니다",
  cron_secret_missing: "시스템 설정 오류 — 관리자 대응 중",
  trigger_not_invoked: "처리가 시작되지 않았습니다. 다시 업로드해 주세요",
  analysis_timeout: "분석이 타임아웃되었습니다. 다시 업로드해 주세요",
  extract_failed: "파일 해석에 실패했습니다. 파일 형식을 확인해 주세요 (PDF/PPTX/DOCX/이미지)",
  synthesis_failed: "시장 조사 생성에 실패했습니다. 다시 업로드해 주세요",
  file_too_large: "파일 사이즈가 상한 (15MB) 을 초과했습니다",
  no_files: "파일이 첨부되지 않았습니다",
  unknown: "원인 불명 — 관리자에게 문의해 주세요",
};

export function explainErrorReason(
  reason: string | null,
  locale: ErrorReasonLocale = "ja",
): string {
  const table = locale === "ko" ? ERROR_REASON_LABELS_KO : ERROR_REASON_LABELS_JA;
  if (!reason) return table.unknown;
  const kind = reason.split(":")[0].trim();
  return table[kind] ?? table.unknown;
}
