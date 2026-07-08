require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');

const BASE_URL = 'https://api.searchad.naver.com';
const API_KEY = process.env.NAVER_API_KEY;
const SECRET_KEY = process.env.NAVER_SECRET_KEY;

function getHeaders(method, uri, customerId) {
  const timestamp = Date.now().toString();
  const message = `${timestamp}.${method}.${uri}`;
  const signature = crypto.createHmac('sha256', SECRET_KEY).update(message).digest('base64');
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Timestamp': timestamp,
    'X-API-KEY': API_KEY,
    'X-Customer': String(customerId),
    'X-Signature': signature,
  };
}

async function apiGet(signPath, queryString, customerId, timeoutMs = 12000) {
  const url = queryString ? `${BASE_URL}${signPath}?${queryString}` : `${BASE_URL}${signPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: getHeaders('GET', signPath, customerId),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`(${res.status}) ${text}`);
    }
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('요청 시간 초과(timeout)');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

async function getCampaigns(customerId) {
  return apiGet('/ncc/campaigns', null, customerId);
}
async function getAdgroups(customerId, campaignId) {
  return apiGet('/ncc/adgroups', `nccCampaignId=${encodeURIComponent(campaignId)}`, customerId);
}
async function getKeywords(customerId, adgroupId) {
  return apiGet('/ncc/keywords', `nccAdgroupId=${encodeURIComponent(adgroupId)}`, customerId);
}
async function getAds(customerId, adgroupId) {
  return apiGet('/ncc/ads', `nccAdgroupId=${encodeURIComponent(adgroupId)}`, customerId);
}

async function getDailyStats(customerId, id, days = 30) {
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const fields = JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ctr', 'avgRnk', 'ccnt', 'convAmt', 'ror']);
  const timeRange = JSON.stringify({ since: formatDate(since), until: formatDate(until) });
  const queryString = `id=${encodeURIComponent(id)}&fields=${encodeURIComponent(fields)}&timeRange=${encodeURIComponent(timeRange)}&timeIncrement=1`;
  return apiGet('/stats', queryString, customerId);
}

async function getAggregateStats(customerId, id, days = 30) {
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const fields = JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ctr', 'avgRnk', 'ccnt', 'convAmt', 'ror']);
  const timeRange = JSON.stringify({ since: formatDate(since), until: formatDate(until) });
  const queryString = `id=${encodeURIComponent(id)}&fields=${encodeURIComponent(fields)}&timeRange=${encodeURIComponent(timeRange)}&timeIncrement=${days}`;
  return apiGet('/stats', queryString, customerId);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 동시에 CONCURRENCY개씩 처리 (순서대로 하나씩 하지 않고 여러 개 병렬 처리)
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      try {
        results[cur] = await fn(items[cur], cur);
      } catch (e) {
        results[cur] = { __error: e.message };
      }
      await wait(120); // 너무 몰아치지 않도록 살짝 간격
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function saveOutput(results) {
  fs.writeFileSync('./output.json', JSON.stringify(results, null, 2), 'utf-8');
}

const MAX_RUNTIME_MS = 5 * 60 * 60 * 1000 + 30 * 60 * 1000; // 5시간 30분 (여유를 두고 안전 종료)
const startTime = Date.now();
function timeLeft() {
  return MAX_RUNTIME_MS - (Date.now() - startTime);
}

async function main() {
  const accounts = JSON.parse(fs.readFileSync('./accounts.json', 'utf-8'));
  const results = [];

  for (const acc of accounts) {
    if (timeLeft() < 10 * 60 * 1000) {
      console.log(`\n⚠️ 실행 시간이 얼마 남지 않아 "${acc.name}" 이후 계정은 건너뛰고 종료합니다.`);
      break;
    }

    console.log(`\n[조회 중] ${acc.name} (${acc.customerId})`);
    try {
      const campaigns = await getCampaigns(acc.customerId);
      console.log(`  → 캠페인 ${campaigns.length}개 조회 성공`);
      await wait(300);

      // 1) 캠페인별 일별 성과
      const dailyStats = [];
      for (const camp of campaigns) {
        try {
          const statRes = await getDailyStats(acc.customerId, camp.nccCampaignId, 30);
          dailyStats.push({ campaignId: camp.nccCampaignId, campaignName: camp.name, data: statRes.data || statRes });
        } catch (e) {
          console.log(`    · [일별] "${camp.name}" 실패: ${e.message}`);
        }
        await wait(200);
      }
      console.log(`  → 캠페인별 일별 성과 조회 완료`);

      // 2) 캠페인 > 그룹 > 키워드/소재 구조 (동시 처리로 속도 개선)
      const structure = [];
      for (const camp of campaigns) {
        const campEntry = { nccCampaignId: camp.nccCampaignId, name: camp.name, groups: [] };
        try {
          const adgroups = await getAdgroups(acc.customerId, camp.nccCampaignId);
          console.log(`    · [구조] "${camp.name}" 그룹 ${adgroups.length}개`);
          await wait(200);

          for (const grp of adgroups) {
            const grpEntry = { nccAdgroupId: grp.nccAdgroupId, name: grp.name, keywords: [], ads: [] };

            let keywords = [];
            try {
              keywords = await getKeywords(acc.customerId, grp.nccAdgroupId);
            } catch (e) {
              console.log(`      · "${grp.name}" 키워드 목록 실패: ${e.message}`);
            }
            if (keywords.length > 0) {
              const kwStats = await mapWithConcurrency(keywords, 5, async (kw) => {
                const statRes = await getAggregateStats(acc.customerId, kw.nccKeywordId, 30);
                const rows = statRes.data || statRes;
                return Array.isArray(rows) ? rows[0] : rows;
              });
              keywords.forEach((kw, i) => {
                const s = kwStats[i];
                grpEntry.keywords.push({
                  nccKeywordId: kw.nccKeywordId,
                  keyword: kw.keyword,
                  bidAmt: kw.bidAmt,
                  status: kw.status,
                  stats: s && !s.__error ? s : null,
                });
              });
              console.log(`      · "${grp.name}" 키워드 ${keywords.length}개 성과 조회 완료`);
            }

            let ads = [];
            try {
              ads = await getAds(acc.customerId, grp.nccAdgroupId);
            } catch (e) {
              console.log(`      · "${grp.name}" 소재 목록 실패: ${e.message}`);
            }
            if (ads.length > 0) {
              const adStats = await mapWithConcurrency(ads, 5, async (ad) => {
                const statRes = await getAggregateStats(acc.customerId, ad.nccAdId, 30);
                const rows = statRes.data || statRes;
                return Array.isArray(rows) ? rows[0] : rows;
              });
              ads.forEach((ad, i) => {
                const s = adStats[i];
                grpEntry.ads.push({
                  nccAdId: ad.nccAdId,
                  ad: ad.ad || null,
                  status: ad.status,
                  regTm: ad.regTm,
                  stats: s && !s.__error ? s : null,
                });
              });
              console.log(`      · "${grp.name}" 소재 ${ads.length}개 성과 조회 완료`);
            }

            campEntry.groups.push(grpEntry);

            if (timeLeft() < 5 * 60 * 1000) {
              console.log(`      ⚠️ 시간이 얼마 남지 않아 이 계정의 나머지 그룹은 건너뜁니다.`);
              break;
            }
          }
        } catch (e) {
          console.log(`    · [구조] "${camp.name}" 그룹 목록 실패: ${e.message}`);
        }
        structure.push(campEntry);
      }

      results.push({
        customerId: acc.customerId,
        name: acc.name,
        campaigns,
        stats: dailyStats,
        structure,
      });
    } catch (err) {
      console.log(`  → 실패: ${err.message}`);
      results.push({ customerId: acc.customerId, name: acc.name, error: err.message });
    }

    // 계정 하나 끝날 때마다 중간 저장 (타임아웃으로 강제종료돼도 여기까지는 안전하게 남음)
    saveOutput(results);
    console.log(`  → 중간 저장 완료 (지금까지 ${results.length}개 계정)`);
    await wait(400);
  }

  saveOutput(results);
  console.log('\n전체 결과가 output.json 파일에 저장되었습니다.');
}

main();
