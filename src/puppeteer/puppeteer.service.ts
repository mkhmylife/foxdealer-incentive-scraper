import { Injectable } from '@nestjs/common';
import puppeteer, { connect } from 'puppeteer-core';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PuppeteerService {
  private browser: puppeteer.Browser;

  constructor(private readonly configService: ConfigService) {}

  async getNewBrowser() {
    this.browser = await connect({
      browserWSEndpoint: this.configService.get('PUPPETTER_WS_ENDPOINT'),
    });
    return this.browser;
  }

  async disconnectBrowser() {
    await this.browser.disconnect();
  }

  async getNewPage() {
    try {
      return await this.browser.newPage();
    } catch (e) {
      await this.getNewBrowser();
      return await this.browser.newPage();
    }
  }

}
