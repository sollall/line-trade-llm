# line-trade-llm

自分でチャートに引いたライン(水平線・トレンドライン)に価格がタッチした際、直近のOHLCVをLLM(Claude)に読ませて「明確に割ったか / ヒゲで否定されて戻ってきているだけか」を判定させ、その判定ロジックをバックテストで検証するための実装です。仕様は元の仕様書(v0.2)に準拠しています。v0.2時点では自動発注は対象外で、判定ロジックの有効性検証が目的です。

## 構成

```
line-trade-llm/
  shared/     touch/LLM/exchange クライアントなど、Worker(本番)とbacktest(オフライン再生)の両方が
              同じロジックで動くよう共有するTypeScriptコード
  worker/     Cloudflare Workers本体。POST/GET/DELETE /lines, GET /candles, 1分間隔のCron Trigger
  backtest/   過去データに対してタッチ検知→LLM判定→仮想売買を再生し、勝率等を集計するCLI
  frontend/   KLineCharts(CDN読込)によるライン描画UI。静的ファイルなのでどこでもホスト可能
```

`shared/` にタッチ判定(`touch.ts`)・LLMプロンプト構築とClaude呼び出し(`llm/`)・取引所クライアント(`exchanges/`)をまとめてあるのは、**本番のCron判定とバックテストの再生が完全に同じロジックで動く**ことを保証するためです。バックテストの結果が本番の挙動をそのまま予測できないと検証の意味がありません。

## セットアップ

```bash
npm install
```

Node.js 20+ 推奨(開発は Node 22 で確認済み)。

### 1. Cloudflare リソースの作成

```bash
cd worker
npx wrangler d1 create line_trade_llm      # 出力された database_id を wrangler.toml に貼る
npx wrangler kv namespace create LLM_CACHE  # 出力された id を wrangler.toml に貼る
npx wrangler secret put ANTHROPIC_API_KEY   # Claude APIキー
npm run db:migrate:remote                   # schema.sql をD1に適用(ローカル開発時は db:migrate:local)
```

`wrangler.toml` の `[vars]` で以下を調整できます:

| 変数 | 意味 | デフォルト |
|---|---|---|
| `EXCHANGE` | 価格取得元。`hyperliquid` \| `backpack` | `hyperliquid` |
| `CANDLE_INTERVAL_MINUTES` | ローソク足の間隔(分) | `1` |
| `CANDLE_WINDOW` | LLMに渡す直近本数 | `15` |
| `TOUCH_THRESHOLD_PCT` | タッチとみなす価格との相対距離(未決事項、要チューニング) | `0.0005` |
| `MAX_UNDETERMINED_RETRIES` | `undetermined`の再判定上限(未決事項、要チューニング) | `8` |
| `CLAUDE_MODEL` | 判定に使うClaudeモデル | `claude-sonnet-5` |

### 2. Workerの起動・デプロイ

```bash
npm run dev:worker      # ローカル開発 (wrangler dev)
npm run deploy:worker   # 本番デプロイ
```

### 3. フロントエンド(ライン描画UI)

`frontend/` はビルド不要の静的ファイル(`index.html` / `app.js` / `style.css`)です。`npx serve frontend` 等で配信するか、Cloudflare Pages 等にそのまま置いてください。画面上部の「API Base」にWorkerのURLを入力すれば動作します。

- KLineCharts(CDN, jsdelivr)でローソク足を表示(データはWorkerの `GET /candles` 経由で取引所から取得)
- 「水平線」ボタン→チャートを1クリックで水平線を保存、「トレンドライン」ボタン→2クリックで保存
- 登録済みラインの一覧・削除

## API

| エンドポイント | 説明 |
|---|---|
| `POST /lines` | ライン登録。body: `{ symbol, kind: "horizontal"\|"trend", points: {price,timestamp}[] }` |
| `GET /lines?symbol=` | ライン一覧取得 |
| `DELETE /lines/{id}` | ライン削除 |
| `GET /candles?symbol=&limit=` | チャート表示用のOHLCV取得(取引所へのプロキシ) |

Cron Trigger(1分間隔)が全ラインを銘柄ごとにまとめて価格・ローソク足を取得し、タッチ検知→(タッチ済みなら)LLM判定を行い、`touch_events` に記録します。判定が`undetermined`の場合は次のCronサイクルで再判定します(仕様6.4)。API/LLM呼び出しの失敗は`status: failed`として次のCronに委ねます(仕様4.2)。

## バックテスト

```bash
# lines.json は GET /lines のレスポンスをそのまま保存したもの
curl "http://localhost:8787/lines?symbol=BTC" > lines.json

npm run backtest -- \
  --lines lines.json --symbol BTC \
  --start 2024-01-01 --end 2024-02-01 \
  --llm mock        # まずAPI課金なしでロジックの疎通確認
```

`--llm claude --claude-api-key sk-ant-...` (または `ANTHROPIC_API_KEY` 環境変数)にすると実際にClaudeで判定し、`output/` に以下を出力します:

- `backtest_result.json` — `win_rate` / `profit_factor` / `max_drawdown` / `total_trades`(仕様5.3)
- `trades.json` — 仮想売買ごとの詳細(方向・エントリー/エグジット・R倍数)
- `touch_log.json` — タッチイベントごとのLLM判定履歴(何本待って確定したか含む)

全オプションは `npm run backtest -- --help` 相当で `npm run backtest --` を引数なしで実行すると表示されます。

### 仮想売買ルール(v0.2独自の暫定ルール)

仕様書は判定ロジック(3値分類)までを定義しており、判定後の具体的なエントリー/エグジットルールは範囲外です(仕様9の未決事項)。バックテストでは以下の暫定ルールで仮想売買しています(`backtest/src/replay.ts`):

- `break_confirmed` でエントリー(レジスタンス上抜け→ロング、サポート下抜け→ショート)
- ストップロス = 割れたライン自体の値、テイクプロフィット = リスクの `--rr` 倍(デフォルト2倍)
- `--max-hold-bars` を超えても未決着ならその足の終値で手仕舞い

必要に応じて `replay.ts` のこの部分だけ差し替えれば、別のエグジットルールで再検証できます。

## 判定(LLM)の入出力

`shared/src/llm/prompt.ts` / `shared/src/llm/client.ts` を参照。Claude APIを `tool_choice` で `report_judgment` ツール呼び出しに強制し、構造化JSON `{decision, confidence, reasoning}` を取得します(仕様6.3)。同一ライン・近い価格帯・近い時間帯の判定はKVにキャッシュし重複課金を防ぎます(仕様8)。

## 実装済み範囲 / 今後の検討課題(仕様9より)

以下は仕様書に「未決事項」として明記されている、または実装上の仮決め箇所です。動くものを優先して妥当な初期値を入れていますが、実運用前に検証・調整してください:

- タッチ判定閾値(`TOUCH_THRESHOLD_PCT`)・`undetermined`リトライ上限(`MAX_UNDETERMINED_RETRIES`)は暫定値
- トレンドラインは2点から時刻方向に無限延長する「半直線/直線」として扱っています(区間=segmentとして打ち切る運用にしたい場合は `shared/src/touch.ts` の `lineValueAt` を要修正)
- LLM入力はテキスト(案A)のみ実装。画像入力(案B)は未実装
- バックテストの手数料・スリッページは未考慮(`pnl_pct`は無レバレッジの価格変化率のみ)
- v0.3以降のアラート通知・自動発注は対象外(仕様2.2)

## 動作確認

- 3ワークスペース(`shared`/`worker`/`backtest`)すべて `npm run typecheck` 通過
- `wrangler deploy --dry-run` でWorkerのバンドル(shared依存込み)を確認済み
- `backtest` はモックLLMでの合成データ再生(タッチ検知→判定ループ→仮想売買→指標集計)まで動作確認済み
- Claude実呼び出し・実取引所APIでの通しは未実施(APIキー・実データが必要なため)。デプロイ前に `--llm claude` で少量期間のバックテストを行うことを推奨します
