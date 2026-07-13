"use client";

import { SWRConfig } from "swr";

const FIVE_MINUTES = 5 * 60 * 1000;

export function AppDataCacheProvider({ children }: { children: React.ReactNode }) {
	return (
		<SWRConfig
			value={{
				dedupingInterval: FIVE_MINUTES,
				focusThrottleInterval: FIVE_MINUTES,
				keepPreviousData: true,
				revalidateOnFocus: false,
				revalidateOnReconnect: true,
				revalidateIfStale: true,
				errorRetryCount: 2,
				errorRetryInterval: 1500,
				shouldRetryOnError: (error) => {
					const status = (error as { status?: number }).status;
					return status !== 401 && status !== 403 && status !== 404;
				},
			}}
		>
			{children}
		</SWRConfig>
	);
}
