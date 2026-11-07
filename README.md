# Pioneer DJ DDJ-FLX4 Web DJ Controller & Auto DJ Pro

Pioneer DJ DDJ-FLX4 の操作感とサウンドエンジンをWebブラウザ上で忠実に再現した次世代Web DJコントローラーです。
Web Audio API を活用した完全クライアントサイド動作に対応しており、PCが起動していなくてもスマートフォン（iPhone / iPad / Android）やノートPCのブラウザから24時間365日いつでもアクセスして本格的なDJプレイおよびAuto DJが利用可能です。

---

## 公開URL (GitHub Pages)

PCの電源が入っていなくても、以下のURLからいつでもスマートフォンやPCのブラウザで直接起動できます。

- URL: https://welina801uruoi-cpu.github.io/ddj-flx4-web/

---

## 主な機能

### 1. 本格2デッキ・DJミキサー & ジョグホイール
- 3バンド・アイソレーターEQ (HI / MID / LOW: -26dB 〜 +6dB)
- Pioneer FLX4 スタイルのジョグホイール（タッチスクラッチ、ピッチベンド、VINYLモード）
- 中央オングジョグLCDディスプレイ切替（BPM / REMAIN / BAR / LOOP / VINYL）
- テンポスライダー（±6% / ±10% / ±16% / WIDE）
- 高音質キーロック / マスターテンポ（WSOLA 動的探索型ピッチシフター）
- SMART CFX / SMART FADER（クロスフェーダー連動オートフィルター・オートEQスワップ）

### 2. Rekordbox スタイル 3-Band 高精度波形描画 (60FPS)
- 周波数帯域別カラー波形（低音: シアン / 中音: アンバー / 高音: ホワイト）
- ビートグリッド線 & 1拍目ダウンビート赤線・小節番号自動カウント表示
- 全体オーバービュー波形 & リアルタイムズーム波形

### 3. AUTO DJ PRO (世界トップDJ 3大プレイスタイル搭載)
- PRO ALL-STAR: 世界トップDJのプレイスタイルを1サイクルごとに自動展開
- David Guetta @ Tomorrowland 2026: Future Rave / Afro-Tech、3/4拍エコーフリーズ、フェーダースラム
- MITOMI TOKOTO @ ageHa: KICK-ASS 縦フェーダーハーモニックブレンド、HPF + 1/2拍エコー引き戻し、ビート同期カットイン
- Nicky Romero @ Tomorrowland 2019: Bootlegボーカル重ね、2B→1B CDJループロール、1拍前スポットライトブレイク

### 4. インテリジェント・ミキシングロジック
- スマート・マッシュアップ & ライブレイヤリング: 楽曲のサビ（ドロップ）や歌詞の開始位置を自動解析し、前曲のリズムに乗せて次曲のビルドアップを重ね合わせる高度なマッシュアップ
- LOWスワップ & スマート・ローカット・アタック: ドロップ着地時の低域衝突（濁り・歪み）を防ぐため、1拍目に新曲のLOWを9:30(-7.5dB)にカットし2〜4拍目で自然に0dBへ戻すプロ仕様のフェーダーワーク
- テンポ・スロープ（BPMランプアップ）: テンポ差のある曲間を4〜6小節かけて滑らかに加減速

### 5. 画面 + 音声 録画・録音機能 (Screen + Audio Recorder)
- コントローラー画面の動きとDJマスター出力を完全同期でMP4動画として直接キャプチャ
- スマートフォン（iOS 写真アプリ / ファイルアプリ共有）およびPCダウンロードに対応

### 6. 音源読み込み対応
- ローカル音源: MP3 / M4A / WAV / AAC / FLAC / AIFF
- iPhone「ミュージック」アプリ / iTunes 同期ライブラリ連携
- YouTube / YouTube Music 検索・自動抽出（ローカルサーバーまたはクラウドサーバー起動時）

---

## 使い方 (PCを起動していない場合)

1. iPhone / iPad / PCのブラウザ（Safari, Chrome等）で [https://welina801uruoi-cpu.github.io/ddj-flx4-web/](https://welina801uruoi-cpu.github.io/ddj-flx4-web/) を開きます。
2. 上部ヘッダーの「Load Deck 1」「Load Deck 2」または「選曲 / セットリスト」の「PC・iPhoneファイルから曲を選択」をタップします。
3. iPhoneの「ファイル」アプリやダウンロード済みの音楽ファイル（.mp3 / .m4a / .wav 等）を選択すると、ブラウザ内の Web Audio API で瞬時にデコードされ、波形が表示されます。
4. 「AUTO DJ PRO」ボタンを押すと、自動的に小節管理・BPM同期・EQスワップが行われ、DJパフォーマンスが開始されます。

---

## ローカルPCでサーバーを起動する場合

PC側で YouTube ダウンロード機能やローカル音楽フォルダのスキャンを利用したい場合は、以下を実行します。

```bash
# 依存パッケージのインストール
pip install -r requirements.txt

# サーバー起動
python ddj_flx4_app.py
```

起動後、PCブラウザからは `http://127.0.0.1:8090`、同一Wi-Fi内のスマホからは `http://[PCのIPアドレス]:8090` でアクセスできます。

---

## クラウドへのデプロイ (24時間サーバー稼働)

Pythonバックエンドも含めてクラウド上で常時起動させたい場合:

### Docker
```bash
docker build -t ddj-flx4-web .
docker run -p 8090:8090 ddj-flx4-web
```

### Render.com
1. Render.com にログインし、「New Web Service」を作成
2. 本リポジトリ (welina801uruoi-cpu/ddj-flx4-web) を選択
3. 自動的に `render.yaml` が読み込まれ、無料でデプロイされます。
