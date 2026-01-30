const puppeteer = require('puppeteer');

// Ye values Railway ke Environment Variables se aayengi
const CONFIG = {
  PANEL_URL: process.env.PANEL_URL,
  PANEL_USERNAME: process.env.PANEL_USERNAME,
  PANEL_PASSWORD: process.env.PANEL_PASSWORD,
  EDGE_FUNCTION_URL: 'https://datoelozwetwrasxghtu.supabase.co/functions/v1/otp-receiver',
  OTP_RECEIVER_SECRET: process.env.OTP_RECEIVER_SECRET,
  CHECK_INTERVAL_MS: 5000,
  
  // Panel ke HTML selectors - apne panel ke hisaab se change karo
  SELECTORS: {
    LOGIN_USERNAME: 'input[name="username"]',
    LOGIN_PASSWORD: 'input[name="password"]',
    LOGIN_BUTTON: 'button[type="submit"]',
    OTP_MESSAGES: '.message-row',
    OTP_TEXT: '.message-text',
  }
};

function parseOTPMessage(text) {
  const pattern1 = /(?:OTP|code)\s+(?:for\s+)?([+\d]+)\s+(?:is\s+)?(\d{4,8})/i;
  const pattern2 = /([+\d]{10,15})[\s:]+(\d{4,8})/;
  const pattern3 = /(\d{4,8})\s+(?:is\s+)?(?:your\s+)?(?:OTP|code).*?([+\d]{10,15})/i;

  let match = text.match(pattern1) || text.match(pattern2);
  if (match) {
    return { phone_number: match[1].replace(/\s/g, ''), otp_code: match[2] };
  }
  match = text.match(pattern3);
  if (match) {
    return { phone_number: match[2].replace(/\s/g, ''), otp_code: match[1] };
  }
  return null;
}

class PanelScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.processedMessages = new Set();
  }

  async init() {
    console.log('🚀 Starting Panel Scraper...');
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 800 });
    console.log('✅ Browser initialized');
  }

  async login() {
    console.log('🔐 Logging into panel...');
    await this.page.goto(CONFIG.PANEL_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await this.page.waitForSelector(CONFIG.SELECTORS.LOGIN_USERNAME, { timeout: 30000 });
    await this.page.type(CONFIG.SELECTORS.LOGIN_USERNAME, CONFIG.PANEL_USERNAME);
    await this.page.type(CONFIG.SELECTORS.LOGIN_PASSWORD, CONFIG.PANEL_PASSWORD);
    await this.page.click(CONFIG.SELECTORS.LOGIN_BUTTON);
    await this.page.waitForNavigation({ waitUntil: 'networkidle2' });
    console.log('✅ Login successful');
  }

  async checkForNewMessages() {
    try {
      const messages = await this.page.$$(CONFIG.SELECTORS.OTP_MESSAGES);
      for (const messageEl of messages) {
        const textEl = await messageEl.$(CONFIG.SELECTORS.OTP_TEXT);
        if (!textEl) continue;
        const text = await textEl.evaluate(el => el.textContent?.trim());
        if (!text) continue;
        const messageId = Buffer.from(text).toString('base64').slice(0, 32);
        if (this.processedMessages.has(messageId)) continue;

        console.log(`📨 New message: ${text.slice(0, 50)}...`);
        const otpData = parseOTPMessage(text);
        
        if (otpData) {
          console.log(`📱 Parsed - Phone: ${otpData.phone_number}, OTP: ${otpData.otp_code}`);
          await this.sendToEdgeFunction(otpData, text);
        }
        this.processedMessages.add(messageId);
        if (this.processedMessages.size > 1000) {
          const arr = Array.from(this.processedMessages);
          this.processedMessages = new Set(arr.slice(-500));
        }
      }
    } catch (error) {
      console.error('❌ Error checking messages:', error.message);
    }
  }

  async sendToEdgeFunction(otpData, rawMessage) {
    try {
      const response = await fetch(CONFIG.EDGE_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.OTP_RECEIVER_SECRET}`
        },
        body: JSON.stringify({
          phone_number: otpData.phone_number,
          otp_code: otpData.otp_code,
          raw_message: rawMessage
        })
      });
      const result = await response.json();
      if (result.success) {
        console.log(`✅ OTP forwarded to user ${result.delivered_to}`);
      } else {
        console.log(`⚠️ OTP not delivered: ${result.message}`);
      }
    } catch (error) {
      console.error('❌ Error sending to edge function:', error.message);
    }
  }

  async startMonitoring() {
    console.log(`👀 Monitoring started - checking every ${CONFIG.CHECK_INTERVAL_MS/1000}s`);
    let refreshCounter = 0;
    while (true) {
      await this.checkForNewMessages();
      await new Promise(r => setTimeout(r, CONFIG.CHECK_INTERVAL_MS));
      refreshCounter++;
      if (refreshCounter >= 60) { // Refresh every 5 minutes
        console.log('🔄 Refreshing page...');
        await this.page.reload({ waitUntil: 'networkidle2' });
        refreshCounter = 0;
      }
    }
  }
}

async function main() {
  const scraper = new PanelScraper();
  while (true) {
    try {
      await scraper.init();
      await scraper.login();
      await scraper.startMonitoring();
    } catch (error) {
      console.error('❌ Error:', error.message);
      console.log('⏳ Retrying in 30 seconds...');
      await new Promise(r => setTimeout(r, 30000));
    }
  }
}

main();
      
