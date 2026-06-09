# Exchange Rates

실시간 USD/KRW, CNY/KRW, USD/CNY 환율을 확인하는 정적 웹 페이지입니다.

**배포 URL:** https://krissallyteeth.github.io/exchangerate/

## 주요 기능

- **실시간 환율** 표시 — 네이버(하나은행 매매기준율) 기준, 5분마다 자동 갱신
- **52주 고가·저가** 및 현재 위치 시각화 (범위 바) — Yahoo 일별 OHLC 기반(구글/Morningstar와 같은 글로벌 시세), 오늘 실시간값도 구간에 반영. 저점 대비 `+X%`·고점 대비 `−Y%`도 함께 표시
- **데이터 출처 자동 표시** — 실제로 사용 중인 소스를 헤더 부제목과 푸터에 그대로 표기 (네이버 / Yahoo / ECB / …)
- **새로고침 버튼** — 헤더 우측 상단과 푸터 양쪽에서 수동 갱신 (로딩 중 회전 애니메이션)
- **중국에서 VPN 없이도 작동** — 다단계 API 폴백 + localStorage 캐시
- 반응형 디자인 (모바일·태블릿·데스크톱), Apple 디자인 스타일

## 로컬 실행

별도 설치나 빌드 단계가 없습니다. `index.html`을 브라우저로 열면 됩니다.

```bash
git clone https://github.com/Krissallyteeth/exchangerate.git
cd exchangerate
open index.html   # 또는 브라우저로 파일 열기
```

## 데이터 출처

현재 환율은 아래 순서로 시도하며, 앞 소스가 실패하면 다음으로 폴백합니다. 실제 사용된 소스는 화면(헤더 부제목·푸터)에 표시됩니다.

1. **네이버 금융** — 하나은행 매매기준율 (`FX_USDKRW`, `FX_CNYKRW`). 네이버에 표시되는 값과 동일한 **실시간** 환율
2. **Yahoo Finance** — 글로벌 시장 중간환율 (분 단위, 구글에 가까움)
3. **[frankfurter.dev](https://frankfurter.dev)** — ECB 일일 기준환율 (평일 1회 고시)
4. **[ExchangeRate-API](https://open.er-api.com)** — 일 1회 갱신, 중국 접근성 양호
5. **localStorage 캐시** — 마지막 수신값 (최후 수단)

> 네이버·Yahoo는 CORS 헤더를 보내지 않아 공개 CORS 프록시(`corsproxy.io` / `allorigins.win` / `codetabs.com`)를 통해 가져오며, 모두 실패하면(예: 중국) 자동으로 ECB 등 일일 소스로 폴백됩니다. 일일 소스가 쓰이는 경우 푸터에 배지로 안내됩니다.

**52주 내역:** 일별 OHLC(고가/저가) — [Stooq](https://stooq.com)·Yahoo 동시 시도(먼저 응답하는 쪽) → 실패 시 [frankfurter.dev](https://frankfurter.dev)(ECB 1년치, 근사) → localStorage 캐시

> Yahoo의 일별 고가·저가는 장중 극단값을 반영해 구글/Morningstar가 보여주는 52주 범위와 일치합니다(ECB 일일 고시값은 범위가 좁게 나옴). 여기에 **오늘의 실시간값도 구간에 포함**해, 현재값이 범위를 벗어나면 최고/최저와 막대가 즉시 갱신되고 실제 신규 극단값일 때만 "52W 최고/최저" 배지가 표시됩니다. 1년치 재요청은 데이터 절약을 위해 최대 6시간에 1회로 제한합니다. Yahoo 과거를 못 받아 ECB로 폴백한 경우(범위가 근사치)에는 푸터에 `52주 ECB(근사)` 배지로 안내합니다.

## 갱신 주기 · 용량

- **현재 환율:** 5분마다 자동 갱신 (수동 새로고침 가능). 응답이 작은 현재가만 받음
- **52주 내역:** 1년치 데이터(수십 KB)는 최대 6시간에 1회만 재요청 → 데이터 절약
- **저장 공간:** localStorage에 계산 결과·현재가만 보관 (합쳐서 1KB 미만)

## 구조

빌드 없이 두 파일로 동작합니다.

- `index.html` — 마크업 + 인라인 CSS (외부 CSS 의존성 없음 — 중국에서도 동작)
- `app.js` — API 호출·상태·렌더링·시계·자동 갱신 로직
