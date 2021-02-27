import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PuppeteerService } from './puppeteer/puppeteer.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService, PuppeteerService],
})
export class AppModule {}
