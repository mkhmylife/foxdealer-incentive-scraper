import { InjectQueue, OnQueueCompleted, OnQueueProgress, Process, Processor } from '@nestjs/bull';
import { HttpService, Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { ScraperService } from './scraper.service';
import { Site } from '../interfaces/Site';
import { ScraperVinsConfig } from '../interfaces/ScraperVinsConfig';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { FoxApiScraperStatus } from '../enums/FoxApiScraperStatus';
import puppeteer from 'puppeteer-core';
import { stat } from 'fs';

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
        const incentives = await this.scraperService.scrapeSiteIncentives(site, vinConfig, page);
        await page.close();

        if (Object.values(incentives).length === 0) {
          this.logger.debug(`No incentive for ${site.url} - ${vinConfig.vin} [${siteStatus.progress}% ${siteStatus.progressCounter}/${siteStatus.remaining}]`);
          return;
        }

        const foxRes = await this.sendIncentiveToFox(site, vinConfig, incentives);
        this.scraperService.incrementSiteIncentiveCount(site);
        this.logger.debug(`Sent incentive for ${site.url} - ${vinConfig.vin} [${siteStatus.progress}% ${siteStatus.progressCounter}/${siteStatus.remaining}] ${JSON.stringify(foxRes.data)}`);
      } catch (e) {
        this.logger.error(e);
      }

      if (siteStatus.progress >= 100) {
        await this.scraperService.notifyFox(site, FoxApiScraperStatus.idle);
        try {
          await this.puppeteerService.closeBrowser();
        } catch (e) {}
      }
    } catch(e) {
      console.error(e);
      this.logger.error(`Error in scrpaeVins: ${e.toString()}`);
    }
  }
}
