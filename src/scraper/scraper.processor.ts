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

  @Process({ name: 'scrape', concurrency: 1 })
  async scrape(job: Job) {
    const site: Site = job.data.site;
    try {
      const vinsConfig = await this.scraperService.getVinsConfig(site);
      const status = this.scraperService.getSiteStatus(site);
      if (!vinsConfig || vinsConfig.length === 0) {
        return this.logger.error(`Empty vinsconfig for ${site.url}`);
      }
      this.scraperService.updateSiteStatus(site, vinsConfig.length, 'scraping');
      await this.scraperService.notifyFox(site, FoxApiScraperStatus.scraping);
      for (const vinConfig of vinsConfig) {
        await this.scraperQueue.add('scrapeVin', { site, vinConfig }, {
          removeOnComplete: true,
          removeOnFail: true,
          attempts: 3,
          backoff: {
            type: 'fixed',
            delay: 1000 * 60, // backof of 60 seconds
          },
        });
      }
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
        const incentives = await this.scraperService.scrapeSiteForIncentives(site, vinConfig, page);
        await page.close();

        if (Object.values(incentives).length === 0) {
          this.logger.debug(`No incentive for ${site.url} - ${vinConfig.vin} [${siteStatus.progress}% ${siteStatus.progressCounter}/${siteStatus.remaining}]`);
          return;
        }

        await this.scraperService.sendIncentiveToFox(site, vinConfig, incentives);
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
  }
}
