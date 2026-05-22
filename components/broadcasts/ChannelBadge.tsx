import { useTranslations } from "next-intl";

type Channel = "shopch" | "qvc";

interface Props {
  channel: Channel;
  short?: boolean;
}

const COLORS: Record<Channel, string> = {
  shopch: "bg-red-600/15 text-red-700 dark:text-red-200 border-red-500/40",
  qvc: "bg-violet-600/15 text-violet-700 dark:text-violet-200 border-violet-500/40",
};

export default function ChannelBadge({ channel, short = true }: Props) {
  const t = useTranslations("broadcasts");
  const label = short ? t(`channelShort.${channel}`) : t(`channels.${channel}`);
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${COLORS[channel]}`}
    >
      {label}
    </span>
  );
}
