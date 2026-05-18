'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

export type Period = 'weekly' | 'monthly';

export interface FirmFilterContextValue {
  selectedYears: number[];
  setSelectedYears: (y: number[]) => void;
  period: Period;
  setPeriod: (p: Period) => void;
}

const Ctx = createContext<FirmFilterContextValue | null>(null);

export function FirmFilterProvider({ children }: { children: ReactNode }) {
  const [selectedYears, setSelectedYears] = useState<number[]>([2025, 2026]);
  const [period, setPeriod] = useState<Period>('weekly');
  return (
    <Ctx.Provider value={{ selectedYears, setSelectedYears, period, setPeriod }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAnalyticsFilter(): FirmFilterContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAnalyticsFilter must be used inside FirmFilterProvider');
  return ctx;
}
