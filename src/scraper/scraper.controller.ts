import { Controller, Get } from '@nestjs/common';
import { ScraperService } from './scraper.service';

@Controller('scraper')
export class ScraperController {

  constructor(
    private readonly scraperService: ScraperService,
  ) {}


  @Get()
  async getSites() {
    return await this.scraperService.getSites();
  }

  @Get('status')
  async siteStatus() {
    return await this.scraperService.getSitesStatus();
  }

  @Get('scrape')
  async scrapeSites() {
    await this.scraperService.scrapeSites();
    return "scraping";
  }
}
