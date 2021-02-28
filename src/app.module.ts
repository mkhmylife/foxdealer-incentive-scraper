import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PuppeteerService } from './puppeteer/puppeteer.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScraperModule } from './scraper/scraper.module';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { CronService } from './cron/cron.service';
import { CronModule } from './cron/cron.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        redis: {
          host: configService.get('QUEUE_HOST'),
          port: +configService.get('QUEUE_PORT'),
          db: 2,
        },
      }),
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    ScraperModule,
    CronModule,
  ],
  controllers: [AppController],
  providers: [AppService, ConfigService, CronService],
})
export class AppModule {}
