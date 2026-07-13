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

// 그룹/키워드 일별 성과 (하루 단위로 쪼개서 반환) — index-structure.js와 동일한 헬퍼
async function getDailyStatsForId(customerId, id, days = 30) {
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const fields = JSON.stringify(['impCnt', 'clkCnt', 'salesAmt', 'ctr', 'avgRnk', 'ccnt', 'convAmt', 'ror']);
  const timeRange = JSON.stringify({ since: formatDate(since), until: formatDate(until) });
  const queryString = `id=${encodeURIComponent(id)}&fields=${encodeURIComponent(fields)}&timeRange=${encodeURIComponent(timeRange)}&timeIncrement=1`;
  return apiGet('/stats', queryString, customerId);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
      await wait(120);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// 일별 행(rows)을 30일 누적 스냅샷(stats)으로 합산 — 별도 누적조회 API를 안 써도 되게
function aggregateDailyRows(rows) {
  let impCnt = 0, clkCnt = 0, salesAmt = 0, ccnt = 0, convAmt = 0, rankSum = 0, rankWeight = 0;
  (rows || []).forEach((r) => {
    impCnt += r.impCnt || 0;
    clkCnt += r.clkCnt || 0;
    salesAmt += r.salesAmt || 0;
    ccnt += r.ccnt || 0;
    convAmt += r.convAmt || 0;
    if (r.avgRnk && r.impCnt) { rankSum += r.avgRnk * r.impCnt; rankWeight += r.impCnt; }
  });
  return {
    impCnt, clkCnt, salesAmt, ccnt, convAmt,
    avgRnk: rankWeight > 0 ? +(rankSum / rankWeight).toFixed(2) : null,
  };
}

function loadStructure() {
  try {
    return JSON.parse(fs.readFileSync('./structure.json', 'utf-8'));
  } catch (e) {
    return [];
  }
}
function saveStructure(results) {
  fs.writeFileSync('./structure.json', JSON.stringify(results, null, 2), 'utf-8');
}

// 가벼운 작업이라 안전장치를 넉넉히만 둡니다 (그룹/키워드 목록은 절대 다시 조회하지 않음)
const MAX_RUNTIME_MS = 60 * 60 * 1000; // 1시간
const startTime = Date.now();
function timeLeft() {
  return MAX_RUNTIME_MS - (Date.now() - startTime);
}

async function main() {
  const structure = loadStructure();
  if (structure.length === 0) {
    console.log('structure.json이 비어있습니다. 먼저 index-structure.js(주간 전체 수집)를 실행해주세요.');
    return;
  }

  for (const acc of structure) {
    if (timeLeft() < 3 * 60 * 1000) {
      console.log(`\n⚠️ 시간이 얼마 남지 않아 "${acc.name}" 이후 계정은 이번엔 건너뜁니다.`);
      break;
    }
    if (!acc.structure || acc.structure.length === 0) continue;

    console.log(`\n[일별 갱신 중] ${acc.name} (${acc.customerId})`);
    let groupCount = 0, keywordCount = 0;

    for (const camp of acc.structure) {
      for (const grp of camp.groups || []) {
        // 비용이 있어서 이미 일별 데이터를 갖고 있던 그룹만 갱신 (목록 재조회 없음)
        if (grp.daily && grp.daily.length > 0) {
          try {
            const res = await getDailyStatsForId(acc.customerId, grp.id, 30);
            grp.daily = res.data || res || [];
            groupCount++;
          } catch (e) {
            console.log(`  · 그룹 "${grp.name}" 갱신 실패: ${e.message}`);
          }
          await wait(120);
        }

        // 비용/전환 상위라 이미 일별 데이터를 갖고 있던 키워드만 갱신
        const targetKeywords = (grp.keywords || []).filter((k) => k.daily);
        if (targetKeywords.length > 0) {
          const dailyResults = await mapWithConcurrency(targetKeywords, 5, async (kw) => {
            const res = await getDailyStatsForId(acc.customerId, kw.nccKeywordId, 30);
            return res.data || res || [];
          });
          targetKeywords.forEach((kw, i) => {
            const rows = dailyResults[i];
            if (rows && !rows.__error) {
              kw.daily = rows;
              kw.stats = aggregateDailyRows(rows); // 30일 누적값도 일별 데이터로부터 같이 갱신
              keywordCount++;
            }
          });
        }
      }
      if (timeLeft() < 3 * 60 * 1000) break;
    }

    // 주간 전체 수집 시각(collectedAt)은 건드리지 않고, 일별 갱신 시각만 따로 기록
    acc.dailyRefreshedAt = new Date().toISOString();
    console.log(`  → 그룹 ${groupCount}개, 키워드 ${keywordCount}개 일별 데이터 갱신 완료`);

    saveStructure(structure);
  }

  saveStructure(structure);
  console.log('\n일별 갱신 완료, structure.json에 저장되었습니다.');
}

main();
