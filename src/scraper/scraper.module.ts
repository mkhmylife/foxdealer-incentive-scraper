import { HttpModule, Module } from '@nestjs/common';
import { ScraperController } from './scraper.controller';
import { ScraperService } from './scraper.service';
import { PuppeteerModule } from '../puppeteer/puppeteer.module';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { BullModule } from '@nestjs/bull';
import { ScraperProcessor } from './scraper.processor';

@Module({
  imports: [
    HttpModule,
    PuppeteerModule,
    BullModule.registerQueue({
      name: 'scraper',
    }),
  ],
  controllers: [ScraperController],
  providers: [ScraperService, PuppeteerService, ScraperProcessor],
  exports: [ScraperService, PuppeteerService, ScraperProcessor],
})
export class ScraperModule {}
