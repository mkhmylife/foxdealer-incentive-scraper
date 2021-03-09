import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScraperService } from '../scraper/scraper.service';

@Injectable()
export class CronService {

  private readonly logger = new Logger(CronService.name);

  constructor(private readonly scraperService: ScraperService) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM, {
    timeZone: 'America/Los_Angeles',
  })
  async handleScrapeSitesCron6am() {
    this.logger.debug('Start scraping sites at 6am');
    await this.scraperService.scrapeSites();
  }

  @Cron(CronExpression.EVERY_DAY_AT_1PM, {
    timeZone: 'America/Los_Angeles',
  })
  async handleScrapeSitesCron1pm() {
    this.logger.debug('Start scraping sites at 1pm');
    await this.scraperService.scrapeSites();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleScrapeNowCheckCron() {
    await this.scraperService.scrapeNowCheck();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleGetSitesCron() {
    await this.scraperService.getSites();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleFinishedScrapingCheckCron() {
    await this.scraperService.finishedScrapingCheck();
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    timeZone: 'America/Los_Angeles',
  })
  autoExit() {
    process.exit();
  }

}
