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

// 키워드 단위 누적 성과 (최근 days일 합계 1건)
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

// 동시에 CONCURRENCY개씩 처리
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

function loadExisting() {
  try {
    const text = fs.readFileSync('./structure.json', 'utf-8');
    return JSON.parse(text);
  } catch (e) {
    return [];
  }
}

function saveStructure(results) {
  fs.writeFileSync('./structure.json', JSON.stringify(results, null, 2), 'utf-8');
}

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
const MAX_RUNTIME_MS = 5 * 60 * 60 * 1000 + 30 * 60 * 1000; // 5시간 30분 (여유를 두고 안전 종료)
const startTime = Date.now();
function timeLeft() {
  return MAX_RUNTIME_MS - (Date.now() - startTime);
}

const TIME_LIMIT_SIGNAL = '__TIME_LIMIT__';

// 캠페인 > 그룹 > 키워드 구조 + 키워드별 누적 성과 수집 (소재는 수집하지 않음)
async function collectAccountStructure(acc) {
  const campaigns = await getCampaigns(acc.customerId);
  const structure = [];

  for (const camp of campaigns) {
    const campEntry = { id: camp.nccCampaignId, name: camp.name, groups: [] };
    try {
      const adgroups = await getAdgroups(acc.customerId, camp.nccCampaignId);
      console.log(`    · "${camp.name}" 그룹 ${adgroups.length}개`);
      await wait(200);

      for (const grp of adgroups) {
        const grpEntry = { id: grp.nccAdgroupId, name: grp.name, keywords: [] };

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
              // 실제 응답 필드명이 다를 수 있어 확장검색/구문검색 판별용으로 추정 필드를 폭넓게 시도합니다.
              // 실행 로그에서 실제 필드명을 확인해 필요하면 아래 줄만 조정해주세요.
              matchType: kw.keywordTp || kw.matchType || null,
              bidAmt: kw.bidAmt,
              status: kw.status,
              stats: s && !s.__error ? s : null,
            });
          });
          console.log(`      · "${grp.name}" 키워드 ${keywords.length}개 성과 조회 완료`);
        }

        campEntry.groups.push(grpEntry);

        if (timeLeft() < 5 * 60 * 1000) {
          throw new Error(TIME_LIMIT_SIGNAL);
        }
      }
    } catch (e) {
      if (e.message === TIME_LIMIT_SIGNAL) throw e;
      console.log(`    · [구조] "${camp.name}" 그룹 목록 실패: ${e.message}`);
    }
    structure.push(campEntry);
  }

  return structure;
}

async function main() {
  const accounts = JSON.parse(fs.readFileSync('./accounts.json', 'utf-8'));
  const existing = loadExisting();

  const results = existing.slice();
  const indexById = {};
  results.forEach((e, i) => { indexById[String(e.customerId)] = i; });

  for (const acc of accounts) {
    const prev = existing.find((e) => String(e.customerId) === String(acc.customerId));

    if (prev && prev.collectedAt) {
      const ageMs = Date.now() - new Date(prev.collectedAt).getTime();
      if (ageMs < SIX_DAYS_MS) {
        console.log(`\n[건너뜀] ${acc.name} (${acc.customerId}) — ${Math.floor(ageMs / (24 * 60 * 60 * 1000))}일 전 수집됨, 6일 이내라 스킵`);
        continue;
      }
    }

    if (timeLeft() < 15 * 60 * 1000) {
      console.log(`\n⚠️ 실행 시간이 얼마 남지 않아 "${acc.name}" 이후 계정은 다음 실행에서 이어서 수집합니다.`);
      break;
    }

    console.log(`\n[구조 수집 중] ${acc.name} (${acc.customerId})`);
    let entry;
    try {
      const structure = await collectAccountStructure(acc);
      entry = { customerId: acc.customerId, name: acc.name, collectedAt: new Date().toISOString(), structure };
      console.log(`  → 완료 (캠페인 ${structure.length}개)`);
    } catch (err) {
      if (err.message === TIME_LIMIT_SIGNAL) {
        console.log(`  → 시간 부족으로 이 계정 수집을 중단합니다. (진행 중이던 이 계정은 다음 실행에서 처음부터 다시 수집)`);
        break;
      }
      console.log(`  → 실패: ${err.message}`);
      entry = {
        customerId: acc.customerId, name: acc.name,
        collectedAt: prev ? prev.collectedAt : null,
        structure: prev ? prev.structure : [],
        error: err.message,
      };
    }

    const idx = indexById[String(acc.customerId)];
    if (idx !== undefined) results[idx] = entry;
    else { results.push(entry); indexById[String(acc.customerId)] = results.length - 1; }

    saveStructure(results);
    console.log(`  → 중간 저장 완료`);
    await wait(400);
  }

  saveStructure(results);
  console.log('\n전체 결과가 structure.json 파일에 저장되었습니다.');
}

main();
