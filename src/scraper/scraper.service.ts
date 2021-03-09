import { HttpService, Injectable, Logger } from '@nestjs/common';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { Site } from '../interfaces/Site';
import { SiteStatus } from '../interfaces/SiteStatus';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Make } from '../enums/Make';
import { DateTime } from 'luxon';
import { FoxApiScraperStatus } from '../enums/FoxApiScraperStatus';
import { ScraperVinsConfig } from '../interfaces/ScraperVinsConfig';
import puppeteer from 'puppeteer-core';

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
    this.scraperQueue.empty().then(() => {}).catch(e => e);

    this.getSites().then(async (sites) => {
      // const site = sites.find(site => site.url === 'https://www.mountainviewchevrolet.com');
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

  /**
   * Get sites from Fox Platform
   */
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

  /**
   * Scrape all sites
   */
  async scrapeSites() {
    const sites = await this.getSites();
    for (const site of sites) {
      await this.scraperQueue.add('scrape', { site }, {removeOnComplete: true});
    }
  }

  /**
   * Check if a site is in need of scraping now
   */
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

  /**
   * Update site status on Fox Platform
   * @param site
   * @param status
   */
  async notifyFox(site: Site, status: FoxApiScraperStatus) {
    await this.httpService.post(`${site.url}/api/cdk_scraper_update_status`, {
      status: status
    }).toPromise();
    this.logger.debug(`Sending status ${status} to Fox ${site.url}`);
  }

  /**
   * Helper function to update site status to idle
   */
  async finishedScrapingCheck() {
    for (const site of this.sites) {
      const status = this.getSiteStatus(site);
      const diff = status.lastScrappedAt.diffNow();
      const { minutes } = diff;
      if (status.status === 'scraping' && minutes >= 10) {
        if (minutes >= 10) {
          // send another idle status update in case there's error
          await this.updateSiteStatus(site, 0, 'idle');
          await this.notifyFox(site, FoxApiScraperStatus.idle);
        }
      } else if (status.status === 'pending' && minutes >= 15) {
        // it seems that the scraper is stuck, reset it to idle
        await this.updateSiteStatus(site, 0, 'idle');
        await this.notifyFox(site, FoxApiScraperStatus.idle);
      }
    }
  }

  /**
   * Query vins config of a site from Fox Platform
   * @param site
   */
  async getVinsConfig(site: Site): Promise<Array<ScraperVinsConfig>> {
    const makeRealName = ScraperService.getMakeRealName(site.make);
    const res = await this.httpService.post(`${site.url}/api/cdk_scraper_vins`, {
      make: makeRealName,
    }).toPromise();
    return res.data.vins;
  }

  /**
   * Send scraped incentives to Fox Platform
   * @param site
   * @param vinConfig
   * @param incentives
   */
  async sendIncentiveToFox(site: Site, vinConfig: ScraperVinsConfig, incentives) {
    return await this.httpService.post(`${site.url}/api/cdk_scraper_update_incentives`, {
      post_id: vinConfig.post_id,
      incentives
    }).toPromise();
  }

  /**
   * Use Puppeteer to scrape a page and extract incentives
   * @param site
   * @param vinConfig
   * @param page
   */
  async scrapeSiteForIncentives(site: Site, vinConfig: ScraperVinsConfig, page: puppeteer.Page) {
    const url = `${vinConfig.scraper_domain}${vinConfig.vin}`;

    try {
      await page.goto(url);

      try {
        const incentiveNames = await page.$$eval('[itemprop="priceSpecification"] [itemprop="name"]', els => {
          return els.map(el => el.innerHTML.replace(/\s+/, '').trim());
        });
        if (incentiveNames.length === 0) {
          const href = await page.$eval('.deck section h4 a', el => el.getAttribute('href'));
          await page.goto(href);
        }
      } catch (e) {}

      try {
        const href = await page.$eval('[itemprop="name"] a[itemprop="url"]', el => el.getAttribute('href'));
        if (href != url) {
          await page.goto(href);
        }
      } catch (e) {}

      const disclaimers = await page.$$eval('[itemprop="offers"] [if="disclaimers"].disclaimer small', els => {
        return els.map(el => {
          const id = parseInt(el.querySelector('span').innerText);
          const content = el.innerHTML.replace(/<\/?[^>]+(>|$)/g, "").trim().substring(1);
          return { id, content }
        });
      });

      const incentives = (await page.$$eval('[itemprop="priceSpecification"] li', els => {
        return els.map(el => {
          const name = el.querySelector('[itemprop="name"]').innerHTML.replace(/<\/?[^>]+(>|$)/g, "").trim();
          let disclaimerId;
          try {
            disclaimerId = el.querySelector('[if="disclaimerSuperfix"]').innerHTML.replace(/<\/?[^>]+(>|$)/g, "").trim();
          } catch (e) {
          }
          const price = parseInt(el.querySelector('[itemprop="price"]').innerHTML.replace(/<\/?[^>]+(>|$)/g, "").replace('$', '').replace(',', '').replace(' ', '').trim());
          let expiry;
          try {
            expiry = el.querySelector('[itemprop="validThrough"]').innerHTML.replace(/<\/?[^>]+(>|$)/g, "").trim();
          } catch (e) {
          }
          return { name, disclaimerId, price, expiry, disclaimer: expiry }
        });
      })).map(incentive => {
        const disclaimer = disclaimers.find(d => d.id === incentive.disclaimerId);
        if (!incentive.expiry || incentive.expiry === "") {
          if (disclaimer) {
            incentive.disclaimer = disclaimer.content;
          } else {
            incentive.disclaimer = incentive.name;
          }
        } else {
          if (disclaimer) {
            incentive.disclaimer = incentive.expiry + "\n" + disclaimer.content;
          } else {
            incentive.disclaimer = incentive.expiry;
          }
        }
        return incentive;
      });

      const incentivesWithNegativePrice = incentives.filter(incentive => incentive.price < 0);
      const parsedIncentives = {};
      for (const incentive of incentivesWithNegativePrice) {
        if (!parsedIncentives[incentive.name]) {
          parsedIncentives[incentive.name] = incentive;
          parsedIncentives[incentive.name].value = Math.abs(parsedIncentives[incentive.name].price);
        }
        if (parsedIncentives[incentive.name]) {
          const currentPrice = parsedIncentives[incentive.name].price;
          if (Math.abs(currentPrice) < Math.abs(incentive.price)) {
            parsedIncentives[incentive.name] = incentive;
            parsedIncentives[incentive.name].value = Math.abs(parsedIncentives[incentive.name].price);
          }
        }
      }
      return Object.values(parsedIncentives).map(incentive => incentive);
    } catch (e) {
      console.error(e);
      return {};
    }
  }
}
