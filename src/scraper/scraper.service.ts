import { HttpService, Injectable, Logger } from '@nestjs/common';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { Site } from '../interfaces/Site';
import { SiteStatus } from '../interfaces/SiteStatus';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Make } from '../enums/Make';
import { DateTime } from 'luxon';
import { min } from 'rxjs/operators';
import { FoxApiScraperStatus } from '../enums/FoxApiScraperStatus';

@Injectable()
export class ScraperService {

  private readonly logger = new Logger(ScraperService.name);
  private sites: Array<Site>;
  private sitesStatus: Array<SiteStatus> = [];

  constructor(
    private readonly puppeteerService: PuppeteerService,
    private readonly httpService: HttpService,
    @InjectQueue('scraper') private readonly scraperQueue: Queue,
  ) {
    this.scraperQueue.clean(0, 'active').then(() => {}).catch(e => e);
    this.scraperQueue.clean(0, 'wait').then(() => {}).catch(e => e);
    this.scraperQueue.clean(0, 'completed').then(() => {}).catch(e => e);
    this.scraperQueue.clean(0, 'failed').then(() => {}).catch(e => e);
    this.scraperQueue.clean(0, 'paused').then(() => {}).catch(e => e);
    this.scraperQueue.clean(0, 'delayed').then(() => {}).catch(e => e);
    this.getSites().then(async (sites) => {
      // const site = sites.find(s => s.url === 'https://www.avchevy.com');
      // await this.scraperQueue.add('scrape', { site }, {removeOnComplete: true});
    }).catch(e => e);
  }

  public static getMakeRealName(make: Make): string {
    switch (make) {
      case Make.gmc:
        return "GMC";
      case Make.buick:
        return "Buick";
      case Make.chevy:
        return "Chevrolet";
    }
  }

  getSitesStatus() {
    return this.sitesStatus;
  }

  getSiteStatus(site: Site) {
    return this.sitesStatus.find(s => s.siteUrl === site.url);
  }

  updateSiteStatus(site: Site, remaining: number, status: 'idle' | 'scraping' | 'pending') {
    const siteStatus = this.sitesStatus.find(status => status.siteUrl === site.url);
    if (siteStatus) {
      siteStatus.progress = 0;
      siteStatus.progressCounter = 0;
      siteStatus.status = status;
      siteStatus.remaining = remaining;
      siteStatus.hasIncentiveCount = 0;
    }
  }

  incrementSiteProgress(site: Site) {
    const siteStatus = this.sitesStatus.find(status => status.siteUrl === site.url);
    if (siteStatus) {
      siteStatus.progressCounter = siteStatus.progressCounter + 1;
      const calculatedProgress = Math.floor(siteStatus.progressCounter / siteStatus.remaining * 100);
      siteStatus.progress = calculatedProgress > 100 ? 100 : calculatedProgress;
        siteStatus.lastScrappedAt = DateTime.now();
      siteStatus.status = 'scraping';

      if (siteStatus.progress === 100) {
        siteStatus.status = 'idle';
      }
    }
  }

  incrementSiteIncentiveCount(site: Site) {
    const siteStatus = this.sitesStatus.find(status => status.siteUrl === site.url);
    if (siteStatus) {
      siteStatus.hasIncentiveCount = siteStatus.hasIncentiveCount + 1;
    }
  }

  async getSites(): Promise<Array<Site>> {
    const res = await this.httpService.get('https://foxdealersites.com/api/cdk_scraper_sites_list').toPromise();
    this.sites = res.data.sites;
    for (const site of this.sites) {
      const siteStatus = this.sitesStatus.find(status => status.siteUrl === site.url);
      if (!siteStatus) {
        this.sitesStatus.push({
          siteUrl: site.url,
          progress: 0,
          status: 'idle',
          progressCounter: 0,
          remaining: 0,
          hasIncentiveCount: 0,
          lastScrappedAt: DateTime.now(),
        });
        await this.notifyFox(site, FoxApiScraperStatus.idle);
      }
    }
    return this.sites;
  }

  async scrapeSites() {
    const sites = await this.getSites();
    for (const site of sites) {
      await this.scraperQueue.add('scrape', { site }, {removeOnComplete: true});
    }
  }

  async scrapeNowCheck() {
    for (const site of this.sites) {
      const makeRealName = ScraperService.getMakeRealName(site.make);
      const res = await this.httpService.post(`${site.url}/api/cdk_scraper_vins`, {
        make: makeRealName,
      }).toPromise();
      const rescrapeNow: boolean = res.data.rescape_now;
      if (rescrapeNow) {
        const status = this.getSiteStatus(site);
        if (status.status === 'idle') {
          this.updateSiteStatus(site, 0, 'pending');
          this.logger.debug(`Scrape now detected for ${site.url}`);
          await this.scraperQueue.add('scrape', { site }, { removeOnComplete: true });
        }
      }
    }
  }

  async notifyFox(site: Site, status: FoxApiScraperStatus) {
    await this.httpService.post(`${site.url}/api/cdk_scraper_update_status`, {
      status: status
    }).toPromise();
    this.logger.debug(`Sending status ${status} to Fox ${site.url}`);
  }

  async finishedScrapingCheck() {
    for (const site of this.sites) {
      const status = this.getSiteStatus(site);
      if (status.status === 'scraping') {
        const diff = status.lastScrappedAt.diffNow();
        const { minutes } = diff;
        if (minutes >= 5) {
          // send another idle status update in case there's error
          await this.updateSiteStatus(site, 0, 'idle');
          await this.notifyFox(site, FoxApiScraperStatus.idle);
        }
      }
    }
  }
}
