/**
 * 元宝爱财 - 本地数据代理服务器 v2
 * 
 * 解决 file:// 模式下无法跨域获取国内金价的问题。
 * Node.js 服务端转发 HTTP 请求，绕过浏览器 CORS 限制，
 * 支持 fallback 链：东方财富 → 腾讯黄金ETF反推 → 国际金价折算
 * 
 * 用法: 双击"启动服务.bat" 或运行 node server.js
 * 然后自动打开 http://localhost:18765
 */
const http = require("http");
const https = require("https");
const url = require("url");
const fs = require("fs");
const path = require("path");

const PORT = 18765;
// HTML 文件名：宝塔等环境常命名为 index.html，兼容两种命名
const HTML_FILE = (() => {
  const idx = path.join(__dirname, "index.html");
  if (fs.existsSync(idx)) return idx;
  return path.join(__dirname, "元宝爱财-摸鱼致富.html");
})();

// ====== HTTP 请求工具 ======
function fetchGet(remoteUrl, extraHeaders, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(remoteUrl);
    const mod = u.protocol === "https:" ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      timeout: timeoutMs || 12000,
      headers: Object.assign({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
      }, extraHeaders || {})
    };
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// ============================================================
//  国内金价数据源（按优先级排列，fallback 链）
//  主源：腾讯理财通(黄金ETF·AU9999反推) —— 腾讯行情同源，实时、准
//  兜底：东方财富(SGE真值) → 招商银行(SGE真值) → 国际金价折算
//  说明：腾讯行情(qt.gtimg.cn)不含上金所裸金现货品种，但其黄金ETF(518880等)
//        实时价紧密跟踪 AU9999，反推即"腾讯系最准的国内裸金价"，与理财通黄金同基准。
// ============================================================

/**
 * 源1 [最权威]: 东方财富上金所 Au99.99
 *   secid=113.Au99.99 → f43=价格(分), f58=名称, f60=昨收(分)
 */
async function sourceEastmoney() {
  try {
    const apiUrl = `https://push2.eastmoney.com/api/qt/stock/get?secid=113.Au99.99&fields=f43,f57,f58,f60&ut=fa5fd1943c7b386f172d6893dbfba10b&cb=_&_=${Date.now()}`;
    const res = await fetchGet(apiUrl, {
      Referer: "https://quote.eastmoney.com",
      Origin: "https://quote.eastmoney.com"
    });
    let body = res.body.toString("utf-8");
    const m = body.match(/\((\{.*\})\)/s);
    if (!m) return null;
    const json = JSON.parse(m[1]);
    const d = json.data;
    if (d && d.f43 != null && d.f43 !== 0) {
      const price = d.f43 / 100;
      const prev = d.f60 != null ? d.f60 / 100 : price;
      console.log(`[源1-东方财富] ✅ ${d.f58}=${price.toFixed(2)} 元/克`);
      return {
        name: "国内金价",
        sub: "黄金9999",
        source: "东方财富(SGE官方)",
        official: true,
        price, chg: price - prev,
        pct: prev ? ((price - prev) / prev * 100) : 0
      };
    }
  } catch (e) { console.log(`[源1-东方财富] ✗ ${e.message}`); }
  return null;
}

/**
 * 源1 [最权威]: 招商银行个人贵金属行情接口（上金所 SGE 官方代销）
 *   GET https://m.cmbchina.com/api/rate/gold  → body.data[] 含全部品种
 *   取 goldNo=="AU9999" 的 curPrice/preClose/open/high/low/avePrice/tradeCount/upDown
 *
 * 注：东方财富 push2 接口已对 SGE 期货品种返回 rc:100 data:null（2026-08-05 验证），
 *     招行接口就成了唯一稳定的 SGE 官方价通道。该接口能给到最丰富的字段：
 *     - 现价/昨收/涨跌额 → 主字段
 *     - 今开/最高/最低 → K线描述符
 *     - 均价 → 可用于自选股补"当日均价"
 *     - 成交量(手) → 成交热度
 */
async function sourceCMB() {
  try {
    const apiUrl = "https://m.cmbchina.com/api/rate/gold";
    const res = await fetchGet(apiUrl, {
      Referer: "https://m.cmbchina.com/goldratedetail.html",
      Accept: "application/json, */*"
    });
    const json = JSON.parse(res.body.toString("utf-8"));
    const arr = (json && json.body && json.body.data) || [];
    const hit = arr.find(d => d.goldNo === "AU9999" || d.variety === "Au99.99");
    if (hit && hit.curPrice && parseFloat(hit.curPrice) > 0) {
      const price      = parseFloat(hit.curPrice);
      const prev       = parseFloat(hit.preClose) || price;
      const chg        = parseFloat(hit.upDown != null ? hit.upDown : (price - prev));
      const pct        = prev ? (chg / prev * 100) : 0;
      const open       = parseFloat(hit.open)       || null;
      const high       = parseFloat(hit.high)       || null;
      const low        = parseFloat(hit.low)        || null;
      const avg        = parseFloat(hit.avePrice)   || null;
      const volumeHand = parseFloat(hit.tradeCount) || null;   // 成交量(手)
      const updateTs   = hit.time ? String(hit.time) : "";
      console.log(`[源1-招商银行] ✅ Au99.99=${price.toFixed(2)} 元/克 (SGE官方, 开${open} 高${high} 低${low} 成交${volumeHand}手 @${updateTs})`);
      return {
        name: "国内金价",
        sub: "黄金9999",
        source: "招商银行(SGE官方)",
        official: true,
        price, chg, pct,
        open, preClose: prev, high, low, avg, volume: volumeHand, updateTime: updateTs
      };
    }
  } catch (e) { console.log(`[源1-招商银行] ✗ ${e.message}`); }
  return null;
}

/**
 * 源1c [已废弃]: 原天天基金(fundgz)黄金ETF估值接口 —— 该接口已于2026年下线（返回"页面未找到"），
 *   已从 fallback 链移除。保留函数定义仅供历史参考，请勿调用。
 *   （原注释误标"腾讯理财通"，实际是东方财富天天基金，并非腾讯系）
 *   GET https://fundgz.1234567.com.cn/js/{code}.js （单个代码，逐个请求）
 *   返回: jsonpgz({fundcode,name,dwjz,gsz,gszzl,gztime})
 *   取 gsz(估算净值) 均值 × RATIO ≈ Au99.99
 *   ⚠️ 批量逗号分隔URL会返回404，必须逐个代码请求
 */
async function sourceFundgz() {
  try {
    const etfCodes = ["518880", "518850", "159934", "159937", "518800"];
    const prices = [];
    const names = [];
    const pctList = [];

    // 逐个请求（批量URL已404失效，2026-07-08确认）
    for (const code of etfCodes) {
      try {
        const res = await fetchGet(`https://fundgz.1234567.com.cn/js/${code}.js`);
        const body = res.body.toString("utf-8");
        const m = body.match(/jsonpgz\((\{[^}]+\})\)/);
        if (m) {
          const j = JSON.parse(m[1]);
          if (j.gsz && parseFloat(j.gsz) > 0) {
            prices.push(parseFloat(j.gsz));
            names.push(j.name || j.fundcode);
            if (j.gszzl != null && !isNaN(parseFloat(j.gszzl))) pctList.push(parseFloat(j.gszzl));
          }
        }
      } catch (e2) { /* 单个失败跳过 */ }
    }

    if (prices.length === 0) return null;

    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    // 取 gszzl 均值作为涨跌幅%（ETF跟踪金价，涨跌幅基本一致）
    const avgPct = pctList.length > 0 ? pctList.reduce((a, b) => a + b, 0) / pctList.length : 0;
    // 实测校准（2026-07-08 10:25）：SGE黄金9999=900.50, 5只ETF gsz均值=8.7521 → RATIO≈102.9
    const RATIO = 102.9;
    const estPrice = avgPrice * RATIO;
    const estChg = avgPct !== 0 ? (estPrice * avgPct / 100) : 0;

    console.log(`[源1c-腾讯基金] ✅ ${names.length}只ETF均价=${avgPrice.toFixed(4)}, 反推Au99.99≈${estPrice.toFixed(2)} (×${RATIO}), 涨跌幅≈${avgPct.toFixed(2)}%`);
    return {
      name: "国内金价",
      sub: "黄金9999",
      source: "腾讯理财通",
      official: false,
      price: Math.round(estPrice * 100) / 100,
      chg: Math.round(estChg * 100) / 100,
      pct: Math.round(avgPct * 100) / 100
    };
  } catch (e) { console.log(`[源1c-腾讯基金] ✗ ${e.message}`); }
  return null;
}

/**
 * 源2 [腾讯行情]: 黄金ETF反推国内金价（备选）
 *   用腾讯可用的黄金ETF(如518880华安)实时净值 × 换算系数 ≈ Au99.99
 */
async function sourceTencentGoldETF() {
  try {
    // 取多个黄金ETF求平均，更稳定
    const etfCodes = ["s_sh518880", "s_sh518850", "s_sz159934"]; // 华安/华夏/易方达
    const apiUrl = `https://qt.gtimg.cn/q=${etfCodes.join(",")}`;
    const res = await fetchGet(apiUrl);
    const body = res.body.toString("utf-8");
    
    const prices = [];
    const pctList = [];
    etfCodes.forEach(code => {
      const re = new RegExp(`v_${code}="([^"]*)"`);
      const match = body.match(re);
      if (match && match[1]) {
        const f = match[1].split("~");
        if (f[3] && parseFloat(f[3]) > 0) {
          prices.push(parseFloat(f[3]));
          // 注：腾讯迷你行情(s_前缀)f[4]并非昨收，无法本地算涨跌；涨跌幅改由下方腾讯COMEX黄金近似
        }
      }
    });

    if (prices.length === 0) return null;
    
    // 平均ETF份额价格
    const avgEtfPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

    // 换算：黄金ETF每份≈对应 1/102.9 克实物黄金（基于Au99.99/ETF比值，2026-07-08实测校准，物理系数长期稳定）
    const RATIO = 102.9;
    const estPrice = avgEtfPrice * RATIO;

    // 涨跌幅：腾讯迷你行情(s_前缀)不含昨收，无法本地算涨跌；
    // 改用腾讯COMEX黄金(hf_GC,同一腾讯行情)涨跌幅近似——黄金全球定价，国内Au99.99涨跌幅≈国际涨跌幅，误差极小
    let pct = 0;
    try {
      const gres = await fetchGet("https://qt.gtimg.cn/q=hf_GC");
      const gm = gres.body.toString("utf-8").match(/v_hf_GC="([^"]*)"/);
      if (gm && gm[1]) {
        const gf = gm[1].split(",");
        const gp = parseFloat(gf[0]) || 0;   // COMEX现价
        const gc = parseFloat(gf[1]) || 0;   // COMEX涨跌
        if (gp - gc !== 0) pct = (gc / (gp - gc) * 100);
      }
    } catch (e2) { /* 涨跌幅近似失败则记0 */ }
    const estChg = estPrice * pct / 100;

    console.log(`[源2-腾讯理财通] ✅ ETF均价=${avgEtfPrice.toFixed(3)}×${RATIO}=${estPrice.toFixed(2)}元/克, 涨跌幅≈${pct.toFixed(2)}%(腾讯COMEX近似)`);
    return {
      name: "国内金价",
      sub: "黄金9999",
      source: "腾讯理财通(黄金ETF·AU9999)",
      official: false,
      price: Math.round(estPrice * 100) / 100,
      chg: Math.round(estChg * 100) / 100,
      pct: Math.round(pct * 100) / 100
    };
  } catch (e) { console.log(`[源2-黄金ETF] ✗ ${e.message}`); }
  return null;
}

/**
 * 源3 [兜底]: 国际金价 × 汇率 + 国内溢价修正
 *   纯理论折算通常偏低（缺国内溢价），+35元/克溢价修正
 */
async function sourceEstimate() {
  try {
    // 并发获取国际金价和汇率
    const [intlRes, rateRes] = await Promise.all([
      fetchGet("https://qt.gtimg.cn/q=hf_XAU"),
      fetchGet(`https://push2.eastmoney.com/api/qt/stock/get?secid=119.USDCNY&fields=f43&ut=fa5fd1943c7b386f172d6893dbfba10b&cb=_&_=${Date.now()}`)
    ].map(p => p.catch(() => null)));

    // 解析国际金价（含涨跌）
    let intlPrice = 0, intlChg = 0;
    if (intlRes) {
      const im = intlRes.body.toString("utf-8").match(/="(.+)"/);
      if (im) {
        const f = im[1].split(",");
        intlPrice = parseFloat(f[0]) || 0;
        intlChg = parseFloat(f[1]) || 0;
      }
    }

    // 解析汇率（默认7.25）
    let rate = 7.25;
    if (rateRes) {
      const rb = rateRes.body.toString("utf-8");
      const rm = rb.match(/\(\{[^}]*"f43"\s*:\s*(\d+)/);
      if (rm) rate = parseInt(rm[1]) / 100;
    }

    if (intlPrice <= 0) return null;

    // 折算（不含国内溢价/折价，纯理论值）
    // 注意：国内金价相对国际金价有时溢价、有时折价，波动范围约±50元/克
    // 此处仅返回理论折算值，由前端决定是否使用
    const rawEstimate = intlPrice * rate / 31.1035;
    const estPrice = Math.round(rawEstimate * 100) / 100;
    // 用国际金价涨跌幅近似国内金价涨跌幅
    const estChg = intlChg * rate / 31.1035;
    const prevPrice = intlPrice - intlChg;
    const estPct = prevPrice !== 0 ? (intlChg / prevPrice * 100) : 0;

    console.log(`[源3-折算兜底] ⚠️ 国际$${intlPrice.toFixed(2)} × 汇率${rate.toFixed(4)} ÷31.1035 = ${estPrice} (理论价,不含溢价)`);
    return {
      name: "国内金价",
      sub: "黄金9999",
      source: "国际金价×汇率",
      official: false,
      price: Math.round(estPrice * 100) / 100,
      chg: Math.round(estChg * 100) / 100,
      pct: Math.round(estPct * 100) / 100
    };
  } catch (e) { console.log(`[源3-折算] ✗ ${e.message}`); }
  return null;
}

// ============================================================
//  API 路由
// ============================================================

/** GET /api/domgold → 返回国内金价（fallback 链，支持 JSONP） */
async function handleDomGold(req, res, query) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] /api/domgold 请求`);

  // Fallback 链：依次尝试各源，第一个成功就返回
  // 优先级（2026-08-05 调整：金十数据官方 API 全部 secret-key 闭门 → 决定走 SGE 真值通道）：
  //   ① 招商银行 m.cmbchina.com (Au99.99, SGE 官方代销, 字段最全：开/高/低/均价/成交量)
  //   ② 东方财富 push2 secid=113.Au99.99 — 2026-08 起返回 rc:100 data:null（保留作恢复位）
  //   ③ 腾讯理财通 黄金ETF反推 (×102.9 系数) → 兜底，永远能算出一个值
  //   ④ 国际金价 × 汇率折算 → 最后兜底（约 6.65 汇率 ± 溢价）
  // 历史：本项目早期用腾讯ETF反推作主源，2026-08-05 因东财 SGE 接口被关闭，改招行作主源。
  let result =
    await sourceCMB() ||
    await sourceEastmoney() ||
    await sourceTencentGoldETF() ||
    await sourceEstimate();

  if (result) {
    sendJsonOrJsonp(req, res, query, 200, { ok: true, data: result });
  } else {
    sendJsonOrJsonp(req, res, query, 503, { ok: false, error: "所有数据源均不可用" });
  }
}

/** GET /api/intlgold → 返回国际金价（COMEX黄金，腾讯理财通同源，支持 JSONP） */
async function handleIntlGold(req, res, query) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] /api/intlgold 请求`);
  try {
    // 腾讯财经 COMEX 黄金期金 hf_GC（完整行情字段）
    const remote = await fetchGet("https://qt.gtimg.cn/q=hf_GC");
    const body = remote.body.toString("utf-8");
    const m = body.match(/v_hf_GC="([^"]*)"/);
    if (m && m[1]) {
      const f = m[1].split(",");
      const price    = parseFloat(f[0]) || 0;   // 最新价
      const chg      = parseFloat(f[1]) || 0;   // 涨跌额
      const open     = parseFloat(f[2]) || 0;   // 今开
      const prevClose= parseFloat(f[3]) || 0;   // 昨收
      const high     = parseFloat(f[4]) || 0;   // 最高
      const low      = parseFloat(f[5]) || 0;   // 最低
      // pct: 涨跌幅% = chg / 昨收 * 100（腾讯已提供涨跌额，用昨收计算最准）
      const pct = prevClose ? (chg / prevClose * 100) : 0;
      console.log(`[国际金价] ✅ COMEX黄金=${price.toFixed(2)} $/oz 开${open.toFixed(2)} 高${high.toFixed(2)} 低${low.toFixed(2)} 昨收${prevClose.toFixed(2)} (${pct.toFixed(2)}%)`);
      sendJsonOrJsonp(req, res, query, 200, { ok: true, data: {
        name: "国际金价", sub: "COMEX黄金",
        source: "腾讯理财通(COMEX期金)",
        price, chg, pct,
        open: open > 0 ? open : undefined,
        prevClose: prevClose > 0 ? prevClose : undefined,
        high: high > 0 ? high : undefined,
        low: low > 0 ? low : undefined
      }});
      return;
    }
  } catch (e) { console.log(`[国际金价] ✗ ${e.message}`); }
  sendJsonOrJsonp(req, res, query, 503, { ok: false, error: "COMEX黄金数据不可用" });
}

/** GET /api/tencent?codes=xxx → 转发腾讯行情接口 */
async function handleTencent(req, res, query) {
  const codes = query.codes;
  if (!codes) { res.writeHead(400); res.end('{"error":"缺少codes参数"}'); return; }
  try {
    const remote = await fetchGet(`https://qt.gtimg.cn?q=${codes}`);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(remote.body);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ============================================================
//  详情数据（5档盘口 + 基础报价全字段）—— 供「双击行 → 详情弹窗」用
//  数据源：新浪财经 hq.sinajs.cn（5档齐全 + 基础报价全字段，GBK 编码）
//  参数：secid = "1.600000" (沪) 或 "0.002384" (深)
//  转换：1.X → shX；0.X → szX
//  不足：不提供换手率/PE/振幅（前端显示 "—"）
//  优点：5档盘口 + 基础字段一次拿全，轻量稳定
// ============================================================
const SINA_HEADERS = {
  Referer: "https://finance.sina.com.cn",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
};

function secidToSina(secid) {
  if (secid.startsWith("1.")) return "sh" + secid.slice(2);
  if (secid.startsWith("0.")) return "sz" + secid.slice(2);
  if (secid.startsWith("116.")) return "hk" + secid.slice(4);  // 港股：116.07709 → hk07709
  return null;
}

function parseSinaHq(raw, secid) {
  const m = raw.match(/="([^"]+)"/);
  if (!m) return null;
  const f = m[1].split(",");
  const isHK = secid.startsWith("116.");

  // ===== 港股 hq 字段（19 字段，顺序与 A股不同） =====
  if (isHK) {
    if (f.length < 19) return null;
    // [0] 英文名 [1] 中文名 [2]open [3]prevClose [4]high [5]low [6]current
    // [7]change [8]pct [9]bid1 [10]ask1 [11]amount [12]volume(股)
    // [13]/[14] 0 [15]52wk高 [16]52wk低 [17]date [18]time
    const name = f[1] || f[0];
    const open = parseFloat(f[2]);
    const prevClose = parseFloat(f[3]);
    const high = parseFloat(f[4]);
    const low = parseFloat(f[5]);
    const price = parseFloat(f[6]);
    const chg = parseFloat(f[7]);
    const pct = parseFloat(f[8]);
    const amount = parseFloat(f[11]);
    const volume = parseFloat(f[12]);  // 单位：股
    const hi52w = parseFloat(f[15]);
    const lo52w = parseFloat(f[16]);
    // 振幅：(high - low) / prevClose * 100
    const amplitude = prevClose > 0 ? (high - low) / prevClose * 100 : null;
    const bid1 = parseFloat(f[9]);
    const ask1 = parseFloat(f[10]);
    return {
      secid,
      code: "hk" + secid.slice(4),
      name: name,
      price: price,
      chg: chg,
      pct: pct,
      open: open,
      prevClose: prevClose,
      high: high,
      low: low,
      volume: volume / 100,  // 股 → 手
      amount: amount,
      turnover: null,
      pe: null,
      amplitude: amplitude,
      // 港股 hq 没有 5档盘口，只有 bid1/ask1，包装成 1 档
      bid: bid1 > 0 ? [{ price: bid1, volume: 0 }] : [],
      ask: ask1 > 0 ? [{ price: ask1, volume: 0 }] : [],
      // 港股扩展：52周高低/日期时间
      high52w: hi52w > 0 ? hi52w : null,
      low52w: lo52w > 0 ? lo52w : null,
      marketTime: (f[17] || "") + " " + (f[18] || ""),
      source: "新浪财经(港股)"
    };
  }

  // ===== A股 hq 字段（30+ 字段，5档盘口） =====
  if (f.length < 30) return null;
  // sina 字段: [0]name [1]open [2]prevClose [3]current [4]high [5]low
  // [6]竞买价(买一) [7]竞卖价(卖一) [8]volume(股) [9]amount(元)
  // [10..19] buy1..5  (量,价 交替) [10]b1v [11]b1p ... [18]b5v [19]b5p
  // [20..29] sell1..5 [20]s1v [21]s1p ... [28]s5v [29]s5p
  const bid = [];
  const ask = [];
  for (let i = 0; i < 5; i++) {
    bid.push({ price: parseFloat(f[11 + i*2]), volume: parseFloat(f[10 + i*2]) });
    ask.push({ price: parseFloat(f[21 + i*2]), volume: parseFloat(f[20 + i*2]) });
  }
  const filt = arr => arr.filter(r => r.price > 0 && !isNaN(r.price));
  const price = parseFloat(f[3]);
  const prevClose = parseFloat(f[2]);
  const chg = price - prevClose;
  return {
    secid,
    code: secidToSina(secid),
    name: f[0],
    price,
    chg,
    pct: prevClose ? (chg / prevClose * 100) : 0,
    open: parseFloat(f[1]),
    prevClose,
    high: parseFloat(f[4]),
    low: parseFloat(f[5]),
    volume: parseFloat(f[8]) / 100,  // 股 → 手
    amount: parseFloat(f[9]),
    turnover: null,
    pe: null,
    amplitude: null,
    bid: filt(bid),
    ask: filt(ask),
    source: "新浪财经"
  };
}

// 腾讯财经详情兜底解析（机房 IP 友好，与新浪同字段结构输出）
// 数据源：qt.gtimg.cn/q={code}（GBK 编码，"~" 分隔）
// 字段布局（实测 2026-08-10）：
//   [1]名 [3]现价 [4]昨收 [5]今开 [9/11/13/15/17]买一~五价 [10/12/14/16/18]买一~五量
//   [19/21/23/25/27]卖一~五价 [20/22/24/26/28]卖一~五量 [30]时间 [31]涨跌 [32]涨跌幅%
//   [33]最高 [34]最低 [35]"现价/量(手)/额(元)" [36]量(手) [37]额(万元, A股)
//   港股：[9]/[19] 仅等于现价（无深度），量在 [36](股)、额在 [37](元)，[35] 无 "/"
function parseTencentHq(body, sinaCode, secid) {
  const re = new RegExp(`v_${sinaCode}="([^"]*)"`);
  const m = body.match(re);
  if (!m) return null;
  const f = m[1].split("~");
  const isHK = secid.startsWith("116.");
  const name = f[1] || "";
  const price = parseFloat(f[3]);
  const prevClose = parseFloat(f[4]);
  const open = parseFloat(f[5]);
  const high = parseFloat(f[33]);
  const low = parseFloat(f[34]);
  const chg = parseFloat(f[31]);
  const pct = parseFloat(f[32]);
  if (![price, prevClose, high, low].every(x => x > 0)) return null;

  let volume = NaN, amount = NaN;
  if (f[35] && f[35].includes("/")) {
    const p = f[35].split("/");
    volume = parseFloat(p[1]);   // 手
    amount = parseFloat(p[2]);   // 元
  } else {
    volume = parseFloat(f[36]);  // 股（港股）
    amount = parseFloat(f[37]);  // 元
  }
  const amplitude = (prevClose > 0 && high > 0 && low > 0) ? (high - low) / prevClose * 100 : null;

  const bid = [], ask = [];
  if (!isHK) {
    for (let i = 0; i < 5; i++) {
      const bp = parseFloat(f[9 + 2 * i]);
      const bv = parseFloat(f[10 + 2 * i]);
      if (bp > 0) bid.push({ price: bp, volume: bv || 0 });
      const ap = parseFloat(f[19 + 2 * i]);
      const av = parseFloat(f[20 + 2 * i]);
      if (ap > 0) ask.push({ price: ap, volume: av || 0 });
    }
  }
  return {
    secid,
    code: sinaCode,
    name,
    price, chg, pct,
    open, prevClose, high, low,
    volume, amount,
    turnover: null,
    pe: null,
    amplitude,
    bid, ask,
    source: "腾讯财经"
  };
}

async function handleDetail(req, res, query) {
  const secid = query.secid;
  if (!secid) { res.writeHead(400); res.end('{"error":"缺少secid"}'); return; }
  const sinaCode = secidToSina(secid);
  if (!sinaCode) { res.writeHead(400); res.end('{"error":"不支持的市场"}'); return; }
  try {
    // 1) 新浪优先（A股/港股 5档齐全，GBK）
    try {
      const r = await fetchGet(`https://hq.sinajs.cn/list=${sinaCode}`, SINA_HEADERS);
      // 注意：Node Buffer.toString 不支持 "gbk"，必须用全局 TextDecoder
      const body = new TextDecoder("gbk").decode(r.body);
      const data = parseSinaHq(body, secid);
      if (data) { sendJsonOrJsonp(req, res, query, 200, { ok: true, data }); return; }
    } catch (e) {
      console.warn("[/api/detail] 新浪失败，转腾讯兜底:", e.message);
    }
    // 2) 腾讯兜底（机房 IP 友好，主页同源）
    try {
      const tr = await fetchGet(`https://qt.gtimg.cn/q=${sinaCode}`);
      const tbody = new TextDecoder("gbk").decode(tr.body);
      const tdata = parseTencentHq(tbody, sinaCode, secid);
      if (tdata) { sendJsonOrJsonp(req, res, query, 200, { ok: true, data: tdata }); return; }
    } catch (e) {
      console.error("[/api/detail] 腾讯兜底失败:", e.message);
    }
    sendJsonOrJsonp(req, res, query, 502, { ok: false, error: "新浪/腾讯均无有效行情" });
  } catch (e) {
    console.error("[/api/detail]", e.message);
    sendJsonOrJsonp(req, res, query, 502, { ok: false, error: e.message });
  }
}

// 腾讯财经分时请求头（ifzq.gtimg.cn 对 referer 不敏感，但带 UA 更稳）
const TENCENT_HEADERS = {
  Referer: "https://gu.qq.com",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
};

// 东方财富请求头（push2 / push2his / quote.eastmoney 都需要合法 Referer 才能返回数据）
const EM_HEADERS = {
  Referer: "https://quote.eastmoney.com",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
};

/** GET /api/trends?secid=1.600000&type=5day → 当日/5日分时（最近交易日 / 最近 5 个交易日）
 *  数据源：
 *   - type 默认 = 当日分时：腾讯 ifzq minute/query（与主页同源，免 WAF）
 *   - type=5day：东财 push2his trends2 ndays=5（5日分钟，最全）
 *  昨收/名称：新浪 hq（GBK → TextDecoder）。
 *  均价：腾讯接口无 avg 字段 → 服务端计算 avg = amount / (volume * 100) 还原均价/股；东财已自带 avg 末列。 */
async function handleTrends(req, res, query) {
  const secid = query.secid;
  if (!secid) { sendJsonOrJsonp(req, res, query, 400, { ok: false, error: "缺少secid" }); return; }
  const sinaCode = secidToSina(secid);
  if (!sinaCode) { sendJsonOrJsonp(req, res, query, 400, { ok: false, error: "不支持的市场" }); return; }
  const type = (query.type || "").toLowerCase();

  // ---- 5 日分时：东财 push2his trends2 ----
  if (type === "5day" || type === "five") {
    try {
      const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&ndays=5&fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0`;
      const r = await fetchGet(url, EM_HEADERS);
      const j = JSON.parse(r.body.toString("utf-8"));
      const trends = j && j.data && j.data.trends;
      if (!Array.isArray(trends) || trends.length === 0) {
        sendJsonOrJsonp(req, res, query, 404, { ok: false, error: "东财 5 日分时无数据" });
        return;
      }
      const points = trends.map(line => {
        const p = line.split(",");
        // 东财 5day 分钟实测格式（共 8 列）：
        //  [时间, 涨额或前价, close, high, low, vol(手), amount(元), avg(元/股)]
        //  p[0]="2026-07-30 09:40", p[1]="0.00", p[2]=close, p[3]=hi,
        //  p[4]=lo, p[5]=vol(手), p[6]=amount(元), p[7]=avg(元/股)
        const day = p[0].slice(0, 10);
        const t = p[0].slice(11);
        const price = parseFloat(p[2]);
        const vol = parseFloat(p[5]);
        const amount = parseFloat(p[6]);
        const avg = parseFloat(p[7]);
        return { day, t, price, avg, vol, amount };
      }).filter(x => !isNaN(x.price));

      // 取最近一日的昨收 + 名称（新浪）
      let prevClose = null, name = "";
      try {
        const sinaR = await fetchGet(`https://hq.sinajs.cn/list=${sinaCode}`, SINA_HEADERS);
        const sb = new TextDecoder("gbk").decode(sinaR.body);
        const sm = sb.match(/="([^"]+)"/);
        if (sm) {
          const f = sm[1].split(",");
          prevClose = parseFloat(f[2]);
          name = f[0];
        }
      } catch (_) {}

      sendJsonOrJsonp(req, res, query, 200, {
        ok: true,
        type: "5day",
        data: { secid, code: sinaCode, name, prevClose, points }
      });
    } catch (e) {
      console.error("[/api/trends?type=5day]", e.message);
      sendJsonOrJsonp(req, res, query, 502, { ok: false, error: "5 日分时拉取失败：" + e.message });
    }
    return;
  }

  // ---- 默认：当日分时（腾讯 ifzq + 新浪昨收）----
  try {
    const [minR, sinaR] = await Promise.all([
      fetchGet(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${sinaCode}`, TENCENT_HEADERS),
      fetchGet(`https://hq.sinajs.cn/list=${sinaCode}`, SINA_HEADERS)
    ]);
    const mj = JSON.parse(minR.body.toString("utf-8"));
    const inner = mj.data && mj.data[sinaCode] && mj.data[sinaCode].data;
    if (!inner || !Array.isArray(inner.data) || inner.data.length === 0) {
      sendJsonOrJsonp(req, res, query, 404, { ok: false, error: "无分时数据" });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const points = inner.data.map(line => {
      const p = line.split(/\s+/);
      const t = p[0];
      const price = parseFloat(p[1]);
      const vol = parseFloat(p[2]);      // 累计手
      const amount = parseFloat(p[3]);    // 累计元
      // 均价 / 股 = 累计金额 / (累计手 × 100股)
      const avg = (vol > 0) ? (amount / (vol * 100)) : NaN;
      return { day: today, t, price, avg, vol, amount };
    }).filter(x => !isNaN(x.price));

    let prevClose = null, name = "";
    try {
      const sb = new TextDecoder("gbk").decode(sinaR.body);
      const sm = sb.match(/="([^"]+)"/);
      if (sm) {
        const f = sm[1].split(",");
        prevClose = parseFloat(f[2]);
        name = f[0];
      }
    } catch (_) {}

    sendJsonOrJsonp(req, res, query, 200, {
      ok: true,
      type: "trend",
      data: { secid, code: sinaCode, name, prevClose, points }
    });
  } catch (e) {
    console.error("[/api/trends]", e.message);
    sendJsonOrJsonp(req, res, query, 502, { ok: false, error: e.message });
  }
}

/** GET /api/mini?codes=s_sh601138,s_sz000063,... → 批量「当日分时迷你走势」（自选股行内趋势线）
 *  数据源：腾讯 ifzq appstock/minute/query（与详情弹窗分时同源）
 *  注意：该接口 **不支持批量**（逗号会返回 code param error）→ 服务端并发拉取 + TTL 缓存聚合
 *  返回 data: { "s_sh601138": { p:[降采样价格≤60点], n:原始分钟数, t1:"1028" }, ... }
 *  取不到的标的（如黄金 hf_GC）不会出现在 data 里，前端该格留空即可。 */
const MINI_CACHE = new Map();        // code -> { ts, payload|null }（null 也缓存，避免反复重试）
const MINI_TTL = 25000;              // 25s，短于前端 30s 轮询
const MINI_MAXP = 60;                // 迷你走势线最多 60 点（宽 60~70px 足够）

/** 前端代码 → 腾讯分钟接口代码：s_sh601138→sh601138 / s_r_hk00700→hk00700 / s_r_hkHSI→hkHSI */
function miniCode(code) {
  let m;
  if ((m = /^s_sh(\d{6})$/.exec(code))) return "sh" + m[1];
  if ((m = /^s_sz(\d{6})$/.exec(code))) return "sz" + m[1];
  if ((m = /^s_r_hk0*(\d{4,5})$/.exec(code))) return "hk" + m[1].padStart(5, "0");
  if (code === "s_r_hkHSI") return "hkHSI";
  return null;
}

/** 并发受限 map：避免一次打出 30+ 请求被腾讯频控 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  };
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

/** 拉单只标的的分钟价序列；失败/不支持返回 null
 *  采样为「时段锚定」：每个点带交易时段内的分钟位置（含午休修正），
 *  已返回的点位置永不变化 → 前端曲线只向右生长，不会整条变形（旧版按点数均分，每分钟整条重排）。 */
async function fetchMiniOne(code) {
  const tc = miniCode(code);
  if (!tc) return null;
  const r = await fetchGet(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${tc}`, TENCENT_HEADERS);
  const j = JSON.parse(r.body.toString("utf-8"));
  const node = j && j.data && j.data[tc];
  const arr = node && node.data && node.data.data;
  if (!Array.isArray(arr) || arr.length < 2) return null;
  // 每行 "HHMM 价格 累计手 累计额" → [时段内分钟, 价格]
  const hk = /^hk/.test(tc);
  const total = hk ? 330 : 240;          // 全时段分钟数（09:30 起算，含午休）
  const lunchGap = hk ? 60 : 90;         // 午休：HK 12:00→13:00 差 60；A股 11:30→13:00 差 90
  const seq = [];
  for (const line of arr) {
    const f = line.split(/\s+/);
    const v = parseInt(f[0], 10);
    const price = parseFloat(f[1]);
    if (!isFinite(v) || !isFinite(price)) continue;
    const hm = Math.floor(v / 100) * 60 + (v % 100);
    let smin = hm - 570;                 // 相对 09:30
    if (smin < 0) smin = 0;
    if (hm >= 780) smin -= lunchGap;     // 13:00 起扣掉午休
    seq.push([smin, price]);
  }
  if (seq.length < 2) return null;
  // 固定槽位采样：每 stride 个时段分钟一个点（A股 stride=4 → 最多 60 槽）
  const stride = Math.ceil(total / MINI_MAXP);
  const p = [], m = [];
  let k = 0;
  for (let slot = 0; slot * stride <= total && k < seq.length; slot++) {
    const target = slot * stride;
    while (k < seq.length && seq[k][0] < target) k++;
    if (k >= seq.length) break;
    p.push(seq[k][1]); m.push(seq[k][0]);
  }
  // 永远补上最新一分钟，保证线画到"当前时刻"
  const lastS = seq[seq.length - 1][0];
  if (m.length === 0 || m[m.length - 1] !== lastS) { p.push(seq[seq.length - 1][1]); m.push(lastS); }
  return { p, m, total, n: arr.length, t1: String(arr[arr.length - 1].split(/\s+/)[0] || "") };
}

async function handleMini(req, res, query) {
  const codes = String(query.codes || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 80);
  if (!codes.length) { sendJsonOrJsonp(req, res, query, 400, { ok: false, error: "缺少codes" }); return; }
  const now = Date.now();
  const data = {};
  const need = [];
  codes.forEach(c => {
    const hit = MINI_CACHE.get(c);
    if (hit && now - hit.ts < MINI_TTL) { if (hit.payload) data[c] = hit.payload; }
    else need.push(c);
  });
  if (need.length) {
    try {
      const rs = await mapLimit(need, 6, async (c) => {
        try { return [c, await fetchMiniOne(c)]; } catch (_) { return [c, null]; }
      });
      rs.forEach(([c, v]) => {
        MINI_CACHE.set(c, { ts: Date.now(), payload: v });
        if (v) data[c] = v;
      });
    } catch (e) {
      console.error("[/api/mini]", e.message);
    }
  }
  sendJsonOrJsonp(req, res, query, 200, { ok: true, data });
}

// ============================================================
//  K线数据（腾讯 fqkline/get，前复权，日/周/月）
//  URL: https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sz000063,day,,,60,qfq
//  返回: data.{code}.{qfqday|qfqweek|qfqmonth} = [[date,open,close,high,low,vol], ...]
//  同时 qt.{code} 含实时报价（含昨收、5档），可一并返回
// ============================================================
async function handleKline(req, res, query) {
  const secid = query.secid;
  const period = (query.period || "day").toLowerCase();
  if (!secid) { res.writeHead(400); res.end('{"error":"缺少secid"}'); return; }
  const sinaCode = secidToSina(secid);
  if (!sinaCode) { res.writeHead(400); res.end('{"error":"不支持的市场"}'); return; }
  // period → 腾讯字段名映射（A股是 qfq 前复权，港股是裸字段 day/week/month）
  const PERIOD_MAP_QFQ = {
    day:   "qfqday",
    week:  "qfqweek",
    month: "qfqmonth"
  };
  const PERIOD_MAP = {
    day:   "day",
    week:  "week",
    month: "month"
  };
  const count = Math.min(parseInt(query.count || "60") || 60, 320);
  try {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sinaCode},${period},,,${count},qfq`;
    const r = await fetchGet(url, TENCENT_HEADERS);
    const j = JSON.parse(r.body.toString("utf-8"));
    if (j.code !== 0 || !j.data || !j.data[sinaCode]) {
      sendJsonOrJsonp(req, res, query, 502, { ok: false, error: "无效K线响应" });
      return;
    }
    // A股优先取 qfqday/qfqweek/qfqmonth；港股 fallback 取 day/week/month
    const tname = PERIOD_MAP_QFQ[period];
    const tnameH = PERIOD_MAP[period];
    const rawBars = j.data[sinaCode][tname] || j.data[sinaCode][tnameH] || [];
    const arr = rawBars.map(k => ({
      date:  k[0],
      open:  parseFloat(k[1]),
      close: parseFloat(k[2]),
      high:  parseFloat(k[3]),
      low:   parseFloat(k[4]),
      vol:   parseFloat(k[5])  // 成交量（股）
    })).filter(b => !isNaN(b.close));

    // 提取 qt 实时报价（数组里含当前价、涨跌、5档等），便于前端一次拿全
    const qt = j.data[sinaCode].qt && j.data[sinaCode].qt[sinaCode];
    let quoteExtra = null;
    if (qt && Array.isArray(qt)) {
      quoteExtra = {
        name: qt[1],
        code: qt[2],
        price: parseFloat(qt[3]) || null,
        prevClose: parseFloat(qt[4]) || null,
        open: parseFloat(qt[5]) || null,
        volume: parseFloat(qt[6]) || null,    // 成交量(手)
        amount: parseFloat(qt[7]) || null     // 成交额(万元)
      };
    }
    sendJsonOrJsonp(req, res, query, 200, {
      ok: true,
      data: { secid, code: sinaCode, period, bars: arr, quote: quoteExtra }
    });
  } catch (e) {
    console.error("[/api/kline]", e.message);
    sendJsonOrJsonp(req, res, query, 502, { ok: false, error: e.message });
  }
}

// ============================================================
//  资金流（东财 push2his fflow/daykline，历史每日主力净额 + 涨跌幅）
//  URL: https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=0.000063&klt=1&fields2=f51,f52,f53,f54,f55,f56,f57,f58&...
//  返回 klines 数组每条: [date, 主力净流入, 中单, 小单, 大单, 特大单, 主力涨跌幅%, 股价涨跌幅%]
//  注：f57/f58 单位为 %（已是非倍数小数）
// ============================================================
async function handleFundFlow(req, res, query) {
  const secid = query.secid;
  if (!secid) { res.writeHead(400); res.end('{"error":"缺少secid"}'); return; }
  // 东财 secid 格式与新浪不同：沪 1.6xxxxx → "1.6xxxxx"，深 0.0xxxxx → "0.0xxxxx"
  // 东财支持的 secid 直接复用（前面是市场代码）
  const count = Math.min(parseInt(query.count || "60") || 60, 500);
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${encodeURIComponent(secid)}&klt=1&lmt=0&fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56,f57,f58&pi=0&po=1`;
  const hdrs = {
    Referer: "https://quote.eastmoney.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
  };
  // 连接级错误（socket hang up / ECONNRESET）通常是上游防火墙/维护，重试无意义，直接失败；
  // 超时等瞬态错误重试一次，提升恢复概率
  const isConnError = m => /socket hang|ECONNRESET|ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(m || "");
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchGet(url, hdrs);
      const j = JSON.parse(r.body.toString("utf-8"));
      if (j.rc !== 0 || !j.data || !j.data.klines) {
        sendJsonOrJsonp(req, res, query, 502, { ok: false, error: "无效资金流响应" });
        return;
      }
      const arr = j.data.klines.slice(-count).map(line => {
        const p = line.split(",");
        return {
          date: p[0],
          mainInflow: parseFloat(p[1]),   // 主力净流入（元，正负）
          midInflow:  parseFloat(p[2]),   // 中单
          smallInflow: parseFloat(p[3]),  // 小单
          bigInflow: parseFloat(p[4]),    // 大单
          superInflow: parseFloat(p[5]),  // 特大单
          mainPct: parseFloat(p[6]),      // 主力净额涨跌幅%（东财定义）
          chgPct:  parseFloat(p[7])       // 当日股价涨跌幅%
        };
      });
      sendJsonOrJsonp(req, res, query, 200, {
        ok: true,
        data: { secid, name: j.data.name, flow: arr }
      });
      return;
    } catch (e) {
      lastErr = e;
      if (isConnError(e.message)) break;   // 连接级错误不再重试
    }
  }
  console.error("[/api/fundflow]", lastErr && lastErr.message);
  sendJsonOrJsonp(req, res, query, 502, { ok: false, error: (lastErr && lastErr.message) || "资金流拉取失败" });
}

// ============================================================
//  补充字段（新浪无换手率/振幅/量比，从东财 push2 拿）
//  URL: https://push2.eastmoney.com/api/qt/stock/get?secid=0.000063&fields=f167,f168,f169,f170,f43,f60&invt=2
//  字段：f43=当前(分), f60=昨收(分), f167=涨幅%(×100), f168=振幅%(×100), f169=换手率%(×100), f170=量比(×100)
// ============================================================
async function handleQuoteExtra(req, res, query) {
  const secid = query.secid;
  if (!secid) { res.writeHead(400); res.end('{"error":"缺少secid"}'); return; }
  try {
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=f43,f44,f45,f46,f60,f167,f168,f169,f170,f163,f164&invt=2&fltt=2`;
    const r = await fetchGet(url, {
      Referer: "https://quote.eastmoney.com",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    });
    const j = JSON.parse(r.body.toString("utf-8"));
    if (j.rc !== 0 || !j.data) {
      sendJsonOrJsonp(req, res, query, 502, { ok: false, error: "无效报价响应" });
      return;
    }
    const d = j.data;
    // 注：东财 push2 字段单位 (2026 最新)：
    //   f43/f46/f44/f45/f60  → 直接是「元」（不带小数倍）
    //   f167/f168/f169       → 直接是「百分比数字」（如 2.22 表示 2.22%）
    //   f170                 → 量比（如 1.37 倍）
    //   f163                 → 总市值「亿元」
    //   f164                 → 流通市值「亿元」
    sendJsonOrJsonp(req, res, query, 200, {
      ok: true,
      data: {
        secid,
        price:    d.f43,           // 元
        open:     d.f46,           // 元
        high:     d.f44,           // 元
        low:      d.f45,           // 元
        prevClose: d.f60,          // 元
        pct:      d.f167,          // 涨幅% （如 2.22）
        amplitude: d.f168,         // 振幅%
        turnover: d.f169,          // 换手率%
        volumeRatio: d.f170,       // 量比
        marketCap: d.f163,         // 总市值（亿元）
        floatCap:  d.f164          // 流通市值（亿元）
      }
    });
  } catch (e) {
    console.error("[/api/quote]", e.message);
    sendJsonOrJsonp(req, res, query, 502, { ok: false, error: e.message });
  }
}

// ============================================================
//  金十数据 (Jin10) MCP 客户端  [2026-08-05 接入，用户已申请 secret-key]
//  标准 MCP(Streamable HTTP) 流程：
//    initialize → notifications/initialized → (tools/list / resources/list) → tools/call / resources/read
//  协议版本：2025-11-25（推荐）
//  认证：Authorization: Bearer <TOKEN>（直接使用 Bearer Token 访问）
//  响应：text/event-stream(SSE)，每行 "data: {jsonrpc...}"
//  结果读取优先级：result.structuredContent（机器解析） → result.content[0].text（可读文本兜底，不作主解析源）
//  分页约定（列表类工具）：请求参数 cursor；响应字段 data.next_cursor / data.has_more
//  已验证工具：get_quote / get_kline / list_flash / search_flash / list_news / search_news / get_news / list_calendar
//  已验证资源：quote://codes（支持的报价品种代码列表）
//  常用品种：XAUUSD 现货黄金 / ZHJCJ 招行积存金 / XAGUSD 现货白银 / USOIL WTI / UKOIL 布伦特 / COPPER 铜 / USDJPY / EURUSD / USDCNH
//  注意：金十无纯 SGE Au99.99/Au(T+D)，国内金走银行积存金通道（招行积存金最贴近 Au(T+D)）
//  频控：每个用户每工具每日上限 1500 次（北京时间自然日），服务端做 TTL 缓存兜底
//  安全：生产环境请务必通过环境变量 JIN10_TOKEN=xxx 注入，不要硬编码 token 到代码中
// ============================================================
const JIN10_TOKEN = process.env.JIN10_TOKEN || "";
const JIN10_MCP_HOST = "mcp.jin10.com";
const JIN10_MCP_PATH = "/mcp";
const JIN10_PROTOCOL = "2025-11-25";

let _jin10SessionId = null;
let _jin10SessionUntil = 0;

// 简易内存缓存，避免触碰金十频控（免费额度有限）
const _jin10Cache = new Map();
function jin10CacheGet(key, ttlMs) {
  const c = _jin10Cache.get(key);
  if (c && (Date.now() - c.ts) < ttlMs) return c.data;
  return null;
}
function jin10CacheSet(key, data) { _jin10Cache.set(key, { ts: Date.now(), data }); }

function mcpHttpsPost(bodyObj, sessionId) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const headers = {
      "Authorization": "Bearer " + JIN10_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "User-Agent": "yuanbao-proxy/2.0"
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const req = https.request({
      host: JIN10_MCP_HOST, path: JIN10_MCP_PATH, method: "POST",
      headers, timeout: 15000
    }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode,
        sessionId: res.headers["mcp-session-id"],
        body: Buffer.concat(chunks).toString("utf-8")
      }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("金十 MCP 超时")); });
    req.write(body); req.end();
  });
}

function parseSSE(raw) {
  const out = []; let buf = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) buf = { event: line.slice(6).trim(), data: "" };
    else if (line.startsWith("data:")) { const d = line.slice(5).trim(); if (buf) buf.data += d; else buf = { event: "message", data: d }; }
    else if (line.trim() === "") { if (buf && buf.data) { try { out.push(JSON.parse(buf.data)); } catch (e) {} buf = null; } }
  }
  if (buf && buf.data) { try { out.push(JSON.parse(buf.data)); } catch (e) {} }
  return out;
}

async function jin10EnsureSession() {
  if (_jin10SessionId && Date.now() < _jin10SessionUntil) return _jin10SessionId;
  const init = await mcpHttpsPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: JIN10_PROTOCOL, capabilities: {}, clientInfo: { name: "yuanbao", version: "2.0.0" } } }, null);
  if (init.status !== 200 || !init.sessionId) throw new Error("金十 MCP 初始化失败 status=" + init.status);
  _jin10SessionId = init.sessionId;
  _jin10SessionUntil = Date.now() + 4 * 60 * 1000; // 会话 4 分钟内复用
  await mcpHttpsPost({ jsonrpc: "2.0", method: "notifications/initialized" }, _jin10SessionId).catch(() => {});
  return _jin10SessionId;
}

// 标准 MCP：tools/list（缓存，避免重复流量）
let _jin10ToolsCache = null;
async function jin10ListTools() {
  if (_jin10ToolsCache) return _jin10ToolsCache;
  const sid = await jin10EnsureSession();
  const r = await mcpHttpsPost({ jsonrpc: "2.0", id: Date.now(), method: "tools/list", params: {} }, sid);
  const msgs = parseSSE(r.body);
  const tools = (msgs[0] && msgs[0].result && msgs[0].result.tools) || [];
  _jin10ToolsCache = tools;
  return tools;
}

// 标准 MCP：resources/list + resources/read
let _jin10ResCache = null;
async function jin10ListResources() {
  if (_jin10ResCache) return _jin10ResCache;
  const sid = await jin10EnsureSession();
  const r = await mcpHttpsPost({ jsonrpc: "2.0", id: Date.now(), method: "resources/list", params: {} }, sid);
  const msgs = parseSSE(r.body);
  const resources = (msgs[0] && msgs[0].result && msgs[0].result.resources) || [];
  _jin10ResCache = resources;
  return resources;
}

async function jin10ReadResource(uri) {
  const sid = await jin10EnsureSession();
  const r = await mcpHttpsPost({ jsonrpc: "2.0", id: Date.now(), method: "resources/read", params: { uri } }, sid);
  const msgs = parseSSE(r.body);
  const result = msgs[0] && msgs[0].result;
  // resources/read 返回 { contents: [{ uri, mimeType, text }] }，text 为 JSON 字符串
  const txt = (result && result.contents && result.contents[0] && result.contents[0].text) || "";
  if (!txt) throw new Error("资源 " + uri + " 无内容");
  try { return JSON.parse(txt); } catch (e) { throw new Error("资源 " + uri + " 解析失败：" + e.message); }
}

// 标准 MCP：tools/call。返回完整 result（含 structuredContent）；会话失效自动重建重试一次
async function jin10CallTool(toolName, args) {
  const call = async (s) => {
    const r = await mcpHttpsPost({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: toolName, arguments: args } }, s);
    const msgs = parseSSE(r.body);
    return { status: r.status, result: msgs[0] && msgs[0].result };
  };
  let sid = await jin10EnsureSession();
  let resp = await call(sid);
  const msg = (resp.result && resp.result.structuredContent && resp.result.structuredContent.message)
    || (resp.result && resp.result.content && resp.result.content[0] && resp.result.content[0].text) || "";
  const isSessionErr = resp.status === 400 ||
    (resp.result && resp.result.isError && /session|会话|expired|失效/i.test(msg));
  if (isSessionErr) {
    _jin10SessionId = null;
    sid = await jin10EnsureSession();
    resp = await call(sid);
  }
  return resp;
}

// 结果提取：优先 result.structuredContent（机器解析）；result.content[0].text 仅作可读文本兜底
function jin10Extract(result) {
  if (!result) return { status: 500, message: "无响应", data: null };
  const sc = result.structuredContent;
  if (sc && typeof sc === "object") {
    // 标准形状：{ status, message, data }
    const data = (sc.data !== undefined) ? sc.data : sc;
    return { status: (sc.status != null) ? sc.status : 200, message: sc.message || "", data, structured: true };
  }
  // 兜底：content[0].text 作为可读文本
  const txt = (result.content && result.content[0] && result.content[0].text) || "";
  try {
    const parsed = JSON.parse(txt);
    const data = (parsed.data !== undefined) ? parsed.data : parsed;
    return { status: (parsed.status != null) ? parsed.status : 200, message: parsed.message || "", data, text: txt };
  } catch (e) {
    return { status: result.isError ? 400 : 200, message: txt || "工具返回非 JSON 文本", data: null };
  }
}

// 数字规整：金十所有数值字段均为字符串（volume 例外为 number），统一转 number（空/NaN → null）
function jn(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

/** GET /api/jin10/quote?code=XAUUSD → 金十实时行情（现货黄金/招行积存金等） */
async function handleJin10Quote(req, res, query) {
  const code = (query.code || "XAUUSD").toUpperCase();
  const cacheKey = "q:" + code;
  let payload = jin10CacheGet(cacheKey, 5000);
  if (!payload) {
    try {
      const resp = await jin10CallTool("get_quote", { code });
      const ext = jin10Extract(resp.result);
      if (ext.status !== 200 || !ext.data) {
        sendJsonOrJsonp(req, res, query, 502, { ok: false, error: "金十报价失败：" + (ext.message || "无数据") });
        return;
      }
      const d = ext.data;
      // 规整数值字段（金十返回字符串）
      payload = {
        code: d.code || code,
        name: d.name || code,
        time: d.time || null,
        open: jn(d.open),
        close: jn(d.close),
        high: jn(d.high),
        low: jn(d.low),
        volume: jn(d.volume),
        ups_price: jn(d.ups_price),
        ups_percent: jn(d.ups_percent)
      };
      jin10CacheSet(cacheKey, payload);
    } catch (e) {
      sendJsonOrJsonp(req, res, query, 502, { ok: false, error: e.message });
      return;
    }
  }
  console.log(`[${new Date().toISOString().slice(11,19)}] /api/jin10/quote?code=${code} ✅ close=${payload.close} ups_pct=${payload.ups_percent}`);
  sendJsonOrJsonp(req, res, query, 200, { ok: true, code: payload.code, name: payload.name, data: payload });
}
/** GET /api/jin10/kline?code=XAUUSD&count=120 → 金十分钟级K线 */
async function handleJin10Kline(req, res, query) {
  const code = (query.code || "XAUUSD").toUpperCase();
  const count = Math.min(Math.max(parseInt(query.count || "120") || 120, 1), 240);
  const cacheKey = "k:" + code + ":" + count;
  let payload = jin10CacheGet(cacheKey, 60000);
  if (!payload) {
    try {
      const resp = await jin10CallTool("get_kline", { code, count });
      const ext = jin10Extract(resp.result);
      if (ext.status !== 200 || !ext.data || !Array.isArray(ext.data.klines)) {
        sendJsonOrJsonp(req, res, query, 502, { ok: false, error: "金十K线失败：" + (ext.message || "无数据") });
        return;
      }
      const d = ext.data;
      payload = {
        code: d.code || code,
        name: d.name || code,
        klines: d.klines.map(k => ({
          time: jn(k.time),                 // 秒级 epoch
          timeMs: (jn(k.time) || 0) * 1000, // 毫秒（便于前端）
          open: jn(k.open),
          close: jn(k.close),
          high: jn(k.high),
          low: jn(k.low),
          volume: jn(k.volume)
        })).filter(b => b.close != null)
      };
      jin10CacheSet(cacheKey, payload);
    } catch (e) {
      sendJsonOrJsonp(req, res, query, 502, { ok: false, error: e.message });
      return;
    }
  }
  sendJsonOrJsonp(req, res, query, 200, { ok: true, code: payload.code, name: payload.name, data: payload });
}

/** GET /api/jin10/codes → 报价品种代码表（resources/read quote://codes） */
async function handleJin10Codes(req, res, query) {
  const ck = "codes";
  let payload = jin10CacheGet(ck, 3600 * 1000); // 1 小时
  if (!payload) {
    try {
      const json = await jin10ReadResource("quote://codes");
      payload = (json && json.data) || [];
      jin10CacheSet(ck, payload);
    } catch (e) {
      sendJsonOrJsonp(req, res, query, 502, { ok: false, error: e.message });
      return;
    }
  }
  sendJsonOrJsonp(req, res, query, 200, { ok: true, count: payload.length, data: payload });
}

/** GET /api/jin10/flash?keyword=&cursor= → 快讯（search_flash 关键词 / list_flash 翻页） */
async function handleJin10Flash(req, res, query) {
  const keyword = (query.keyword || "").trim();
  const cursor = (query.cursor || "").trim();
  const ck = "flash:" + keyword + ":" + cursor;
  let payload = jin10CacheGet(ck, 15000);
  if (!payload) {
    try {
      const tool = keyword ? "search_flash" : "list_flash";
      const args = keyword ? { keyword } : (cursor ? { cursor } : {});
      const resp = await jin10CallTool(tool, args);
      const ext = jin10Extract(resp.result);
      if (ext.status !== 200 || !ext.data) {
        sendJsonOrJsonp(req, res, query, 502, { ok: false, error: "金十快讯失败：" + (ext.message || "无数据") });
        return;
      }
      const d = ext.data;
      payload = { items: d.items || [], next_cursor: d.next_cursor || "", has_more: !!d.has_more };
      jin10CacheSet(ck, payload);
    } catch (e) {
      sendJsonOrJsonp(req, res, query, 502, { ok: false, error: e.message });
      return;
    }
  }
  sendJsonOrJsonp(req, res, query, 200, { ok: true, data: payload });
}

/** GET /api/jin10/news?keyword=&cursor= → 资讯（search_news 关键词 / list_news 翻页） */
async function handleJin10News(req, res, query) {
  const keyword = (query.keyword || "").trim();
  const cursor = (query.cursor || "").trim();
  const ck = "news:" + keyword + ":" + cursor;
  let payload = jin10CacheGet(ck, 15000);
  if (!payload) {
    try {
      const tool = keyword ? "search_news" : "list_news";
      const args = keyword ? (cursor ? { keyword, cursor } : { keyword }) : (cursor ? { cursor } : {});
      const resp = await jin10CallTool(tool, args);
      const ext = jin10Extract(resp.result);
      if (ext.status !== 200 || !ext.data) {
        sendJsonOrJsonp(req, res, query, 502, { ok: false, error: "金十资讯失败：" + (ext.message || "无数据") });
        return;
      }
      const d = ext.data;
      payload = { items: d.items || [], next_cursor: d.next_cursor || "", has_more: !!d.has_more };
      jin10CacheSet(ck, payload);
    } catch (e) {
      sendJsonOrJsonp(req, res, query, 502, { ok: false, error: e.message });
      return;
    }
  }
  sendJsonOrJsonp(req, res, query, 200, { ok: true, data: payload });
}

/** GET /api/jin10/news/detail?id= → 单篇资讯详情（get_news） */
async function handleJin10NewsDetail(req, res, query) {
  const id = (query.id || "").trim();
  if (!id) { sendJsonOrJsonp(req, res, query, 400, { ok: false, error: "缺少 id" }); return; }
  const ck = "newsdetail:" + id;
  let payload = jin10CacheGet(ck, 600000); // 10 分钟
  if (!payload) {
    try {
      const resp = await jin10CallTool("get_news", { id });
      const ext = jin10Extract(resp.result);
      if (ext.status !== 200 || !ext.data) {
        sendJsonOrJsonp(req, res, query, 502, { ok: false, error: "金十资讯详情失败：" + (ext.message || "无数据") });
        return;
      }
      const d = ext.data;
      payload = {
        id: d.id || id,
        title: d.title || "",
        introduction: d.introduction || "",
        time: d.time || null,
        url: d.url || "",
        content: d.content || ""
      };
      jin10CacheSet(ck, payload);
    } catch (e) {
      sendJsonOrJsonp(req, res, query, 502, { ok: false, error: e.message });
      return;
    }
  }
  sendJsonOrJsonp(req, res, query, 200, { ok: true, data: payload });
}

/** GET /api/jin10/calendar → 财经日历（list_calendar，当前自然周） */
async function handleJin10Calendar(req, res, query) {
  const ck = "calendar";
  let payload = jin10CacheGet(ck, 300000); // 5 分钟
  if (!payload) {
    try {
      const resp = await jin10CallTool("list_calendar", {});
      const ext = jin10Extract(resp.result);
      if (ext.status !== 200 || !ext.data) {
        sendJsonOrJsonp(req, res, query, 502, { ok: false, error: "金十日历失败：" + (ext.message || "无数据") });
        return;
      }
      const d = ext.data;
      // 财经日历 data 为数组，每项含 pub_time/star/title/previous/consensus/actual/revised/affect_txt
      payload = Array.isArray(d) ? d : (d.items || []);
      jin10CacheSet(ck, payload);
    } catch (e) {
      sendJsonOrJsonp(req, res, query, 502, { ok: false, error: e.message });
      return;
    }
  }
  sendJsonOrJsonp(req, res, query, 200, { ok: true, data: payload });
}

// JSONP 支持：Chrome 在 file:// 页面禁止 fetch http://，但允许 <script> 注入。
// 当请求带 callback 参数时，返回 application/javascript 而不是 JSON。
function sendJsonOrJsonp(req, res, query, status, payload) {
  const cb = query && query.callback;
  if (cb && /^[a-zA-Z_$][\w$]*$/.test(cb)) {
    // 简易 XSS 防护：回调名只允许合法 JS 标识符
    res.writeHead(status, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(cb + "(" + JSON.stringify(payload) + ");");
  } else {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
  }
}

// ====== HTTP Server ======
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    // 主页
    //   Cache-Control: no-cache —— 每次都向服务器协商校验（配合 Last-Modified 304），
    //   避免浏览器启发式缓存拿到旧版 HTML（单文件应用发版后旧页面会长期驻留）
    if (parsed.pathname === "/" || parsed.pathname === "/index.html") {
      const html = fs.readFileSync(HTML_FILE, "utf-8");
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      res.end(html);
      return;
    }

    // API: 国内金价
    if (parsed.pathname === "/api/domgold") { await handleDomGold(req, res, parsed.query); return; }

    // API: 国际金价（COMEX黄金）
    if (parsed.pathname === "/api/intlgold") { await handleIntlGold(req, res, parsed.query); return; }

    // API: 腾讯行情代理
    if (parsed.pathname === "/api/tencent") { await handleTencent(req, res, parsed.query); return; }

    // API: 个股详情（5档盘口 + 基础报价全字段，东方财富）
    if (parsed.pathname === "/api/detail") { await handleDetail(req, res, parsed.query); return; }

    // API: 当日分时（东方财富 trends2），供详情弹窗的 canvas 分时图
    if (parsed.pathname === "/api/trends") { await handleTrends(req, res, parsed.query); return; }

    // API: 批量当日分时迷你走势（自选股列表行内趋势线，服务端并发聚合 + 缓存）
    if (parsed.pathname === "/api/mini") { await handleMini(req, res, parsed.query); return; }

    // API: K线（日/周/月），供详情弹窗的蜡烛图
    if (parsed.pathname === "/api/kline") { await handleKline(req, res, parsed.query); return; }

    // API: 历史资金流（每日主力净额），供详情弹窗的资金流柱状图
    if (parsed.pathname === "/api/fundflow") { await handleFundFlow(req, res, parsed.query); return; }

    // API: 补充字段（换手率/振幅/量比/市值），新浪无，用东财 push2
    if (parsed.pathname === "/api/quote") { await handleQuoteExtra(req, res, parsed.query); return; }

    // API: 金十数据 MCP —— 标准 MCP(2025-11-25) 接入（用户已申请 secret-key）
    if (parsed.pathname === "/api/jin10/quote") { await handleJin10Quote(req, res, parsed.query); return; }
    if (parsed.pathname === "/api/jin10/kline") { await handleJin10Kline(req, res, parsed.query); return; }
    if (parsed.pathname === "/api/jin10/codes") { await handleJin10Codes(req, res, parsed.query); return; }
    if (parsed.pathname === "/api/jin10/flash") { await handleJin10Flash(req, res, parsed.query); return; }
    if (parsed.pathname === "/api/jin10/news") { await handleJin10News(req, res, parsed.query); return; }
    if (parsed.pathname === "/api/jin10/news/detail") { await handleJin10NewsDetail(req, res, parsed.query); return; }
    if (parsed.pathname === "/api/jin10/calendar") { await handleJin10Calendar(req, res, parsed.query); return; }

    // 静态资源（白名单：分享缩略图/头像，文件位于 __dirname 下）
    const STATIC_IMAGES = {
      "/yuanbao.jpg": "yuanbao.jpg",
      "/jinyuanbao.jpg": "jinyuanbao.jpg"   // 微信/QQ 分享卡片缩略图（og:image 指向它）
    };
    if (STATIC_IMAGES[parsed.pathname]) {
      const imgPath = path.join(__dirname, STATIC_IMAGES[parsed.pathname]);
      if (fs.existsSync(imgPath)) {
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
        res.end(fs.readFileSync(imgPath));
        return;
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not Found");
  } catch (e) {
    console.error("[Server Error]", e);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  const banner = `
╔══════════════════════════════════════════╗
║                                          ║
║   🐱  元宝爱财 数据代理服务              ║
║                                          ║
║   地址 : http://0.0.0.0:${PORT} / http://localhost:${PORT}      ║
║   数据源: 招行SGE(Au99.99官方价) → 东方财富 → 腾讯ETF反推 → 折算 | 国际金价:金十XAUUSD(MCP)·腾讯COMEX   ║
║   金十MCP: 标准协议2025-11-25 · get_quote/get_kline/list_flash/search_flash/list_news/search_news/get_news/list_calendar · quote://codes   ║
║                                          ║
║   按 Ctrl+C 停止服务                     ║
╚══════════════════════════════════════════╝`;
  console.log(banner);
});
