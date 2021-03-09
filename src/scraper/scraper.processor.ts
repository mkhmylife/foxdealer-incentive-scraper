import { InjectQueue, Process, Processor } from '@nestjs/bull';
import { HttpService, Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { ScraperService } from './scraper.service';
import { Site } from '../interfaces/Site';
import { ScraperVinsConfig } from '../interfaces/ScraperVinsConfig';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { FoxApiScraperStatus } from '../enums/FoxApiScraperStatus';
import puppeteer from 'puppeteer-core';

@Processor('scraper')
export class ScraperProcessor {

  private readonly logger = new Logger(ScraperProcessor.name);

  constructor(
    private readonly scraperService: ScraperService,
    private readonly puppeteerService: PuppeteerService,
    private readonly httpService: HttpService,
    @InjectQueue('scraper') private readonly scraperQueue: Queue,
  ) {}

  private async getVinsConfig(site: Site): Promise<Array<ScraperVinsConfig>> {
    const makeRealName = ScraperService.getMakeRealName(site.make);
    const res = await this.httpService.post(`${site.url}/api/cdk_scraper_vins`, {
      make: makeRealName,
    }).toPromise();
    return res.data.vins;
  }

  private async sendIncentiveToFox(site: Site, vinConfig: ScraperVinsConfig, incentives) {
    return await this.httpService.post(`${site.url}/api/cdk_scraper_update_incentives`, {
      post_id: vinConfig.post_id,
      incentives
    }).toPromise();
  }

  private async scrapeSite(site: Site, vinConfig: ScraperVinsConfig, page: puppeteer.Page) {
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

  async scrapeSiteHandler(site: Site) {
    const vinsConfig = await this.getVinsConfig(site);
    const status = this.scraperService.getSiteStatus(site);
    if (status.status !== 'idle') {
      return this.logger.error(`Site is already scraping ${site.url}`);
    }
    if (!vinsConfig || vinsConfig.length === 0) {
      return this.logger.error(`Empty vinsconfig for ${site.url}`);
    }
    this.scraperService.updateSiteStatus(site, vinsConfig.length, 'scraping');
    await this.scraperService.notifyFox(site, FoxApiScraperStatus.scraping);
    for (const vinConfig of vinsConfig) {
      await this.scraperQueue.add('scrapeVin', { site, vinConfig }, {
        removeOnComplete: true,
        removeOnFail: true,
      });
    }
  }

  @Process({ name: 'scrape', concurrency: 1 })
  async scrape(job: Job) {
    const site: Site = job.data.site;
    try {
      await this.scrapeSiteHandler(site);
    } catch (e) {
      console.error(e);
    }
  }

  @Process({ name: 'scrapeVin', concurrency: 4 })
  async scrapeVin(job: Job) {
    const site: Site = job.data.site;
    this.scraperService.incrementSiteProgress(site);

    const status = this.scraperService.getSiteStatus(site);
    if (status.remaining === 0) {
      // Most likely this job is coming from the old app queue
      return this.logger.error(`Skip scrapeVin job as it seems to be fresh start`);
    }

    const vinConfig: ScraperVinsConfig = job.data.vinConfig;

    try {
      const page = await this.puppeteerService.getNewPage();

      const siteStatus = this.scraperService.getSiteStatus(site);
      if (!siteStatus) {
        await this.scraperService.notifyFox(site, FoxApiScraperStatus.idle);
        await page.close();
        return;
      }

      try {
        const incentives = await this.scrapeSite(site, vinConfig, page);
        await page.close();

        if (Object.values(incentives).length === 0) {
          this.logger.debug(`No incentive for ${site.url} - ${vinConfig.vin} [${siteStatus.progress}% ${siteStatus.progressCounter}/${siteStatus.remaining}]`);
          return;
        }

        await this.sendIncentiveToFox(site, vinConfig, incentives);
        this.scraperService.incrementSiteIncentiveCount(site);
        this.logger.debug(`Sent incentive for ${site.url} - ${vinConfig.vin} [${siteStatus.progress}% ${siteStatus.progressCounter}/${siteStatus.remaining}]`);
      } catch (e) {
        this.logger.error(e);
      }

      if (siteStatus.progress >= 80) {
        await this.scraperService.notifyFox(site, FoxApiScraperStatus.idle);
      }
    } catch(e) {
      console.error(e);
      this.logger.error(`Error in scrpaeVins: ${e.toString()}`);
    }

    await this.puppeteerService.disconnectBrowser();
  }
}
