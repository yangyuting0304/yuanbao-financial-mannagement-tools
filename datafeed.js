'use strict';
/*
 * datafeed.js — 摸鱼理财 数据层
 * 负责拉取并解析行情数据，不依赖浏览器（运行在 Electron 主进程 / Node）。
 *
 * 数据源：
 *  1) 腾讯财经 qt.gtimg.cn
 *     - A股指数 / 港股指数 / 个股： s_ 简化接口（GBK 编码，~ 分隔）
 *     - 国际金价（伦敦金/现货黄金）： hf_XAU（GBK 编码，逗号分隔）
 *  2) 东方财富 push2.eastmoney.com
 *     - 国内金价（上金所 Au99.99，人民币/克）： secid=113.Au99.99
 *     - 美元兑人民币（用于兜底推算国内金价）： secid=119.USDCNY
 *
 * 兜底：若东方财富国内金价拉取失败，则按
 *      国内金价(元/克) = 国际金价(美元/盎司) × 美元兑人民币 ÷ 31.1035
 *      进行估算，并在结果中标记 derived=true（界面显示“估算”）。
 */

const https = require('https');
const { TextDecoder } = require('util');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TENCENT_REFERER = 'https://gu.qq.com/';
const EM_REFERER = 'https://quote.eastmoney.com/';
const GRAM_PER_OUNCE = 31.1035;

/** 通用 HTTPS GET，支持编码与重定向，带超时。 */
function httpGet(url, encoding = 'utf8', timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          'Referer': url.includes('eastmoney') ? EM_REFERER : TENCENT_REFERER,
          'Accept': '*/*',
        },
        timeout: timeoutMs,
      },
      (res) => {
        // 跟随一次重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          return httpGet(next, encoding, timeoutMs).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' @ ' + url));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const buf = Buffer.concat(chunks);
            const text = encoding === 'gbk'
              ? new TextDecoder('gbk').decode(buf)
              : buf.toString('utf8');
            resolve(text);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout @ ' + url)));
    req.on('error', reject);
  });
}

/** 解析腾讯 s_ 简化接口：v_s_xxxx="1~名称~代码~价格~涨跌~涨跌幅~..." */
function parseTencentSimple(raw) {
  const out = [];
  const re = /v_([\w]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const code = m[1];
    const p = m[2].split('~');
    const price = parseFloat(p[3]);
    const change = parseFloat(p[4]);
    const pct = parseFloat(p[5]);
    out.push({
      code,
      name: p[1] || code,
      price: isNaN(price) ? null : price,
      change: isNaN(change) ? null : change,
      pct: isNaN(pct) ? null : pct,
      source: 'tencent',
    });
  }
  return out;
}

/** 解析腾讯 hf_ 接口（国际金价/期货）：v_hf_XAU="现价,涨跌幅%,买价,卖价,最高,最低,时间,昨收,今开,..." */
function parseTencentHF(raw) {
  const out = [];
  const re = /v_([\w]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const code = m[1];
    const p = m[2].split(',');
    const price = parseFloat(p[0]);
    const pct = parseFloat(p[1]);          // 涨跌幅 %
    const prevClose = parseFloat(p[7]);    // 昨收
    const change = !isNaN(prevClose) && !isNaN(price) ? +(price - prevClose).toFixed(2) : NaN;
    out.push({
      code,
      name: p[p.length - 1] || code,
      price: isNaN(price) ? null : price,
      change: isNaN(change) ? null : change,
      pct: isNaN(pct) ? null : pct,
      high: parseFloat(p[4]),
      low: parseFloat(p[5]),
      time: p[6] || '',
      source: 'tencent',
    });
  }
  return out;
}

/** 解析东方财富 stock/get：f43 价格/涨跌额/涨跌幅 均 ×100 存储 */
function parseEastmoney(raw) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  const d = j && j.data;
  if (!d || d.f43 == null) return null;
  return {
    code: d.f57,
    name: d.f58,
    price: d.f43 / 100,
    change: d.f169 != null ? d.f169 / 100 : NaN,
    pct: d.f170 != null ? d.f170 / 100 : NaN,
    source: 'eastmoney',
  };
}

/**
 * 拉取全部行情。
 * @param {object} config 含 watchlist / domesticGold
 * @returns {Promise<{updatedAt:number, items:object, domesticGold:object|null, usdcny:number|null, errors:string[]}>}
 */
async function fetchAll(config) {
  const result = { updatedAt: Date.now(), items: {}, domesticGold: null, usdcny: null, errors: [] };
  const items = (config.watchlist || []).reduce((a, g) => a.concat(g.items || []), []);

  const tSimple = [];
  const tHF = [];
  const eGold = [];

  for (const it of items) {
    const code = it.code || '';
    if (code.startsWith('hf_')) tHF.push(it);
    else if (it.type === 'domestic_gold' || /^\d+\./.test(code)) eGold.push(it);
    else tSimple.push(it);
  }

  // 1) 腾讯 指数 / 个股
  if (tSimple.length) {
    try {
      const raw = await httpGet('https://qt.gtimg.cn/q=' + tSimple.map((i) => i.code).join(','), 'gbk');
      for (const p of parseTencentSimple(raw)) result.items[p.code] = p;
    } catch (e) {
      result.errors.push('tencent:' + e.message);
    }
  }

  // 2) 腾讯 国际金价 / 期货
  if (tHF.length) {
    try {
      const raw = await httpGet('https://qt.gtimg.cn/q=' + tHF.map((i) => i.code).join(','), 'gbk');
      for (const p of parseTencentHF(raw)) result.items[p.code] = p;
    } catch (e) {
      result.errors.push('tencentHF:' + e.message);
    }
  }

  // 3) 东方财富 国内金价（上金所）
  const dgCfg = config.domesticGold || {};
  const dgItem = eGold[0];
  if (dgItem) {
    try {
      const secid = dgItem.code;
      const raw = await httpGet(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f57,f58,f60,f169,f170`,
        'utf8'
      );
      const p = parseEastmoney(raw);
      if (p) {
        result.domesticGold = p;
        result.items[dgItem.code] = p;
      } else {
        result.errors.push('eastmoney:empty(' + secid + ')');
      }
    } catch (e) {
      result.errors.push('eastmoney:' + e.message);
    }
  }

  // 4) 美元兑人民币（用于兜底推算）
  const fxSecid = dgCfg.fxSecid || '119.USDCNY';
  try {
    const raw = await httpGet(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${fxSecid}&fields=f43,f170`,
      'utf8'
    );
    const j = JSON.parse(raw);
    if (j.data && j.data.f43 != null) result.usdcny = j.data.f43 / 100;
  } catch (e) {
    /* 汇率非关键，失败不影响主行情 */
  }

  // 5) 兜底：东方财富失败时，用国际金价 × 汇率 推算国内金价
  if (!result.domesticGold && dgItem) {
    const intl =
      Object.values(result.items).find((x) => x.source === 'tencent' && /伦敦|现货黄金|XAU/i.test(x.name)) ||
      tHF.map((i) => result.items[i.code]).find(Boolean);
    const usdcny = result.usdcny || dgCfg.fallbackUsdCny || 7.25;
    if (intl && intl.price) {
      const price = +(intl.price * usdcny / GRAM_PER_OUNCE).toFixed(2);
      result.domesticGold = {
        name: dgItem.name || '国内金价(估算)',
        price,
        change: null,
        pct: null,
        derived: true,
        source: 'derived',
        usdcny,
      };
      result.items[dgItem.code] = result.domesticGold;
    }
  }

  return result;
}

module.exports = { fetchAll, httpGet, parseTencentSimple, parseTencentHF, parseEastmoney };
