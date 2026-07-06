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

async function getCampaigns(customerId) {
  const uri = '/ncc/campaigns';
  const res = await fetch(BASE_URL + uri, {
    method: 'GET',
    headers: getHeaders('GET', uri, customerId),
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

async function getStatsForCampaign(customerId, campaignId, days = 30) {
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));

  const fields = JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ctr', 'avgRnk', 'ccnt', 'convAmt', 'ror']);
  const timeRange = JSON.stringify({ since: formatDate(since), until: formatDate(until) });

  const signPath = '/stats';
  const queryString = `id=${encodeURIComponent(campaignId)}&fields=${encodeURIComponent(fields)}&timeRange=${encodeURIComponent(timeRange)}&timeIncrement=1`;

  const res = await fetch(`${BASE_URL}${signPath}?${queryString}`, {
    method: 'GET',
    headers: getHeaders('GET', signPath, customerId),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`(${res.status}) ${text}`);
  }
  return res.json();
}

async function main() {
  const accounts = JSON.parse(fs.readFileSync('./accounts.json', 'utf-8'));
  const results = [];

  for (const acc of accounts) {
    console.log(`\n[조회 중] ${acc.name} (${acc.customerId})`);
    try {
      const campaigns = await getCampaigns(acc.customerId);
      console.log(`  → 캠페인 ${campaigns.length}개 조회 성공`);

      await new Promise((r) => setTimeout(r, 500));

      const allStats = [];
      for (const camp of campaigns) {
        try {
          const statRes = await getStatsForCampaign(acc.customerId, camp.nccCampaignId, 30);
          allStats.push({ campaignId: camp.nccCampaignId, campaignName: camp.name, data: statRes.data || statRes });
          console.log(`    · "${camp.name}" 성과 조회 성공`);
        } catch (e) {
          console.log(`    · "${camp.name}" 성과 조회 실패: ${e.message}`);
        }
        await new Promise((r) => setTimeout(r, 400));
      }

      results.push({ customerId: acc.customerId, name: acc.name, campaigns, stats: allStats });
    } catch (err) {
      console.log(`  → 실패: ${err.message}`);
      results.push({ customerId: acc.customerId, name: acc.name, error: err.message });
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  fs.writeFileSync('./output.json', JSON.stringify(results, null, 2), 'utf-8');
  console.log('\n전체 결과가 output.json 파일에 저장되었습니다.');
}

main();
