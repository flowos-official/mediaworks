import { useTranslations } from "next-intl";
import { ExternalLink, ShoppingBag } from "lucide-react";
import ChannelBadge from "./ChannelBadge";

export interface Broadcast {
  id: string;
  channel: "shopch" | "qvc";
  air_date: string;
  start_time: string;
  program_title: string;
  presenter: string | null;
  description: string | null;
  thumbnail_url: string | null;
  source_url: string;
}

interface Props {
  broadcast: Broadcast;
}

function formatTime(t: string): string {
  return t.slice(0, 5);
}

// QVC의 썸네일 URL은 호스트 얼굴 사진(navigator/*)만 제공됨 → 제품 중심 표시에 방해되므로 placeholder로 대체.
function isProductImage(b: Broadcast): boolean {
  if (!b.thumbnail_url) return false;
  if (b.thumbnail_url.includes("/navigator/")) return false;
  return true;
}

// 채널별 데이터 모양 차이를 흡수해 "제품 우선" 뷰 만들기.
// - shopch: description = 실제 제품명, program_title = 반복되는 코너명
// - qvc:    program_title = 쇼/제품 제목, description = 쇼 설명
function getProductView(b: Broadcast): {
  productName: string;
  context: string | null;
} {
  if (b.channel === "shopch") {
    return {
      productName: b.description ?? b.program_title,
      context: b.description ? b.program_title : null,
    };
  }
  return {
    productName: b.program_title,
    context: b.description,
  };
}

const CHANNEL_PLACEHOLDER: Record<Broadcast["channel"], string> = {
  shopch: "bg-red-50 text-red-400",
  qvc: "bg-violet-50 text-violet-400",
};

export default function BroadcastListItem({ broadcast }: Props) {
  const t = useTranslations("broadcasts");
  const b = broadcast;
  const view = getProductView(b);
  const showProductImage = isProductImage(b);

  return (
    <div className="flex gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
      {showProductImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={b.thumbnail_url!}
          alt=""
          className="w-20 h-20 object-cover rounded flex-shrink-0 bg-gray-100"
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).style.visibility = "hidden";
          }}
        />
      ) : (
        <div
          className={`w-20 h-20 rounded flex-shrink-0 flex items-center justify-center ${CHANNEL_PLACEHOLDER[b.channel]}`}
        >
          <ShoppingBag size={28} strokeWidth={1.5} />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="font-mono font-semibold text-gray-700">{formatTime(b.start_time)}</span>
          <ChannelBadge channel={b.channel} />
          {b.presenter && (
            <span className="text-gray-400 truncate max-w-[12rem]">· {b.presenter}</span>
          )}
        </div>
        <div className="font-semibold text-gray-900 mt-1 text-base line-clamp-2 leading-snug">
          {view.productName}
        </div>
        {view.context && (
          <div className="text-xs text-gray-500 mt-1 truncate">{view.context}</div>
        )}
      </div>
      <a
        href={b.source_url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 flex-shrink-0 self-start mt-1"
      >
        <ExternalLink size={12} />
        {t("openSource")}
      </a>
    </div>
  );
}
