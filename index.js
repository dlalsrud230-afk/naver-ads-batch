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

// 캠페인 단위 일별 성과 (impCnt/clkCnt/salesAmt/ctr/avgRnk/ccnt/convAmt/ror, 최근 days일, 일단위)
async function getDailyStats(customerId, id, days = 30) {
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const fields = JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ctr', 'avgRnk', 'ccnt', 'convAmt', 'ror']);
  const timeRange = JSON.stringify({ since: formatDate(since), until: formatDate(until) });
  const queryString = `id=${encodeURIComponent(id)}&fields=${encodeURIComponent(fields)}&timeRange=${encodeURIComponent(timeRange)}&timeIncrement=1`;
  return apiGet('/stats', queryString, customerId);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function saveOutput(results) {
  fs.writeFileSync('./output.json', JSON.stringify(results, null, 2), 'utf-8');
}

// 이 스크립트는 "캠페인 + 일별 성과"만 가볍게 매일 수집합니다.
// 그룹/키워드 구조 진단은 별도로 주 1회 도는 index-structure.js가 담당합니다.
const MAX_RUNTIME_MS = 3 * 60 * 60 * 1000; // 3시간 (가벼운 작업이라 여유있게 설정)
const startTime = Date.now();
function timeLeft() {
  return MAX_RUNTIME_MS - (Date.now() - startTime);
}

async function main() {
  const accounts = JSON.parse(fs.readFileSync('./accounts.json', 'utf-8'));
  const results = [];

  for (const acc of accounts) {
    if (timeLeft() < 5 * 60 * 1000) {
      console.log(`\n⚠️ 실행 시간이 얼마 남지 않아 "${acc.name}" 이후 계정은 건너뛰고 종료합니다.`);
      break;
    }

    console.log(`\n[조회 중] ${acc.name} (${acc.customerId})`);
    try {
      const campaigns = await getCampaigns(acc.customerId);
      console.log(`  → 캠페인 ${campaigns.length}개 조회 성공`);
      await wait(300);

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

      results.push({
        customerId: acc.customerId,
        name: acc.name,
        campaigns,
        stats: dailyStats,
      });
    } catch (err) {
      console.log(`  → 실패: ${err.message}`);
      results.push({ customerId: acc.customerId, name: acc.name, error: err.message });
    }

    // 계정 하나 끝날 때마다 중간 저장 (강제종료돼도 여기까지는 안전하게 남음)
    saveOutput(results);
    console.log(`  → 중간 저장 완료 (지금까지 ${results.length}개 계정)`);
    await wait(400);
  }

  saveOutput(results);
  console.log('\n전체 결과가 output.json 파일에 저장되었습니다.');
}

main();
