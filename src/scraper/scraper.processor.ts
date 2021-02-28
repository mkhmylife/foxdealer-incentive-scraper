import { InjectQueue, OnQueueCompleted, OnQueueProgress, Process, Processor } from '@nestjs/bull';
import { HttpService, Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { ScraperService } from './scraper.service';
import { Site } from '../interfaces/Site';
import { ScraperVinsConfig } from '../interfaces/ScraperVinsConfig';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { FoxApiScraperStatus } from '../enums/FoxApiScraperStatus';
import { Make } from '../enums/Make';
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

  private async notifyFox(site: Site, status: FoxApiScraperStatus) {
    const res = await this.httpService.post(`${site.url}/api/cdk_scraper_update_status`, {
      status: status
    }).toPromise();
    console.log(res.data);
  }

  private async sendIncentiveToFox(site: Site, vinConfig: ScraperVinsConfig, incentives) {
    await this.httpService.post(`${site.url}/api/cdk_scraper_update_incentives`, {
      post_id: vinConfig.post_id,
      incentives
    }).toPromise();
  }

  private async scrapeSite(site: Site, vinConfig: ScraperVinsConfig, page: puppeteer.Page) {
    const url = `${vinConfig.scraper_domain}${vinConfig.vin}`;

    try {
      await page.goto(url);

      const incentiveNames = await page.$$eval('[itemprop="priceSpecification"] [itemprop="name"]', els => {
        return els.map(el => el.innerHTML.replace(/\s+/, '').trim());
      });

      try {
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

      const parsedIncentives = {};
      for (const incentive of incentives) {
        if (!parsedIncentives[incentive.name]) {
          parsedIncentives[incentive.name] = incentive;
        }
        if (parsedIncentives[incentive.name]) {
          const currentPrice = parsedIncentives[incentive.name].price;
          if (Math.abs(currentPrice) < Math.abs(incentive.price)) {
            parsedIncentives[incentive.name] = incentive;
          }
        }
      }
      return Object.values(parsedIncentives).map(incentive => incentive);
    } catch (e) {
      throw new Error(e);
    }
  }

  async scrapeSiteHandler(site: Site) {
    const vinsConfig = await this.getVinsConfig(site);
    if (!vinsConfig || vinsConfig.length === 0) {
      return this.logger.error(`Empty vinsconfig for ${site.url}`);
    }
    this.scraperService.updateSiteStatus(site, vinsConfig.length, 'scraping');
    await this.notifyFox(site, FoxApiScraperStatus.scraping);
    for (const vinConfig of vinsConfig) {
      await this.scraperQueue.add('scrapeVins', { site, vinConfig }, {removeOnComplete: true});
    }
  }

  @Process({ name: 'scrape', concurrency: 2 })
  async scrape(job: Job) {
    const site: Site = job.data.site;
    try {
      await this.scrapeSiteHandler(site);
    } catch (e) {
      console.error(e);
    }
  }

  @Process({ name: 'scrapeVins', concurrency: 8 })
  async scrapeVins(job: Job) {
    const site: Site = job.data.site;
    const vinConfig: ScraperVinsConfig = job.data.vinConfig;
    try {
      const page = await this.puppeteerService.getNewPage();

      let siteStatus = this.scraperService.getSiteStatus(site);
      if (!siteStatus) {
        await this.notifyFox(site, FoxApiScraperStatus.idle);
        await page.close();
        return;
      }

      try {
        const incentives = await this.scrapeSite(site, vinConfig, page);
        await page.close();
        siteStatus = this.scraperService.getSiteStatus(site);

        if (Object.values(incentives).length === 0) {
          this.scraperService.incrementSiteProgress(site, false);
          this.logger.debug(`No incentive for ${site.url} - ${vinConfig.vin} [${siteStatus.progress}% ${siteStatus.progressCounter}/${siteStatus.remaining}]`);
          return;
        }

        await this.sendIncentiveToFox(site, vinConfig, incentives);
        this.scraperService.incrementSiteProgress(site, true);
        this.logger.debug(`Sent incentive for ${site.url} - ${vinConfig.vin} [${siteStatus.progress}% ${siteStatus.progressCounter}/${siteStatus.remaining}]`);
      } catch (e) {
        this.logger.error(e);
      }

      if (siteStatus.progress >= 98) {
        await this.notifyFox(site, FoxApiScraperStatus.idle);
      }
    } catch(e) {
      this.logger.error(`Error in scrpaeVins: ${e.toString()}`);
    }
  }
}
