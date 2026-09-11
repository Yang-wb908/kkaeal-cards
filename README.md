# 오늘의 깨알 카드

'오늘의 깨알' 앱이 내려받는 카드 묶음 저장소입니다. 앱 코드와 API 키는 여기에 없고, 카드 JSON만 공개합니다.

## 구조

```
cards/index.json          묶음 목록 (앱이 가장 먼저 읽는 파일)
cards/packs/<id>.json      카드 묶음 (한 파일에 최대 약 150장)
scripts/generate.mjs       Gemini로 카드를 만드는 스크립트 (의존성 없음, Node 20+)
.github/workflows/         매주 월요일 03:00(KST)에 새 카드 45장을 만드는 워크플로
```

`COUNT`와 45장·90장은 꼬리 물기 카드까지 합친 장수입니다 (메인 카드는 약 1/3).
기본 모델은 `gemini-3.1-flash-lite`(생각 수준 low)입니다. 사실 확인은 모델의 검색에 맡기지 않고 위키백과 대조로 합니다.
카드마다 해당 위키백과 문서 본문을 가져와 카드 내용과 대조합니다. 한국어 문서로 확인이 안 되면 영어 문서로 한 번 더 대조하고, 판정의 근거 문장이 실제로 문서에 있는지도 코드로 확인합니다. 메인 카드는 '맞음'만 통과(`verified: true`, 앱의 '출처 확인' 표시)하고, 꼬리 카드는 '일부 확인'도 표시 없이 씁니다. 나머지는 버리며, 메인 카드가 버려지면 꼬리 카드도 함께 버립니다.

카드 하나에는 본문, 확인 퀴즈, 심화 설명(더 깊이 알아보기), 위키백과 출처, 이어지는 질문 2개가 들어 있습니다.
이어지는 질문마다 답하는 카드가 같은 묶음 안에 따로 있어서(`parentKey`로 연결), 앱에서 꼬리 물기를 누르면 바로 열립니다.

## 지출 한도 알림

`usage.json`에 응답마다 받은 토큰 수로 계산한 예상 지출이 쌓입니다 (`since`부터 누적).
예산(`budgetKRW`, 기본 ₩12,000)의 80%에 닿으면 이슈로 알리고, 100%에 닿으면 알린 뒤 생성을 멈춥니다.
다시 돌리려면 `budgetKRW`를 늘리거나 `spentKRW`를 0으로 바꾸세요. 실제 청구액은 AI Studio 지출 화면에서 확인할 수 있어요.

## 처음 설정

1. Settings → Secrets and variables → Actions → New repository secret
   - Name: `GEMINI_API_KEY`
   - Secret: Google AI Studio에서 받은 Gemini API 키
2. Actions 탭 → "카드 묶음 만들기" → Run workflow (처음엔 90장을 만듭니다)

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
