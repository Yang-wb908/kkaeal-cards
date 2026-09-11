# 오늘의 깨알 카드

'오늘의 깨알' 앱이 내려받는 카드 묶음 저장소입니다. 앱 코드와 API 키는 여기에 없고, 카드 JSON만 공개합니다.

## 구조

```
cards/index.json          묶음 목록 (앱이 가장 먼저 읽는 파일)
cards/packs/<id>.json      카드 묶음 (메인 카드 50장 + 꼬리 물기 카드, 약 150장)
scripts/generate.mjs       Gemini로 카드를 만드는 스크립트 (의존성 없음, Node 20+)
.github/workflows/         매주 월요일 03:00(KST)에 새 카드 150장을 만드는 워크플로
```

`COUNT`와 150장·300장은 꼬리 물기 카드까지 합친 장수입니다 (메인 카드는 약 1/3).
생성할 때 Gemini가 Google 검색으로 오늘 날짜 기준 사실인지 확인합니다 (`GROUNDING=0`이면 끔).

카드 하나에는 본문, 확인 퀴즈, 심화 설명(더 깊이 알아보기), 위키백과 출처, 이어지는 질문 2개가 들어 있습니다.
이어지는 질문마다 답하는 카드가 같은 묶음 안에 따로 있어서(`parentKey`로 연결), 앱에서 꼬리 물기를 누르면 바로 열립니다.

## 처음 설정

1. Settings → Secrets and variables → Actions → New repository secret
   - Name: `GEMINI_API_KEY`
   - Secret: Google AI Studio에서 받은 Gemini API 키
2. Actions 탭 → "카드 묶음 만들기" → Run workflow (처음엔 300장을 만듭니다)

## 직접 돌려 보기

```bash
GEMINI_API_KEY=... COUNT=6 node scripts/generate.mjs   # 실제 생성 (메인 2장 + 꼬리 4장)
DRY_RUN=1 COUNT=6 node scripts/generate.mjs            # API 없이 흐름만 확인
```

## 카드 형식

```json
{
  "key": "20260915-180000-001",
  "parentKey": null,
  "parentQuestion": "",
  "category": "물리",
  "difficulty": "basic",
  "level": 2,
  "title": "…", "hook": "…", "description": "…", "keyword": "…",
  "quiz": { "question": "…", "options": ["…", "…", "…", "…"], "answer": 1, "explanation": "…" },
  "deepDive": "…",
  "sources": [{ "title": "위키백과 · …", "url": "https://ko.wikipedia.org/wiki/…" }],
  "verified": true,
  "followUps": [{ "question": "…", "key": "20260915-180000-001-f1" }]
}
```

`difficulty`는 `basic`(깨알 상식) 또는 `deep`(심화 지식), `level`은 1(입문)~5(전문가)입니다.
앱은 알았어요/몰랐어요 반응으로 정해진 단계에 가까운 카드부터 보여 줍니다.
