const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// 캐릭터 한글명 -> 코드 매핑
const CharacterCodeByName = {
  "루시안": 0,
  "보리스": 1,
  "막시민": 2,
  "시벨린": 3,
  "조슈아": 4,
  "란지에": 5,
  "이자크": 6,
  "밀라": 7,
  "티치엘": 8,
  "이스핀": 9,
  "나야트레이": 10,
  "아나이스": 11,
  "클로에": 12,
  "벤야": 13,
  "이솔렛": 14,
  "로아미니": 15,
  "녹턴": 16,
  "리체": 17,
  "예프넨": 18
};

const MAX_PAGE_ATTEMPTS = 4; // 최초 요청 + 최대 3회 재시도
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const PAGE_DELAY_MIN_MS = 700;
const PAGE_DELAY_MAX_MS = 1500;
const NAVIGATION_TIMEOUT_MS = 30000;
const PAGE_READY_TIMEOUT_MS = 5000;
const RANKING_PATH = '/Community/Ranking/EtaRank';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildUserAgent(defaultUserAgent) {
  // 기본 HeadlessChrome 표식만 제거하고 실제 번들 Chromium 버전과 플랫폼은 유지한다.
  return defaultUserAgent.replace('HeadlessChrome/', 'Chrome/');
}

function isExpectedRankingUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.hostname === 'tales.nexon.com'
      && url.pathname.toLowerCase() === RANKING_PATH.toLowerCase()
      && !url.searchParams.has('__cf_chl_rt_tk');
  } catch {
    return false;
  }
}

async function createScraperPage(browser, userAgent) {
  const page = await browser.newPage();
  await page.setUserAgent(userAgent);
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    const resourceType = request.resourceType();
    const action = ['image', 'stylesheet', 'font', 'media'].includes(resourceType)
      ? request.abort()
      : request.continue();

    action.catch(() => {
      // 페이지가 닫히는 시점의 미처리 요청 오류는 무시한다.
    });
  });

  return page;
}

async function warmUpBrowser(browser, userAgent) {
  const page = await createScraperPage(browser, userAgent);

  try {
    const response = await page.goto('https://tales.nexon.com/', {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS
    });
    const status = response ? response.status() : 0;

    if (status >= 200 && status < 400) {
      console.log('[SCRAPER] 브라우저 사전 방문 및 쿠키 준비 완료');
    } else {
      console.warn(`[SCRAPER] 사전 방문 응답이 비정상입니다. (HTTP ${status}) 랭킹 요청에서 다시 확인합니다.`);
    }

    await delay(1000);
  } catch (err) {
    console.warn(`[SCRAPER] 사전 방문 실패: ${err.message}. 랭킹 요청에서 다시 시도합니다.`);
  } finally {
    await page.close().catch(() => {});
  }
}

async function extractRankingPage(page) {
  return page.evaluate(() => {
    const lastUpdateLabel = Array.from(document.querySelectorAll('dt'))
      .find((element) => element.textContent.includes('Last Update'));
    const lastUpdate = lastUpdateLabel && lastUpdateLabel.nextElementSibling
      ? lastUpdateLabel.nextElementSibling.textContent.trim()
      : '';

    const rows = Array.from(document.querySelectorAll('table.col5_tb2 td.col_rank'))
      .map((rankCell) => {
        const row = rankCell.closest('tr');
        const text = (selector) => {
          const element = row ? row.querySelector(selector) : null;
          return element ? element.textContent.trim() : '';
        };

        return {
          rank: text('td.col_rank .number'),
          charName: text('td.col_char .charname'),
          nickname: text('td.col_char .nickname'),
          level: text('td.col_level'),
          point: text('td.col_point')
        };
      });

    return {
      title: document.title,
      lastUpdate,
      hasRankingTable: Boolean(document.querySelector('table.col5_tb2')),
      rows
    };
  });
}

function parseRankingRows(rows, serverCode, pageNum) {
  return rows.map((row, index) => {
    const rank = Number.parseInt(row.rank.replace(/,/g, ''), 10);
    const level = Number.parseInt(row.level.replace(/,/g, ''), 10);
    const point = Number.parseInt(row.point.replace(/,/g, ''), 10);

    if (!Number.isInteger(rank) || rank <= 0
      || !row.charName || !row.nickname
      || !Number.isInteger(level) || level < 0
      || !Number.isInteger(point) || point < 0) {
      throw new Error(`페이지 ${pageNum}의 ${index + 1}번째 랭킹 행 형식이 올바르지 않습니다.`);
    }

    return {
      ServerCode: serverCode,
      CharacterCode: CharacterCodeByName[row.charName] !== undefined
        ? CharacterCodeByName[row.charName]
        : 99,
      UserId: row.nickname,
      Level: level,
      Essence: point
    };
  });
}

async function loadRankingPage(browser, userAgent, serverName, serverCode, pageNum) {
  const url = `https://tales.nexon.com${RANKING_PATH}?page=${pageNum}&cc=99&sc=${serverCode}`;
  let lastError;

  for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt++) {
    const page = await createScraperPage(browser, userAgent);

    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS
      });
      const status = response ? response.status() : 0;
      const finalUrl = page.url();

      if (status < 200 || status >= 400) {
        throw new Error(`HTTP ${status} 응답`);
      }
      if (!isExpectedRankingUrl(finalUrl)) {
        throw new Error(`예상하지 못한 페이지로 이동됨: ${finalUrl}`);
      }

      // 서버 렌더링 페이지지만, 정상 랭킹 DOM이 준비됐는지 명시적으로 확인한다.
      await page.waitForFunction(() => {
        const hasLastUpdate = Array.from(document.querySelectorAll('dt'))
          .some((element) => element.textContent.includes('Last Update'));
        return hasLastUpdate && Boolean(document.querySelector('table.col5_tb2'));
      }, { timeout: PAGE_READY_TIMEOUT_MS });

      const pageData = await extractRankingPage(page);

      if (!pageData.hasRankingTable || !pageData.lastUpdate) {
        throw new Error(`정상 랭킹 페이지 표식을 찾지 못했습니다. (title: ${pageData.title || '없음'})`);
      }
      if (pageNum === 1 && pageData.rows.length === 0) {
        throw new Error('첫 페이지의 랭킹 데이터가 비어 있습니다.');
      }

      return {
        entries: parseRankingRows(pageData.rows, serverCode, pageNum),
        lastUpdate: pageData.lastUpdate
      };
    } catch (err) {
      lastError = err;

      if (attempt < MAX_PAGE_ATTEMPTS) {
        const retryDelay = RETRY_DELAYS_MS[attempt - 1];
        console.warn(
          `[SCRAPER] ${serverName} - 페이지 ${pageNum} 요청 실패 `
          + `(${attempt}/${MAX_PAGE_ATTEMPTS}): ${err.message}`
        );
        console.log(`[SCRAPER] ${retryDelay / 1000}초 후 재시도합니다.`);
        await delay(retryDelay);
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  throw new Error(
    `${serverName} 서버 페이지 ${pageNum} 수집이 ${MAX_PAGE_ATTEMPTS}회 연속 실패했습니다: `
    + lastError.message
  );
}

async function scrapeServer(browser, userAgent, serverCode) {
  const serverName = serverCode === 16 ? '네냐플' : '하이아칸';
  console.log(`[SCRAPER] ${serverName} 서버 에타 랭킹 크롤링 시작...`);

  const entries = [];
  let pageNum = 1;
  let lastUpdate = '';

  while (true) {
    console.log(`[SCRAPER] ${serverName} - 페이지 ${pageNum} 요청 중...`);

    const pageData = await loadRankingPage(
      browser,
      userAgent,
      serverName,
      serverCode,
      pageNum
    );

    if (pageNum === 1) {
      lastUpdate = pageData.lastUpdate;
      console.log(`[SCRAPER] ${serverName} 업데이트 날짜: ${lastUpdate}`);
    } else if (pageData.lastUpdate !== lastUpdate) {
      throw new Error(
        `${serverName} 서버 수집 중 업데이트 날짜가 변경되었습니다. `
        + `(${lastUpdate} -> ${pageData.lastUpdate})`
      );
    }

    const zeroLevelCount = pageData.entries.filter((entry) => entry.Level === 0).length;
    console.log(
      `[SCRAPER] 페이지 ${pageNum} 수집 결과: ${pageData.entries.length}명 `
      + `(에타 레벨 0인 유저: ${zeroLevelCount}명)`
    );

    entries.push(...pageData.entries);

    // 정상 랭킹 페이지임이 확인된 상태에서만 빈 페이지를 정상 종료로 판단한다.
    if (pageData.entries.length === 0 || zeroLevelCount === pageData.entries.length) {
      console.log(
        `[SCRAPER] ${serverName} 서버의 에타 랭커 수집이 만료되어 종료합니다. `
        + `(종료 페이지: ${pageNum})`
      );
      break;
    }

    pageNum++;
    await delay(randomDelay(PAGE_DELAY_MIN_MS, PAGE_DELAY_MAX_MS));
  }

  return { entries, lastUpdate };
}

async function run() {
  const start = Date.now();
  console.log('[SCRAPER] 테일즈위버 에타 랭킹 수집 작업을 시작합니다. (Puppeteer Engine)');

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });

    const userAgent = buildUserAgent(await browser.userAgent());
    await warmUpBrowser(browser, userAgent);

    const neyaffle = await scrapeServer(browser, userAgent, 16); // 네냐플
    await delay(randomDelay(PAGE_DELAY_MIN_MS, PAGE_DELAY_MAX_MS));
    const haiacan = await scrapeServer(browser, userAgent, 7); // 하이아칸

    if (!neyaffle.entries || neyaffle.entries.length === 0) {
      throw new Error('네냐플 서버에서 수집된 에타 랭킹 데이터가 없습니다.');
    }
    if (!haiacan.entries || haiacan.entries.length === 0) {
      throw new Error('하이아칸 서버에서 수집된 에타 랭킹 데이터가 없습니다.');
    }
    if (!neyaffle.lastUpdate || !haiacan.lastUpdate) {
      throw new Error('서버 업데이트 날짜를 확인할 수 없습니다.');
    }

    const allRankings = [...neyaffle.entries, ...haiacan.entries];
    const finalUpdateDate = neyaffle.lastUpdate;
    const payload = {
      CollectDate: finalUpdateDate,
      Rankings: allRankings
    };

    const outputPath = process.env.SCRAPER_OUTPUT_PATH
      ? path.resolve(process.env.SCRAPER_OUTPUT_PATH)
      : path.join(__dirname, 'eta_ranking.json');
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf-8');

    console.log(`[SCRAPER] 수집 완료! 총 수집 유저 수: ${allRankings.length}명`);
    console.log(`[SCRAPER] 저장 완료: ${outputPath}`);
    console.log(`[SCRAPER] 소요 시간: ${((Date.now() - start) / 1000).toFixed(1)}초`);
  } catch (err) {
    console.error('[SCRAPER] 수집 프로세스 중 치명적인 에러 발생:', err);
    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

run();
