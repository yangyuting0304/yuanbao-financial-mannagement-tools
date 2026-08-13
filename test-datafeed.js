'use strict';
/*
 * test-datafeed.js — 数据层独立测试（无需 Electron）
 * 运行： node test-datafeed.js
 * 用途：在打包/交付前验证各数据源是否可达、字段解析是否正确。
 */
const { fetchAll } = require('./datafeed');
const config = require('./config.json');

(async () => {
  console.log('=== 摸鱼理财 数据层自检 ===');
  console.log('请求时间:', new Date().toLocaleString('zh-CN'));
  const t0 = Date.now();
  let data;
  try {
    data = await fetchAll(config);
  } catch (e) {
    console.error('fetchAll 抛出异常:', e);
    process.exit(1);
  }
  console.log('耗时:', Date.now() - t0, 'ms');
  console.log('\n--- 逐项行情 ---');
  const items = config.watchlist.reduce((a, g) => a.concat(g.items), []);
  for (const it of items) {
    const d = data.items[it.code];
    if (!d) {
      console.log(`[缺失] ${it.name} (${it.code})`);
      continue;
    }
    const dir = d.change == null ? '' : d.change > 0 ? '▲' : d.change < 0 ? '▼' : '·';
    const pct = d.pct == null ? '—' : (d.pct > 0 ? '+' : '') + d.pct.toFixed(2) + '%';
    const chg = d.change == null ? '—' : (d.change > 0 ? '+' : '') + d.change;
    const tag = d.derived ? ' [估算]' : d.source === 'eastmoney' ? ' [上金所]' : '';
    console.log(
      `${it.name.padEnd(14)} ${String(d.price).padStart(10)}  ${dir}${String(chg).padStart(9)}  ${pct.padStart(8)}${tag}`
    );
  }
  console.log('\n--- 国内金价 ---');
  if (data.domesticGold) {
    console.log(
      `${data.domesticGold.name}: ${data.domesticGold.price} 元/克` +
        (data.domesticGold.derived ? ` (估算, 汇率≈${data.domesticGold.usdcny})` : ' (上金所实时)')
    );
  } else {
    console.log('国内金价：未获取到');
  }
  if (data.usdcny) console.log('美元兑人民币:', data.usdcny);
  console.log('\n--- 错误 ---');
  console.log(data.errors.length ? data.errors.join('\n') : '无');
  process.exit(0);
})();
