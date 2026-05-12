import { useTranslations } from "next-intl";
import { ExternalLink } from "lucide-react";
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

export default function BroadcastListItem({ broadcast }: Props) {
  const t = useTranslations("broadcasts");
  const b = broadcast;
  return (
    <div className="flex gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
      {b.thumbnail_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={b.thumbnail_url}
          alt=""
          className="w-16 h-12 object-cover rounded flex-shrink-0 bg-gray-100"
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).style.visibility = "hidden";
          }}
        />
      ) : (
        <div className="w-16 h-12 bg-gray-100 rounded flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono font-semibold text-gray-900">{formatTime(b.start_time)}</span>
          <ChannelBadge channel={b.channel} />
        </div>
        <div className="font-medium text-gray-900 mt-1 truncate">{b.program_title}</div>
        {(b.presenter || b.description) && (
          <div className="text-xs text-gray-500 mt-0.5 truncate">
            {b.presenter && <span className="mr-2">ナビ: {b.presenter}</span>}
            {b.description && <span>{b.description}</span>}
          </div>
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
