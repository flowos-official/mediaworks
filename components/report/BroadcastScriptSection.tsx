'use client';

import { useState } from 'react';
import { Tv, Copy, Check } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Props {
  broadcast_scripts: {
    sec30: string;
    sec60: string;
    min5: string;
  };
}

const tabs = [
  { key: 'sec30' as const, label: '30秒' },
  { key: 'sec60' as const, label: '60秒' },
  { key: 'min5' as const, label: '5分' },
];

export default function BroadcastScriptSection({ broadcast_scripts }: Props) {
  const [activeTab, setActiveTab] = useState<'sec30' | 'sec60' | 'min5'>('sec30');
  const [copied, setCopied] = useState(false);

  if (!broadcast_scripts) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(broadcast_scripts[activeTab]);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Tv size={20} className="text-purple-600" />
          放送台本
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'bg-purple-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative">
          <div className="bg-gray-50 rounded-xl p-5 text-sm leading-relaxed text-gray-800 whitespace-pre-wrap">
            {broadcast_scripts[activeTab]}
          </div>
          <button
            onClick={handleCopy}
            className="absolute top-3 right-3 p-2 rounded-lg bg-white border border-gray-200 hover:bg-gray-50 transition-colors"
            title="コピー"
          >
            {copied ? (
              <Check size={14} className="text-green-600" />
            ) : (
              <Copy size={14} className="text-gray-500" />
            )}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
