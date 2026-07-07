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

async function apiGet(signPath, queryString, customerId) {
  const url = queryString ? `${BASE_URL}${signPath}?${queryString}` : `${BASE_URL}${signPath}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: getHeaders('GET', signPath, customerId),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`(${res.status}) ${text}`);
  }
  return res.json();
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

// 일별(daily) 성과 - 캠페인 단위 (30일)
async function getDailyStats(customerId, id, days = 30) {
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const fields = JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ctr', 'avgRnk', 'ccnt', 'convAmt', 'ror']);
  const timeRange = JSON.stringify({ since: formatDate(since), until: formatDate(until) });
  const queryString = `id=${encodeURIComponent(id)}&fields=${encodeURIComponent(fields)}&timeRange=${encodeURIComponent(timeRange)}&timeIncrement=1`;
  return apiGet('/stats', queryString, customerId);
}

// 집계(단일) 성과 - 키워드/소재 단위 (최근 30일 합계 1건)
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

async function main() {
  const accounts = JSON.parse(fs.readFileSync('./accounts.json', 'utf-8'));
  const results = [];

  for (const acc of accounts) {
    console.log(`\n[조회 중] ${acc.name} (${acc.customerId})`);
    try {
      const campaigns = await getCampaigns(acc.customerId);
      console.log(`  → 캠페인 ${campaigns.length}개 조회 성공`);
      await wait(500);

      // 1) 캠페인별 일별 성과 (대시보드 상단 그래프용)
      const dailyStats = [];
      for (const camp of campaigns) {
        try {
          const statRes = await getDailyStats(acc.customerId, camp.nccCampaignId, 30);
          dailyStats.push({ campaignId: camp.nccCampaignId, campaignName: camp.name, data: statRes.data || statRes });
          console.log(`    · [일별] "${camp.name}" 성과 조회 성공`);
        } catch (e) {
          console.log(`    · [일별] "${camp.name}" 성과 조회 실패: ${e.message}`);
        }
        await wait(350);
      }

      // 2) 캠페인 > 그룹 > 키워드/소재 구조 + 집계 성과 (진단 리포트용)
      const structure = [];
      for (const camp of campaigns) {
        const campEntry = { nccCampaignId: camp.nccCampaignId, name: camp.name, groups: [] };
        try {
          const adgroups = await getAdgroups(acc.customerId, camp.nccCampaignId);
          console.log(`    · [구조] "${camp.name}" 그룹 ${adgroups.length}개 조회 성공`);
          await wait(300);

          for (const grp of adgroups) {
            const grpEntry = { nccAdgroupId: grp.nccAdgroupId, name: grp.name, keywords: [], ads: [] };

            try {
              const keywords = await getKeywords(acc.customerId, grp.nccAdgroupId);
              for (const kw of keywords) {
                let stats = null;
                try {
                  const statRes = await getAggregateStats(acc.customerId, kw.nccKeywordId, 30);
                  const rows = statRes.data || statRes;
                  stats = Array.isArray(rows) ? rows[0] : rows;
                } catch (e) {
                  console.log(`      · 키워드 "${kw.keyword}" 성과 조회 실패: ${e.message}`);
                }
                grpEntry.keywords.push({
                  nccKeywordId: kw.nccKeywordId,
                  keyword: kw.keyword,
                  bidAmt: kw.bidAmt,
                  useGroupBidAmt: kw.useGroupBidAmt,
                  status: kw.status,
                  stats,
                });
                await wait(250);
              }
              console.log(`      · "${grp.name}" 키워드 ${keywords.length}개 조회 성공`);
            } catch (e) {
              console.log(`      · "${grp.name}" 키워드 목록 조회 실패: ${e.message}`);
            }

            try {
              const ads = await getAds(acc.customerId, grp.nccAdgroupId);
              for (const ad of ads) {
                let stats = null;
                try {
                  const statRes = await getAggregateStats(acc.customerId, ad.nccAdId, 30);
                  const rows = statRes.data || statRes;
                  stats = Array.isArray(rows) ? rows[0] : rows;
                } catch (e) {
                  console.log(`      · 소재 "${ad.nccAdId}" 성과 조회 실패: ${e.message}`);
                }
                grpEntry.ads.push({
                  nccAdId: ad.nccAdId,
                  ad: ad.ad || null,
                  status: ad.status,
                  regTm: ad.regTm,
                  stats,
                });
                await wait(250);
              }
              console.log(`      · "${grp.name}" 소재 ${ads.length}개 조회 성공`);
            } catch (e) {
              console.log(`      · "${grp.name}" 소재 목록 조회 실패: ${e.message}`);
            }

            campEntry.groups.push(grpEntry);
          }
        } catch (e) {
          console.log(`    · [구조] "${camp.name}" 그룹 목록 조회 실패: ${e.message}`);
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
    await wait(500);
  }

  fs.writeFileSync('./output.json', JSON.stringify(results, null, 2), 'utf-8');
  console.log('\n전체 결과가 output.json 파일에 저장되었습니다.');
}

main();
