# Exchange Rates

실시간 USD/KRW, CNY/KRW, USD/CNY 환율을 확인하는 정적 웹 페이지입니다.

**배포 URL:** https://krissallyteeth.github.io/exchangerate/

## 주요 기능

- 실시간 환율 표시 (5분마다 자동 갱신)
- 52주 고가·저가 및 현재 위치 시각화 (범위 바)
- 중국에서 VPN 없이도 작동 (API 폴백 + localStorage 캐시)
- 반응형 디자인 (모바일·태블릿·데스크톱)
- Apple 디자인 스타일

## 로컬 실행

별도 설치 없이 `index.html`을 브라우저로 열면 됩니다.

## 다른 기기에서 작업하기

```bash
git clone https://github.com/Krissallyteeth/exchangerate.git
```

## 데이터 출처

- **현재 환율:** [frankfurter.dev](https://frankfurter.dev) (ECB 기준) → 실패 시 [ExchangeRate-API](https://open.er-api.com) 폴백
- **52주 내역:** frankfurter.dev 시계열 API → 실패 시 localStorage 캐시 사용
