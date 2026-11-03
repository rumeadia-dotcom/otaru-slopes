# 오타루 슬로프

**공개 URL: https://rumeadia-dotcom.github.io/otaru-slopes/** (GitHub Pages, `main` 브랜치 루트 자동 배포)

오타루·삿포로 근교 5개 스키장(텐구야마·아사리가와·키로로·테이네·삿포로 국제)과 니세코 유나이티드 4개 구역(그랑 히라후·하나조노·니세코 빌리지·안누푸리)의 실제 슬로프를 3D 지형 위에 올려 보여 주는 모바일 웹.
[축제지도](https://festival-map.konanest.com/)와 같은 "밤 위의 불빛" 톤으로, PC에서는 마우스를 올리면 / 모바일에서는 탭하면 코스 정보가 뜬다.

## 구성 (빌드 도구 없음, 정적 파일)

| 파일 | 역할 |
|---|---|
| `index.html` · `style.css` · `app.js` | 화면. three.js(0.170, cdnjs)를 importmap 으로 불러온다 |
| `data/resorts.json` | 리조트 목록 + 요약 |
| `data/<slug>.json` | 리조트별 높이 격자(Int16 데시미터, base64) + 피스트/리프트 좌표(로컬 m, 표고 포함) |
| `scripts/build-data.mjs` | 데이터 빌드: `scripts/raw/overpass.json` + 표고 타일 → `data/*.json` |
| `scripts/raw/` | 원본 OSM 응답, 표고 타일 캐시 (`tiles/`) |
| `scripts/mobile-preview.html` | 개발용: 390/360/820px 폭 iframe 으로 동시에 보기 |
| `PRODUCT.md` | 디자인 컨텍스트 (impeccable) |

## 로컬 실행

```bash
python3 -m http.server 8765          # 또는 아무 정적 서버
open http://127.0.0.1:8765/
open http://127.0.0.1:8765/scripts/mobile-preview.html
```

`file://` 로는 안 된다 (ES 모듈·fetch 때문). 배포는 폴더를 그대로 정적 호스팅에 올리면 된다 (KONA Nest 정적 배포 가능).

## 데이터

- **코스·리프트**: OpenStreetMap `piste:type=downhill|mogul|snow_park`, `aerialway=*` (© OpenStreetMap contributors, ODbL).
  오타루 5곳은 리조트 경계(`landuse=winter_sports`) 안에 중심이 있는 것만 할당하고, 밖이면 3.2 km 안의 가장 가까운 리조트에 붙인다.
  니세코는 OSM 에 "ニセコユナイテッド" 하나로만 있어서, 리프트 이름(에이스/킹=히라후, 花園=하나조노, ジャンボ/ドリーム=안누푸리, ビレッジ 등=빌리지)으로 리프트를 나눈 뒤 각 코스를 가장 가까운 리프트의 구역에 붙인다. 그래서 니세코 4곳은 경계선을 그리지 않으며, 구역 경계 근처 코스는 실제 운영사와 다를 수 있다.
- **표고**: Mapzen / AWS Terrain Tiles (terrarium, z14 ≈ 7–9 m 해상도). 격자 간격은 리조트 크기에 따라 15–25 m.
- **길이·표고차·평균 경사**는 OSM 선 좌표 + 위 표고에서 계산한 값이다. 공식 수치와 다를 수 있다.
- **한국어 코스명은 음역**(`scripts/build-data.mjs` 의 `KO` 표)이며 공식 명칭이 아니다. OSM 에 이름이 없는 코스는 "이름 미등록" 으로 표시한다.
- 화면의 **세로 표고는 1.3배 강조**(`app.js` 의 `EXAG`)해 그린다. 표시 수치는 실측 그대로.
- 데이터 다시 굽기: Overpass 로 `scripts/raw/overpass*.json` 을 받은 뒤 `node scripts/build-data.mjs` (Node 22, 외부 패키지 없음). 스크립트 끝에서 정상/베이스 표고를 공개 수치와 비교해 ±60 m 를 벗어나면 실패한다.

## 조작

- PC: 드래그 회전 · 휠 확대 · 호버 → 툴팁 · 클릭 → 선택(하단 상세) · 방향키 회전 · `+`/`-` 확대 · `Esc` 선택 해제
- 모바일: 한 손가락 회전 · 두 손가락 벌리기 확대 / 끌기 이동 / 비틀기 회전 (손가락 아래 지면이 그대로 따라옴) · 탭 → 선택 · 선택된 코스를 다시 탭/목록에서 탭 → 카메라 이동
- 상단 칩으로 리조트 전환 (`#kiroro` 같은 해시로 딥링크), 나침반 탭 → 북쪽 위로, ↻ → 시점 처음으로
- `prefers-reduced-motion` 이면 입장 모션·자동 회전 없음

## 확인된 것 / 안 된 것

- Chrome(데스크톱) 에서 렌더링·피킹·선택·리조트 전환·리사이즈 맞춤 확인. 390/360/820px 폭 레이아웃은 iframe 으로 확인.
- **실제 터치 기기(핀치·탭 감도·iOS Safari WebGL)는 미확인.** 실기기로 확인 필요.
