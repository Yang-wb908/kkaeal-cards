// 오늘의 깨알 — 카드 묶음 생성기
//
// Gemini로 깨알 카드를 만들고(카드마다 심화 설명, 확인 퀴즈, 꼬리 물기 카드 2장 포함),
// 위키백과에서 출처를 찾아 붙인 뒤 cards/packs/*.json 과 cards/index.json 에 저장한다.
// 앱은 index.json 을 읽고 아직 받지 않은 묶음만 내려받는다. 의존성 없이 Node 20+ 에서 돈다.
//
// 환경 변수
//   GEMINI_API_KEY  (필수, DRY_RUN=1 이면 없어도 됨)
//   COUNT           만들 메인 카드 수 (기본: 첫 실행 300, 이후 150)
//   MODELS          쉼표로 구분한 모델 목록 (기본: gemini-3.5-flash,gemini-flash-latest)
//   THINKING_LEVEL  minimal | low | medium | high (기본 medium)
//   DELAY_MS        요청 사이 간격 (기본 4000)
//   MAX_MINUTES     이 시간이 지나면 만든 데까지 저장하고 끝낸다 (기본 240)
//   DRY_RUN=1       API 없이 가짜 카드로 흐름만 확인

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARDS_DIR = path.join(ROOT, 'cards');
const PACKS_DIR = path.join(CARDS_DIR, 'packs');
const INDEX_FILE = path.join(CARDS_DIR, 'index.json');

const DRY = process.env.DRY_RUN === '1';
const KEY = process.env.GEMINI_API_KEY || '';
const MODELS = (process.env.MODELS || 'gemini-3.5-flash,gemini-flash-latest').split(',').map((s) => s.trim()).filter(Boolean);
const THINKING_LEVEL = process.env.THINKING_LEVEL || 'medium';
const DELAY_MS = Number(process.env.DELAY_MS || (DRY ? 0 : 4000));
const MAX_MINUTES = Number(process.env.MAX_MINUTES || 240);
const PACK_ROOTS = 50; // 묶음 하나에 메인 카드 50장 (꼬리 카드 포함 약 150장)
const DEEP_RATIO = 0.4; // 메인 카드 중 심화 지식 비율
const MAX_FAILURES = 25;

// 앱과 같은 분야 목록 (앱의 Categories.GROUPS 와 맞춰야 한다)
const GROUPS = [
  ['자연과학', ['물리', '화학', '생명과학', '지구과학', '우주', '수학']],
  ['몸과 마음', ['인체·의학', '심리']],
  ['자연', ['동물', '식물', '바다']],
  ['기술', ['전자·반도체', '컴퓨터·AI', '발명·공학', '교통·항공']],
  ['인문', ['역사', '철학', '언어', '신화·종교', '인물']],
  ['사회', ['경제', '지리', '법·제도']],
  ['문화', ['음식', '예술', '음악', '스포츠', '건축', '영화·게임']],
];
const CATEGORIES = GROUPS.flatMap(([, items]) => items);

const ANGLES = [
  '이름이나 어원에 숨은 뜻밖의 이야기',
  '많은 사람이 잘못 알고 있는 상식 바로잡기',
  '숫자로 보면 놀라운 사실',
  '우연히 이루어진 발견이나 발명',
  '일상 속에 숨어 있는 원리',
  '극단적인 기록이나 예외적인 사례',
  '생각보다 훨씬 오래되었거나 최근에 생긴 것',
  '서로 무관해 보이는 두 가지의 의외의 연결고리',
];

// 난이도 세부 수준(1~5): 앱의 알았어요/몰랐어요 반응으로 움직이는 단계와 같다
const LEVEL_WEIGHTS = { 1: 0.15, 2: 0.25, 3: 0.25, 4: 0.2, 5: 0.15 };
const LEVEL_DETAIL = {
  1: '입문 — 배경지식이 전혀 없어도 바로 흥미를 느낄 쉬운 사실.',
  2: '기본 — 대부분은 모르지만 설명을 들으면 바로 이해되는 사실.',
  3: '탐구 — 흔한 상식보다 한 단계 더 들어간 구체적인 사실이나 숫자. 널리 알려진 이야기는 피한다.',
  4: '심층 — 그 분야를 조금 공부한 사람에게도 새로울 만한 디테일이나 원리. 유명한 일화는 피한다.',
  5: '전문가 — 전공자도 흥미로워할 깊이 있는 사실, 최근 연구나 잘 알려지지 않은 사례. 교과서에 나오는 이야기는 피한다.',
};
const DIFFICULTY_TEXT = {
  basic: '깨알 상식. 누구나 바로 이해할 수 있고 친구에게 말해주고 싶어지는 사실. 본문은 3~5문장.',
  deep: '심화 지식. 현상 뒤의 원리, 메커니즘, 역사적 배경까지 파고든다. 전공 입문 수준의 개념어를 써도 되지만 처음 보는 사람도 따라올 수 있게 풀어서 설명한다. 본문은 5~7문장.',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const shuffle = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const CONTROL_CHARS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']', 'g');
const clean = (s) => String(s ?? '').replace(/\*\*|##/g, '').replace(CONTROL_CHARS, (c) => (c === '\n' ? '\n' : ' ')).trim();

class QuotaError extends Error {}

// ───────────────────────── 기존 묶음 읽기 ─────────────────────────

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function loadExisting() {
  const index = await readJson(INDEX_FILE, { version: 1, updated: null, totalCards: 0, packs: [] });
  const cards = [];
  for (const entry of index.packs) {
    const pack = await readJson(path.join(CARDS_DIR, entry.file), null);
    if (pack?.cards) cards.push(...pack.cards);
  }
  return { index, cards };
}

// ───────────────────────── 생성 계획 ─────────────────────────

function weightedLevel() {
  let r = Math.random();
  for (const [level, w] of Object.entries(LEVEL_WEIGHTS)) {
    r -= w;
    if (r <= 0) return Number(level);
  }
  return 3;
}

// 분야는 골고루 돌아가며, 난이도·세부 수준은 비율대로 섞는다
function makePlan(count) {
  const plan = [];
  let queue = [];
  for (let i = 0; i < count; i++) {
    if (queue.length === 0) queue = shuffle(CATEGORIES);
    plan.push({
      category: queue.pop(),
      difficulty: Math.random() < DEEP_RATIO ? 'deep' : 'basic',
      level: weightedLevel(),
      angle: pick(ANGLES),
    });
  }
  return plan;
}

// ───────────────────────── 프롬프트 ─────────────────────────

function buildPrompt({ category, difficulty, level, angle }, avoidTitles) {
  const avoid = avoidTitles.length ? avoidTitles.join(', ') : '없음';
  return `
너는 '오늘의 깨알'이라는 지식 앱의 큐레이터야. 사람들이 잘 모르지만 듣고 나면 "진짜?" 하게 되는 사실을 하나 골라 카드로 만들고,
그 카드를 읽은 사람이 이어서 궁금해할 질문 2개와 각 질문에 답하는 이어지는 카드도 함께 만들어줘.

[메인 카드 조건]
- 분야: ${category}
- 관점: ${angle}
- 난이도: ${DIFFICULTY_TEXT[difficulty]}
- 세부 수준: ${LEVEL_DETAIL[level]}
- 다음 주제와 겹치지 않게 한다: ${avoid}

[공통 규칙]
- 학계나 신뢰할 수 있는 자료로 검증된 사실만 쓴다. 속설, 도시전설, 출처가 불분명한 통계는 쓰지 않는다. 확실하지 않으면 다른 주제를 고른다.
- 숫자·연도·인명은 널리 확인되는 값만 쓴다.
- 모든 텍스트는 자연스러운 한국어로 쓰고 마크다운 기호나 출처 표기는 넣지 않는다.
- 퀴즈는 본문을 읽으면 풀 수 있게 내고, "본문에 따르면" 같은 말로 시작하지 않는다. 보기는 4개, 정답은 하나.
- deepDive는 왜 그런지(원리), 어떻게 알려졌는지(배경), 함께 알면 좋은 연결 지식을 한 문단씩 총 3문단. 각 문단 2~4문장, 문단 사이에 빈 줄 하나.
- 이어지는 카드는 메인 카드와 같은 난이도로, 질문에 직접 답하는 새로운 사실을 담는다. 메인 카드 내용을 되풀이하지 않는다.
- 이어지는 카드의 category는 다음 중 가장 알맞은 것 하나: ${CATEGORIES.join(', ')}

아래 형식의 JSON 객체 하나로만 답해.
{
  "title": "호기심을 끄는 20자 이내 제목",
  "hook": "읽고 싶게 만드는 한 문장 티저",
  "description": "본문 설명",
  "keyword": "위키백과에서 검색할 핵심 키워드 하나",
  "quiz": { "question": "객관식 문제", "options": ["보기1", "보기2", "보기3", "보기4"], "answer": "정답 보기의 텍스트를 options와 똑같이", "explanation": "정답 해설 한두 문장" },
  "deepDive": "3문단 심화 설명",
  "followUps": [
    {
      "question": "이어서 궁금해질 짧은 질문 (20자 이내)",
      "card": { "category": "분야", "title": "...", "hook": "...", "description": "...", "keyword": "...",
                "quiz": { "question": "...", "options": ["...", "...", "...", "..."], "answer": "...", "explanation": "..." },
                "deepDive": "..." }
    },
    { "question": "...", "card": { "...": "위와 같은 형식" } }
  ]
}`.trim();
}

// ───────────────────────── Gemini 호출 ─────────────────────────

const noThinking = new Set();

async function gemini(prompt) {
  if (DRY) return JSON.stringify(mockResponse());
  let quotaHits = 0;
  let lastError = '';
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const generationConfig = { responseMimeType: 'application/json' };
      if (!noThinking.has(model)) generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL };
      let res;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
          signal: AbortSignal.timeout(180_000),
        });
      } catch (e) {
        lastError = `${model} network ${e.message}`;
        await sleep(3000);
        continue;
      }
      if (res.ok) {
        const data = await res.json();
        const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
        if (text.trim()) return text;
        lastError = `${model} empty response`;
        continue;
      }
      const body = await res.text();
      lastError = `${model} ${res.status} ${body.slice(0, 200)}`;
      if (res.status === 400 && /thinking/i.test(body) && !noThinking.has(model)) {
        noThinking.add(model); // 생각 수준 설정을 모르는 모델: 빼고 다시
        attempt--;
        continue;
      }
      if (res.status === 429) {
        quotaHits++;
        await sleep(20_000 * (attempt + 1));
        continue;
      }
      if (res.status >= 500) {
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (res.status === 404) break;
      throw new Error(lastError);
    }
  }
  if (quotaHits >= MODELS.length * 3) throw new QuotaError(lastError);
  throw new Error(lastError || 'no model answered');
}

// ───────────────────────── 응답 정리·검증 ─────────────────────────

function extractJson(raw) {
  const start = raw.search(/\{\s*"/);
  const end = raw.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
}

// 정답 매칭: 정확 → 정규화 일치 → 기호(A~D, N번) → 유일한 포함 관계. 애매하면 퀴즈를 뺀다
function resolveAnswer(answer, options) {
  if (answer == null || !options.length) return -1;
  if (typeof answer === 'number') return Number.isInteger(answer) && answer >= 0 && answer < options.length ? answer : -1;
  const text = String(answer).trim();
  const nt = norm(text);
  if (!nt) return -1;
  let i = options.findIndex((o) => o.trim() === text);
  if (i >= 0) return i;
  i = options.findIndex((o) => norm(o) === nt);
  if (i >= 0) return i;
  const letter = text.match(/^([A-Da-d])\s*[).:]?$/);
  if (letter) {
    const k = letter[1].toUpperCase().charCodeAt(0) - 65;
    return k < options.length ? k : -1;
  }
  const num = text.match(/^(?:보기\s*)?([1-9])\s*번?\s*[).:]?$/);
  if (num && (text.startsWith('보기') || text.includes('번'))) {
    const k = Number(num[1]) - 1;
    return k < options.length ? k : -1;
  }
  const hits = options.map((o, k) => [norm(o), k]).filter(([o]) => o.includes(nt) || nt.includes(o));
  return hits.length === 1 ? hits[0][1] : -1;
}

function cleanQuiz(q) {
  if (!q || typeof q !== 'object') return null;
  const options = [...new Set((q.options ?? []).map(clean).filter(Boolean))].slice(0, 4);
  const answer = resolveAnswer(q.answer, options);
  const question = clean(q.question);
  if (!question || options.length < 2 || answer < 0) return null;
  const correct = options[answer];
  const shuffled = shuffle(options);
  return { question, options: shuffled, answer: shuffled.indexOf(correct), explanation: clean(q.explanation) };
}

function cleanCard(raw, fallbackCategory) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clean(raw.title);
  const description = clean(raw.description);
  if (!title || !description || title.length > 40 || description.length < 40) return null;
  const category = CATEGORIES.includes(clean(raw.category)) ? clean(raw.category) : fallbackCategory;
  return {
    category,
    title,
    hook: clean(raw.hook),
    description,
    keyword: clean(raw.keyword) || title,
    quiz: cleanQuiz(raw.quiz),
    deepDive: clean(raw.deepDive),
  };
}

// ───────────────────────── 위키백과 출처 ─────────────────────────

async function wikiSource(query) {
  if (DRY || !query) return null;
  const url = new URL('https://ko.wikipedia.org/w/api.php');
  Object.entries({ action: 'query', list: 'search', srsearch: query, srlimit: '1', format: 'json', formatversion: '2' })
    .forEach(([k, v]) => url.searchParams.set(k, v));
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'KkaealCards/1.0 (https://github.com/Yang-wb908/kkaeal-cards; educational)' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const title = (await res.json())?.query?.search?.[0]?.title?.trim();
    if (!title) return null;
    return { title: `위키백과 · ${title}`, url: `https://ko.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}` };
  } catch {
    return null;
  }
}

async function withSource(card) {
  const source = (await wikiSource(card.keyword)) || (card.keyword !== card.title ? await wikiSource(card.title) : null);
  return { ...card, sources: source ? [source] : [], verified: Boolean(source) };
}

// ───────────────────────── 카드 한 묶음(메인 + 꼬리 2장) 만들기 ─────────────────────────

async function makeFamily(item, rootKey, avoidTitles, knownTitles) {
  for (let tries = 0; tries < 2; tries++) {
    const raw = extractJson(await gemini(buildPrompt(item, avoidTitles)));
    const root = cleanCard({ ...raw, category: item.category }, item.category);
    if (!root) continue;
    if (knownTitles.has(norm(root.title))) {
      avoidTitles = [...avoidTitles, root.title];
      item = { ...item, angle: pick(ANGLES) };
      continue;
    }
    const children = [];
    for (const [i, f] of (Array.isArray(raw.followUps) ? raw.followUps : []).slice(0, 2).entries()) {
      const question = clean(f?.question).slice(0, 40);
      const child = cleanCard(f?.card, item.category);
      if (!question || !child || knownTitles.has(norm(child.title)) || norm(child.title) === norm(root.title)) continue;
      children.push({
        key: `${rootKey}-f${i + 1}`,
        parentKey: rootKey,
        parentQuestion: question,
        difficulty: item.difficulty,
        level: item.level,
        ...(await withSource(child)),
        followUps: [],
      });
    }
    const rootCard = {
      key: rootKey,
      parentKey: null,
      parentQuestion: '',
      difficulty: item.difficulty,
      level: item.level,
      ...(await withSource(root)),
      followUps: children.map((c) => ({ question: c.parentQuestion, key: c.key })),
    };
    return [rootCard, ...children];
  }
  return null;
}

// ───────────────────────── 실행 ─────────────────────────

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

async function main() {
  if (!DRY && !KEY) {
    console.error('GEMINI_API_KEY가 없어요. 저장소 Settings → Secrets and variables → Actions 에 등록해 주세요.');
    process.exit(1);
  }
  await fs.mkdir(PACKS_DIR, { recursive: true });
  const { index, cards: existing } = await loadExisting();
  const count = Number(process.env.COUNT) || (index.packs.length === 0 ? 300 : 150);
  const plan = makePlan(count);
  const runId = stamp();
  const startedAt = Date.now();

  const knownTitles = new Set(existing.map((c) => norm(c.title)));
  const titlesByCategory = new Map();
  for (const c of existing) {
    if (!titlesByCategory.has(c.category)) titlesByCategory.set(c.category, []);
    titlesByCategory.get(c.category).push(c.title);
  }

  console.log(`기존 카드 ${existing.length}장 · 이번에 메인 카드 ${count}장 생성 시작 (${DRY ? 'DRY RUN' : MODELS.join(', ')})`);

  let buffer = [];
  let bufferRoots = 0;
  let packNo = 0;
  let made = 0;
  let failures = 0;
  let stopReason = '';

  async function flush() {
    if (!buffer.length) return;
    packNo++;
    const id = `${runId}-${packNo}`;
    const file = `packs/${id}.json`;
    await fs.writeFile(path.join(CARDS_DIR, file), JSON.stringify({ id, created: new Date().toISOString(), cards: buffer }, null, 1) + '\n');
    index.packs.push({ id, file, roots: bufferRoots, cards: buffer.length, created: new Date().toISOString() });
    index.totalCards = (index.totalCards || 0) + buffer.length;
    index.updated = new Date().toISOString();
    await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 1) + '\n'); // 묶음마다 바로 저장 → 중간에 멈춰도 만든 만큼은 남는다
    console.log(`  묶음 저장: ${file} (메인 ${bufferRoots}장, 전체 ${buffer.length}장)`);
    buffer = [];
    bufferRoots = 0;
  }

  for (const [n, item] of plan.entries()) {
    if (Date.now() - startedAt > MAX_MINUTES * 60_000) {
      stopReason = `시간 제한 ${MAX_MINUTES}분`;
      break;
    }
    const rootKey = `${runId}-${String(n + 1).padStart(3, '0')}`;
    const avoid = (titlesByCategory.get(item.category) ?? []).slice(-60);
    try {
      const family = await makeFamily(item, rootKey, avoid, knownTitles);
      if (family) {
        buffer.push(...family);
        bufferRoots++;
        made++;
        for (const c of family) {
          knownTitles.add(norm(c.title));
          if (!titlesByCategory.has(c.category)) titlesByCategory.set(c.category, []);
          titlesByCategory.get(c.category).push(c.title);
        }
        console.log(`[${made}/${count}] ${item.category} · ${item.difficulty} Lv.${item.level} · ${family[0].title} (+꼬리 ${family.length - 1})`);
      } else {
        failures++;
        console.warn(`[skip] ${item.category}: 쓸 만한 카드를 받지 못함`);
      }
    } catch (e) {
      if (e instanceof QuotaError) {
        stopReason = `API 할당량 초과: ${e.message}`;
        break;
      }
      failures++;
      console.warn(`[error] ${item.category}: ${e.message}`);
    }
    if (failures > MAX_FAILURES) {
      stopReason = `실패 ${failures}회`;
      break;
    }
    if (bufferRoots >= PACK_ROOTS) await flush();
    if (DELAY_MS) await sleep(DELAY_MS);
  }
  await flush();

  const summary = `메인 카드 ${made}/${count}장 생성, 실패 ${failures}회${stopReason ? ` · 중단: ${stopReason}` : ''} · 누적 ${index.totalCards}장`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### 카드 생성 결과\n${summary}\n`);
  if (made === 0 && !DRY) process.exit(1);
}

// ───────────────────────── DRY RUN 용 가짜 응답 ─────────────────────────

let mockSeq = 0;
function mockResponse() {
  const n = ++mockSeq;
  const card = (t) => ({
    category: pick(CATEGORIES),
    title: `${t} 테스트 카드 ${n}`,
    hook: '테스트 티저 문장',
    description: '테스트용 본문입니다. 실제 생성 없이 흐름만 확인하려고 만든 문장이며 길이 검사를 통과하도록 충분히 깁니다.',
    keyword: `키워드${n}`,
    quiz: { question: '정답은?', options: ['가', '나', '다', '라'], answer: n % 3 === 0 ? 'C' : '나', explanation: '해설' },
    deepDive: '원리 문단\n\n배경 문단\n\n연결 문단',
  });
  return { ...card('메인'), followUps: [{ question: '첫째 질문?', card: card('꼬리1') }, { question: '둘째 질문?', card: card('꼬리2') }] };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
