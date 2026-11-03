// 오타루 주변 5개 + 니세코 유나이티드 4개 스키장 — OSM 피스트/리프트 + 공개 표고 타일 → data/*.json
// 실행: node scripts/build-data.mjs            (타일은 scripts/raw/tiles 에 캐시)
// 입력: scripts/raw/overpass*.json  (Overpass: piste:type / aerialway / landuse=winter_sports, out geom)
//   - 오타루 5곳은 OSM 의 landuse=winter_sports 경계 폴리곤으로 나눈다
//   - 니세코 4곳은 OSM 에 "ニセコユナイテッド" 하나로만 있어서, 리프트 이름(에이스/킹=히라후, 花園=하나조노, ジャンボ/ドリーム=안누푸리, ビレッジ 등=빌리지)으로
//     리프트를 나눈 뒤 각 코스를 가장 가까운 리프트의 구역에 붙인다 (경계선은 그리지 않음)
// 표고: 国土地理院 DEM10B 타일 (https://maps.gsi.go.jp/development/ichiran.html#dem) 우선, 결측은 AWS Terrain Tiles (Mapzen terrarium)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW_FILES = fs.readdirSync(path.join(ROOT, "scripts/raw")).filter((f) => /^overpass.*\.json$/.test(f)).map((f) => path.join(ROOT, "scripts/raw", f));
const TILE_DIR = path.join(ROOT, "scripts/raw/tiles");
const OUT_DIR = path.join(ROOT, "data");
const Z = 14;
const PAD_M = 420; // 리조트 경계 밖으로 더 보여 줄 지형 (m)
const MAX_GRID = 480; // 긴 변 샘플 수 상한 (격자 10m 이상)
const MIN_STEP = 10; // 격자 최소 간격 (m) — GSI DEM10B 해상도에 맞춤
const ASSIGN_KM = 3.2; // 경계 밖 피스트를 가장 가까운 리조트에 붙일 때 허용 거리

const RESORTS = [
  { slug: "tenguyama", wayId: 1080161782, ko: "오타루 텐구야마", ja: "小樽天狗山スキー場", en: "Otaru Tenguyama", short: "텐구야마", city: "오타루" },
  { slug: "asarigawa", wayId: 1056695421, ko: "아사리가와 온천", ja: "朝里川温泉スキー場", en: "Asarigawa Onsen", short: "아사리가와", city: "오타루" },
  { slug: "kiroro", wayId: 1081650641, ko: "키로로 리조트", ja: "キロロリゾート", en: "Kiroro Resort", short: "키로로", city: "아카이가와" },
  { slug: "teine", wayId: 1083658291, ko: "삿포로 테이네", ja: "サッポロテイネ", en: "Sapporo Teine", short: "테이네", city: "삿포로" },
  { slug: "kokusai", wayId: 672881398, ko: "삿포로 국제 스키장", ja: "札幌国際スキー場", en: "Sapporo Kokusai", short: "삿포로 국제", city: "삿포로" },
  // 니세코 유나이티드 (같은 안누푸리 산을 4개 사업자가 나눠 씀). 범위 안에서 리프트 이름으로 구역을 가른다
  { slug: "hirafu", group: "niseko", ko: "니세코 그랑 히라후", ja: "ニセコグラン・ヒラフ", en: "Niseko Grand Hirafu", short: "히라후", city: "굿찬", liftRe: /エース|Ace|キング|King|スインギング|Swinging/ },
  { slug: "hanazono", group: "niseko", ko: "니세코 하나조노", ja: "ニセコHANAZONO", en: "Niseko Hanazono", short: "하나조노", city: "굿찬", liftRe: /花園|HANAZONO|Hanazono|シンフォニー|Symphony/ },
  { slug: "village", group: "niseko", ko: "니세코 빌리지", ja: "ニセコビレッジ", en: "Niseko Village", short: "니세코 빌리지", city: "니세코", liftRe: /ビレッジ|Village|バンザイ|Banzai|コミュニティ|Community|森の|Mori|ニセコゴンドラ|Niseko Gondola|ワンダーランド|Wonderland|カントリー|Country/ },
  { slug: "annupuri", group: "niseko", ko: "니세코 안누푸리", ja: "ニセコアンヌプリ国際", en: "Niseko Annupuri", short: "안누푸리", city: "니세코", liftRe: /ジャンボ|Jumbo|アンヌプリ|Annupuri|ドリーム|Dream/ },
];
const NISEKO_BBOX = { s: 42.84, n: 42.895, w: 140.64, e: 140.705 }; // 모이와(서쪽)·아사히가오카(동북)는 제외
const NISEKO_MAX_KM = 1.2; // 구역 리프트에서 이보다 멀면 니세코 코스로 안 본다

// 한국어 표기 — 공식 명칭이 아닌 음역 (README 참고)
const KO = {
  "ダイナミックコース": "다이내믹 코스", "ロングラインコース": "롱라인 코스",
  "観光ロープウェイ": "관광 로프웨이", "パノラマペアリフト": "파노라마 페어리프트", "山頂ファミリーリフト": "산정 패밀리 리프트",
  "Purple": "퍼플", "Green A": "그린 A", "Green B": "그린 B", "RED A": "레드 A", "Red B": "레드 B", "Orange": "오렌지", "Yellow A": "옐로 A", "Yellow B": "옐로 B",
  "イエローリフト": "옐로 리프트", "レッドリフト": "레드 리프트", "グリーンリフト": "그린 리프트", "パープルリフト": "퍼플 리프트",
  "余市第1-A": "요이치 제1-A", "余市第1-B": "요이치 제1-B", "余市第2-A": "요이치 제2-A", "余市第2-B": "요이치 제2-B",
  "センターA": "센터 A", "センターB": "센터 B", "センターC": "센터 C", "センターリンク": "센터 링크",
  "朝里第2ーA": "아사리 제2-A", "朝里第2ーB": "아사리 제2-B", "朝里第2ーC": "아사리 제2-C", "朝里第1ーA": "아사리 제1-A", "朝里第1ーB": "아사리 제1-B",
  "朝里パノラマ": "아사리 파노라마", "朝里ダイナミックコース": "아사리 다이내믹 코스",
  "長峰第1": "나가미네 제1", "長峰第2-Aコース": "나가미네 제2-A 코스", "長峰第2-Bコース": "나가미네 제2-B 코스", "長峰第2-Cコース": "나가미네 제2-C 코스",
  "エキスパートA": "엑스퍼트 A", "エキスパートB": "엑스퍼트 B", "ファミリコース": "패밀리 코스", "Terrain Park": "터레인 파크",
  "パウダーライド": "파우더 라이드", "Powder Ride": "파우더 라이드", "ゲートウェイコース": "게이트웨이 코스",
  "キロロゴンドラ": "키로로 곤돌라", "長峰第１エクスプレス": "나가미네 제1 익스프레스", "長峰第２エクスプレス": "나가미네 제2 익스프레스",
  "センターエクスプレス": "센터 익스프레스", "余市第１エクスプレス": "요이치 제1 익스프레스", "朝里第２エクスプレス": "아사리 제2 익스프레스",
  "余市第２リフト": "요이치 제2 리프트", "朝里第１リフト": "아사리 제1 리프트", "ファミリーリフト": "패밀리 리프트", "ゲートウェイエクスプレス": "게이트웨이 익스프레스",
  "ダウンヒルコース": "다운힐 코스", "Downhill": "다운힐 코스", "エコーコース": "에코 코스", "Echo Trail": "에코 코스", "スウィングコース": "스윙 코스", "Swing Trail": "스윙 코스",
  "ウッデイーコース": "우디 코스", "Woody Trail": "우디 코스", "メルヘンコース": "메르헨 코스", "Märchen Trail": "메르헨 코스", "林間コース": "린칸(숲속) 코스", "Forest Trail": "린칸(숲속) 코스",
  "Family Trail": "패밀리 코스",
  "メルヘン第１リフト": "메르헨 제1 리프트", "スカイキャビン8": "스카이캐빈 8", "ウッディーペアリフト": "우디 페어리프트", "エコークワッドリフト": "에코 쿼드리프트",
  "シティビュークルーズ": "시티뷰 크루즈", "（札幌オリンピック）女子大回転": "여자 대회전 (삿포로 올림픽)", "シティビューパノラマ": "시티뷰 파노라마",
  "パラダイス": "파라다이스", "レインボー": "레인보우", "聖火台 オーシャンダイブ": "세이카다이 오션 다이브", "聖火台 オーシャンクルーズ": "세이카다이 오션 크루즈",
  "聖火台 オーシャンストリーム": "세이카다이 오션 스트림", "白樺サンダンス": "시라카바 선댄스", "白樺サンライズ": "시라카바 선라이즈", "白樺サントラップ": "시라카바 선트랩",
  "白樺サンシャイン": "시라카바 선샤인", "北かべ": "기타카베 (북벽)", "ナチュラル": "내추럴",
  "パノラマ1号リフト": "파노라마 1호 리프트", "サミット エクスプレス": "서밋 익스프레스", "パノラマ2号リフト": "파노라마 2호 리프트",
  "白樺第3リフト": "시라카바 제3 리프트", "白樺第2リフト": "시라카바 제2 리프트", "エイトゴンドラ": "에이트 곤돌라", "聖火台第1リフト": "세이카다이 제1 리프트",
  "白樺第1リフトB線": "시라카바 제1 리프트 B선", "白樺第1リフトA線": "시라카바 제1 리프트 A선", "パラダイスリフト": "파라다이스 리프트", "風防付スノーエスカレーター": "스노 에스컬레이터",
  // 니세코 — 코스
  "ファミリーコース": "패밀리 코스", "アルペンコース": "알펜 코스", "望羊コース": "보요 코스", "センターコース": "센터 코스", "フリココース": "후리코 코스", "グリーンコース": "그린 코스",
  "ホリデーコース": "홀리데이 코스", "ジャンボコース": "점보 코스", "高原コース": "고겐 코스", "国体コース": "고쿠타이 코스", "ラージコース": "라지 코스", "見晴コース": "미하라시 코스",
  "第2の壁": "제2의 벽", "温泉沢コース": "온센자와 코스", "パラレルコース": "패러렐 코스", "Renraku": "렌라쿠 (연락로)", "白樺コース": "시라카바 코스", "スーパーコース": "슈퍼 코스",
  "羊蹄サンセット": "요테이 선셋", "初級者迂回路": "초급자 우회로", "迂回路": "우회로", "キングエリア連絡通路": "킹 에리어 연락로", "粉雪コース": "고나유키 코스", "せんの木コース": "센노키 코스",
  "Sennoki": "센노키 코스", "クリステルガーデン": "크리스털 가든", "接続": "접속로", "Shirakaba": "시라카바 코스",
  "レジェンド・オブ・シンヤ": "레전드 오브 신야", "Legend of Shinya": "레전드 오브 신야", "シルバードリーム": "실버 드림", "ステアウェイ・トゥ・ヘブン": "스테어웨이 투 헤븐", "HANAZONOパーク": "하나조노 파크",
  "Juicy Fruit": "주시 프루트", "コリーズフォリー": "콜리스 폴리", "Strawberry Fields": "스트로베리 필즈", "Blueberry Fields": "블루베리 필즈",
  "なまら": "나마라", "じゃがいも": "자가이모", "みそしる": "미소시루", "ドント・ブリンク": "돈트 블링크", "ばんざい": "반자이", "ネクストステージ": "넥스트 스테이지", "ファイナルフリング": "파이널 플링",
  "こぐま": "코구마", "Koguma": "코구마", "ピュアマジック": "퓨어 매직", "Pure Magic": "퓨어 매직", "クルーザーコース": "크루저 코스", "Cruiser": "크루저 코스", "あげいも": "아게이모", "Ageimo": "아게이모",
  "シェイキー・ニーズ": "셰이키 니즈", "ヤードセール": "야드 세일", "ジャンクヤード": "정크야드", "Nekko no Kabe": "넷코노카베", "スーパースーパースティション": "슈퍼스티션", "だべさ": "다베사", "じょっぴん": "좃핀",
  "シューノケル": "슈노켈", "ワンダーランド": "원더랜드", "Wonderland": "원더랜드",
  "パノラマコース": "파노라마 코스", "チャンピオンコース": "챔피언 코스", "Champion": "챔피언 코스", "ユートピアコース": "유토피아 코스", "Utopia": "유토피아 코스", "Utopia;Shirakaba": "유토피아·시라카바",
  "シルバーコース": "실버 코스", "Silver": "실버 코스", "S字コース": "S자 코스", "深雪林間コース": "후카유키 린칸 코스", "チャレンジコース": "챌린지 코스", "Challenge": "챌린지 코스",
  "ジュニアコース": "주니어 코스", "Junior": "주니어 코스", "パラダイスコース": "파라다이스 코스", "Paradise": "파라다이스 코스", "Dynamic": "다이내믹 코스", "Merchen": "메르헨 코스",
  // 니세코 — 리프트
  "エースファミリークワッド": "에이스 패밀리 쿼드", "キングホリデー第1ペア": "킹 홀리데이 제1 페어", "エースゴンドラ": "에이스 곤돌라", "エース第3ペアリフト": "에이스 제3 페어리프트", "エース第4ペア": "에이스 제4 페어",
  "ワンダーランドチェアA線": "원더랜드 체어 A선", "ワンダーランドチェアB線": "원더랜드 체어 B선", "キング第4リフト": "킹 제4 리프트", "キング第３リフト": "킹 제3 리프트", "スインギングモンキー": "스윙잉 몽키", "King Gondola": "킹 곤돌라",
  "花園第3クワッド フード付": "하나조노 제3 쿼드", "花園第2クワッド": "하나조노 제2 쿼드", "HANAZONO第1リフトフード付き": "하나조노 제1 리프트", "HANAZONO シンフォニーゴンドラ": "하나조노 심포니 곤돌라",
  "ニセコゴンドラ": "니세코 곤돌라", "カントリーロードチェア": "컨트리 로드 체어", "森のチェア": "모리노 체어", "コミュニティーチェア": "커뮤니티 체어", "バンザイチェア": "반자이 체어",
  "ビレッジエクスプレス": "빌리지 익스프레스", "アッパービレッジゴンドラ": "어퍼 빌리지 곤돌라",
  "ジャンボ第１クワッドリフト": "점보 제1 쿼드리프트", "ジャンボ第2ペアリフト": "점보 제2 페어리프트", "ジャンボ第3ペアリフト": "점보 제3 페어리프트", "ジャンボ第4ペアリフト": "점보 제4 페어리프트",
  "アンヌプリゴンドラ": "안누푸리 곤돌라", "ドリーム第1クワッドリフト": "드림 제1 쿼드리프트",
};

const DIFF = { novice: "easy", easy: "easy", intermediate: "intermediate", advanced: "advanced", expert: "advanced", freeride: "advanced", extreme: "advanced" };

// ── 지오 유틸 ───────────────────────────────────────────
const R_EARTH = 6371000;
const rad = (d) => (d * Math.PI) / 180;
function projector(lat0, lon0) {
  const kx = R_EARTH * Math.cos(rad(lat0)) * (Math.PI / 180);
  const ky = R_EARTH * (Math.PI / 180);
  return {
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLL: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}
function inPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.lat > lat !== b.lat > lat && lon < ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat) + a.lon) inside = !inside;
  }
  return inside;
}
const centroid = (g) => ({ lat: g.reduce((s, p) => s + p.lat, 0) / g.length, lon: g.reduce((s, p) => s + p.lon, 0) / g.length });
function km(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return (2 * R_EARTH * Math.asin(Math.sqrt(h))) / 1000;
}

// ── 타일 ────────────────────────────────────────────────
const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => ((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * 2 ** z;

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("PNG 시그니처 아님");
  let off = 8, w = 0, h = 0, colorType = 0, depth = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; colorType = data[9]; interlace = data[12]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error(`지원 안 하는 PNG (depth ${depth}, color ${colorType}, interlace ${interlace})`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      const c = i >= bpp && y > 0 ? out[prev + i - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error("PNG 필터 " + f);
      }
      out[dst + i] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

// 표고 타일 두 종류:
//  gsi: 国土地理院 DEM10B (dem_png, 10m 메시 기반, z14 까지). 값 = (R*65536+G*256+B)*0.01, 0x800000 은 결측
//  terrarium: Mapzen/AWS (SRTM 30m 기반). GSI 결측(바다·범위 밖)을 메우는 용도
const SOURCES = {
  gsi: { url: (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${z}/${x}/${y}.png`, decode: (r, g, b) => { const v = r * 65536 + g * 256 + b; return v === 0x800000 ? NaN : (v < 0x800000 ? v : v - 0x1000000) * 0.01; } },
  terrarium: { url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, decode: (r, g, b) => r * 256 + g + b / 256 - 32768 },
};
async function fetchTile(src, z, x, y) {
  fs.mkdirSync(TILE_DIR, { recursive: true });
  const file = path.join(TILE_DIR, `${src === "terrarium" ? "" : src + "-"}${z}-${x}-${y}.png`);
  if (!fs.existsSync(file)) {
    const url = SOURCES[src].url(z, x, y);
    const res = await fetch(url, { headers: { "User-Agent": "otaru-slopes/0.1 (data build)" } });
    if (res.status === 404) return null; // GSI 범위 밖 타일
    if (!res.ok) throw new Error(`타일 실패 ${url} ${res.status}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    process.stdout.write(`  타일 ${src} ${z}/${x}/${y}\n`);
  }
  return decodePNG(fs.readFileSync(file));
}

// 타일 모자이크 → (lat, lon) 에서 표고(m) 이중선형 보간. GSI 우선, 결측은 terrarium 으로 메움
async function mosaic(bbox) {
  const x0 = Math.floor(lon2x(bbox.w, Z)), x1 = Math.floor(lon2x(bbox.e, Z));
  const y0 = Math.floor(lat2y(bbox.n, Z)), y1 = Math.floor(lat2y(bbox.s, Z));
  const cols = x1 - x0 + 1, rows = y1 - y0 + 1;
  const W = cols * 256, H = rows * 256;
  const hgt = new Float32Array(W * H);
  let filled = 0;
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    const t = await fetchTile("gsi", Z, tx, ty);
    let fb = null;
    for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
      let h = NaN;
      if (t) { const i = (py * t.w + px) * t.bpp; h = SOURCES.gsi.decode(t.data[i], t.data[i + 1], t.data[i + 2]); }
      if (Number.isNaN(h)) {
        fb ??= await fetchTile("terrarium", Z, tx, ty);
        const i = (py * fb.w + px) * fb.bpp; h = SOURCES.terrarium.decode(fb.data[i], fb.data[i + 1], fb.data[i + 2]); filled++;
      }
      hgt[(ty - y0) * 256 * W + (tx - x0) * 256 + py * W + px] = h;
    }
  }
  if (filled) process.stdout.write(`  GSI 결측 ${filled}px 를 terrarium 으로 메움\n`);
  return {
    at(lat, lon) {
      const fx = (lon2x(lon, Z) - x0) * 256 - 0.5, fy = (lat2y(lat, Z) - y0) * 256 - 0.5;
      const ix = Math.max(0, Math.min(W - 2, Math.floor(fx))), iy = Math.max(0, Math.min(H - 2, Math.floor(fy)));
      const u = Math.max(0, Math.min(1, fx - ix)), v = Math.max(0, Math.min(1, fy - iy));
      const h00 = hgt[iy * W + ix], h10 = hgt[iy * W + ix + 1], h01 = hgt[(iy + 1) * W + ix], h11 = hgt[(iy + 1) * W + ix + 1];
      return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
    },
    tiles: cols * rows,
  };
}

// ── 본 작업 ─────────────────────────────────────────────
const osm = [];
const seen = new Set();
for (const f of RAW_FILES) for (const e of JSON.parse(fs.readFileSync(f, "utf8")).elements) { const k = `${e.type}/${e.id}`; if (!seen.has(k)) { seen.add(k); osm.push(e); } }
const byId = new Map(osm.filter((e) => e.type === "way").map((e) => [e.id, e]));
const resorts = RESORTS.map((r) => {
  if (!r.wayId) return { ...r, poly: null, center: null, pistes: [], lifts: [] };
  const w = byId.get(r.wayId);
  if (!w) throw new Error(`리조트 경계 없음 ${r.slug}`);
  return { ...r, poly: w.geometry, center: centroid(w.geometry), pistes: [], lifts: [] };
});
const polyResorts = resorts.filter((r) => r.poly), nisekoResorts = resorts.filter((r) => r.group === "niseko");
const inNiseko = (c) => c.lat >= NISEKO_BBOX.s && c.lat <= NISEKO_BBOX.n && c.lon >= NISEKO_BBOX.w && c.lon <= NISEKO_BBOX.e;

// 경계 폴리곤이 있는 리조트: 중심이 폴리곤 안이면 그곳, 아니면 3.2km 안의 가장 가까운 곳
function assignByPoly(e) {
  const c = centroid(e.geometry);
  let hit = polyResorts.find((r) => inPoly(c.lat, c.lon, r.poly));
  if (!hit) {
    const near = polyResorts.map((r) => ({ r, d: km(c, r.center) })).sort((a, b) => a.d - b.d)[0];
    if (near.d <= ASSIGN_KM) hit = near.r;
  }
  return hit;
}
// 니세코: 코스의 어느 점이든 가장 가까운 리프트 점을 가진 구역
function assignNiseko(e) {
  let best = null, bestD = Infinity;
  for (const r of nisekoResorts) for (const l of r.lifts) for (const a of e.geometry) for (const b of l.geometry) {
    const d = km(a, b); if (d < bestD) { bestD = d; best = r; }
  }
  return bestD <= NISEKO_MAX_KM ? best : null;
}

const isPiste = (t) => t["piste:type"] === "downhill" || t["piste:type"] === "mogul" || t["piste:type"] === "snow_park";
const isLift = (t) => t.aerialway && !["station", "pylon", "yes", "zip_line", "goods"].includes(t.aerialway);
const ways = osm.filter((e) => e.type === "way" && e.geometry);
// 1) 리프트 먼저 (니세코는 이름으로)
for (const e of ways) {
  const t = e.tags || {};
  if (!isLift(t)) continue;
  const c = centroid(e.geometry);
  if (inNiseko(c)) { const r = nisekoResorts.find((r) => r.liftRe.test(`${t.name ?? ""} ${t["name:en"] ?? ""}`)); if (r) r.lifts.push(e); else console.log(`  니세코 리프트 구역 미정 → 제외: ${e.id} ${t.name} / ${t["name:en"]}`); }
  else { const r = assignByPoly(e); if (r) r.lifts.push(e); }
}
// 2) 코스
for (const e of ways) {
  const t = e.tags || {};
  if (!isPiste(t)) continue;
  const c = centroid(e.geometry);
  const r = inNiseko(c) ? assignNiseko(e) : assignByPoly(e);
  if (r) r.pistes.push(e);
}
for (const r of nisekoResorts) {
  r.center = centroid([...r.pistes.flatMap((p) => p.geometry), ...r.lifts.flatMap((l) => l.geometry)]);
}

const index = [];
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const r of resorts) {
  const all = [...(r.poly ?? []), ...r.pistes.flatMap((p) => p.geometry), ...r.lifts.flatMap((l) => l.geometry)];
  const lat0 = r.center.lat, lon0 = r.center.lon;
  const { toXY, toLL } = projector(lat0, lon0);
  const xs = all.map((p) => toXY(p.lat, p.lon));
  let minX = Math.min(...xs.map((p) => p[0])) - PAD_M, maxX = Math.max(...xs.map((p) => p[0])) + PAD_M;
  let minY = Math.min(...xs.map((p) => p[1])) - PAD_M, maxY = Math.max(...xs.map((p) => p[1])) + PAD_M;
  // 격자 간격: 긴 변이 MAX_GRID 샘플이 되도록, 5m 단위 올림
  const span = Math.max(maxX - minX, maxY - minY);
  const step = Math.max(MIN_STEP, Math.ceil(span / (MAX_GRID - 1) / 5) * 5);
  const cols = Math.floor((maxX - minX) / step) + 1, rows = Math.floor((maxY - minY) / step) + 1;
  maxX = minX + (cols - 1) * step; maxY = minY + (rows - 1) * step;

  const [sLat, wLon] = toLL(minX, minY), [nLat, eLon] = toLL(maxX, maxY);
  const dem = await mosaic({ n: nLat + 0.002, s: sLat - 0.002, w: wLon - 0.002, e: eLon + 0.002 });
  const elevAt = (x, y) => { const [la, lo] = toLL(x, y); return dem.at(la, lo); };

  // 높이 격자: 북→남 행, 서→동 열. 데시미터 Int16
  const heights = new Int16Array(cols * rows);
  let hMin = Infinity, hMax = -Infinity;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const h = elevAt(minX + i * step, maxY - j * step);
    heights[j * cols + i] = Math.round(h * 10);
    if (h < hMin) hMin = h; if (h > hMax) hMax = h;
  }

  const line3 = (geom) => {
    const pts = geom.map((p) => { const [x, y] = toXY(p.lat, p.lon); return [x, y, elevAt(x, y)]; });
    let len = 0, len2d = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], dz = pts[i][2] - pts[i - 1][2];
      len2d += Math.hypot(dx, dy); len += Math.hypot(dx, dy, dz);
    }
    const zs = pts.map((p) => p[2]);
    return { pts: pts.map((p) => p.map((v) => Math.round(v * 10) / 10)), len: Math.round(len), len2d: Math.round(len2d), top: Math.round(Math.max(...zs)), bottom: Math.round(Math.min(...zs)) };
  };

  const pistes = r.pistes.map((e, k) => {
    const t = e.tags;
    const g = line3(e.geometry);
    const isArea = t.area === "yes" || (e.geometry.length > 3 && e.geometry[0].lat === e.geometry.at(-1).lat && e.geometry[0].lon === e.geometry.at(-1).lon);
    const name = t.name || t["name:en"] || null;
    const drop = g.top - g.bottom;
    const grade = g.len2d > 0 ? Math.round((drop / g.len2d) * 100) : null;
    return {
      id: e.id, ja: t.name || null, en: t["name:en"] || (t.name && /^[A-Za-z]/.test(t.name) ? t.name : null),
      ko: (t.name && KO[t.name]) || (t["name:en"] && KO[t["name:en"]]) || null,
      named: !!name, kind: t["piste:type"], difficulty: DIFF[t["piste:difficulty"]] || "unknown", rawDifficulty: t["piste:difficulty"] || null,
      area: isArea, len: g.len, len2d: g.len2d, top: g.top, bottom: g.bottom, drop, grade, pts: g.pts,
    };
  });
  const lifts = r.lifts.map((e) => {
    const t = e.tags;
    const g = line3(e.geometry);
    return { id: e.id, ja: t.name || null, en: t["name:en"] || null, ko: (t.name && KO[t.name]) || null, kind: t.aerialway, occupancy: t["aerialway:occupancy"] ? Number(t["aerialway:occupancy"]) : null, len: g.len2d, top: g.top, bottom: g.bottom, pts: g.pts };
  });

  // 요약
  const runPts = pistes.flatMap((p) => p.pts);
  const top = Math.round(Math.max(...runPts.map((p) => p[2]))), base = Math.round(Math.min(...runPts.map((p) => p[2])));
  const topPt = runPts.find((p) => Math.round(p[2]) === top), basePt = runPts.find((p) => Math.round(p[2]) === base);
  const longest = pistes.filter((p) => !p.area).sort((a, b) => b.len - a.len)[0];
  const counts = { easy: 0, intermediate: 0, advanced: 0, unknown: 0 };
  const listed = pistes.filter((p) => !p.area || (p.named && !pistes.some((q) => !q.area && q.named && (q.ja === p.ja || (q.en && q.en === p.en)))));
  for (const p of listed) counts[p.difficulty]++;

  const out = {
    slug: r.slug, ko: r.ko, ja: r.ja, en: r.en, short: r.short, city: r.city,
    origin: { lat: lat0, lon: lon0 },
    grid: { cols, rows, step, minX, maxY, hMin: Math.round(hMin), hMax: Math.round(hMax), heights: Buffer.from(heights.buffer).toString("base64") },
    boundary: (r.poly ?? []).map((p) => toXY(p.lat, p.lon).map((v) => Math.round(v))),
    group: r.group ?? "otaru",
    summary: { top, base, drop: top - base, runs: listed.length, lifts: lifts.length, counts, longest: longest ? { id: longest.id, len: longest.len } : null, topPt: topPt.map((v) => Math.round(v)), basePt: basePt.map((v) => Math.round(v)) },
    pistes, lifts,
    source: { osm: "© OpenStreetMap contributors (ODbL)", dem: "国土地理院 DEM10B (dem_png z14), 결측은 Mapzen/AWS Terrain Tiles", built: new Date().toISOString().slice(0, 10) },
  };
  fs.writeFileSync(path.join(OUT_DIR, `${r.slug}.json`), JSON.stringify(out));
  index.push({ slug: r.slug, ko: r.ko, ja: r.ja, en: r.en, short: r.short, city: r.city, group: out.group, lat: lat0, lon: lon0, summary: out.summary });
  console.log(`${r.slug.padEnd(10)} 격자 ${cols}x${rows}@${step}m 타일 ${dem.tiles} 표고 ${Math.round(hMin)}–${Math.round(hMax)}m | 피스트 ${pistes.length} (목록 ${listed.length}, 면 ${pistes.filter((p) => p.area).length}) 리프트 ${lifts.length} | 정상 ${top}m 베이스 ${base}m`);
}
fs.writeFileSync(path.join(OUT_DIR, "resorts.json"), JSON.stringify({ built: new Date().toISOString().slice(0, 10), resorts: index }, null, 1));

// ── 자가 검증: 공개 수치(weathernews.jp 스키장 정보 등)와 비교. OSM 피스트 끝점 표고라 ±60m 허용 ──
// 니세코: 히라후 1200/260, 빌리지 1170/280, 안누푸리 1156/400 (weathernews.jp). 하나조노는 리프트 정상 기준 약 1045/308 (표고차 737m 기사 + 베이스 308m)
const EXPECT = { tenguyama: [532, 150], asarigawa: [660, 140], kiroro: [1180, 570], teine: [1023, 350], kokusai: [1100, 630], hirafu: [1200, 260], village: [1170, 280], annupuri: [1156, 400], hanazono: [1045, 308] };
let bad = 0;
for (const r of index) {
  const [et, eb] = EXPECT[r.slug];
  const okTop = Math.abs(r.summary.top - et) <= 60, okBase = Math.abs(r.summary.base - eb) <= 60;
  if (!okTop || !okBase || r.summary.runs < 5 || r.summary.lifts < 2) { bad++; console.log(`!! 검증 실패 ${r.slug}: top ${r.summary.top} (기대 ~${et}) base ${r.summary.base} (기대 ~${eb}) runs ${r.summary.runs} lifts ${r.summary.lifts}`); }
}
console.log(bad ? `검증 실패 ${bad}건` : `검증 통과: ${index.length}개 리조트 정상/베이스 표고가 공개 수치 ±60m 안, 코스·리프트 수 충분`);
process.exitCode = bad ? 1 : 0;
