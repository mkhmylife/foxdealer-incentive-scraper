export interface SiteStatus {
  siteUrl: string;
  status: 'idle' | 'scraping';
  progress: number;
  progressCounter: number;
  remaining: number;
  hasIncentiveCount: number;
  lastScrappedAt: string;
}
