import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScraperService } from '../scraper/scraper.service';

@Injectable()
export class CronService {

  private readonly logger = new Logger(CronService.name);

  constructor(private readonly scraperService: ScraperService) {}

  @Cron(CronExpression.EVERY_4_HOURS)
  async handleScrapeSitesCron() {
    this.logger.debug('Start scraping sites');
    await this.scraperService.scrapeSites();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleScrapeNowCheckCron() {
    this.logger.debug('Start scrape now check');
    await this.scraperService.scrapeNowCheck();
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleGetSitesCron() {
    this.logger.debug('Start getting sites');
    await this.scraperService.getSites();
  }

}
