import { DateTime } from 'luxon';

export interface SiteStatus {
  siteUrl: string;
  status: 'idle' | 'scraping' | 'pending';
  progress: number;
  progressCounter: number;
  remaining: number;
  hasIncentiveCount: number;
  lastScrappedAt: DateTime;
}
