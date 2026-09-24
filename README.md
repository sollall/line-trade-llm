# line-trade-llm

自分でチャートに引いたライン(水平線・トレンドライン)について、ラインごとに選んだ時間足が確定するたびに直近のOHLCVをLLM(Claude)に読ませ、「上で維持 / 下で維持 / 試している最中 / 上抜け確定 / 下抜け確定」のどの状態かを判定させ、その判定ロジックをバックテストで検証するための実装です。仕様は元の仕様書(v0.2)に準拠しています。v0.2時点では自動発注は対象外で、判定ロジックの有効性検証が目的です。

## 構成

```
line-trade-llm/
  shared/     ライン計算/LLM/exchange クライアントなど、Worker(本番)とbacktest(オフライン再生)の両方が
              同じロジックで動くよう共有するTypeScriptコード
  worker/     Cloudflare Workers本体。POST/GET/DELETE /lines, GET /lines/{id}/checks, GET /candles, 1分間隔のCron Trigger
  backtest/   過去データに対して定期判定→状態遷移→仮想売買を再生し、勝率等を集計するCLI
  frontend/   TradingView Lightweight Charts(CDN読込)によるライン描画UI。静的ファイルなのでどこでもホスト可能
```

`shared/` にライン計算(`line.ts`)・LLMプロンプト構築とClaude呼び出し(`llm/`)・取引所クライアント(`exchanges/`)をまとめてあるのは、**本番のCron判定とバックテストの再生が完全に同じロジックで動く**ことを保証するためです。バックテストの結果が本番の挙動をそのまま予測できないと検証の意味がありません。

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

タッチ判定版(`touch_events` テーブルがある旧スキーマ)のD1を使っている場合は、代わりに移行用SQLを1回だけ流してください。`lines` に判定足・状態の列を追加し、`line_checks` を作成します。旧方式の判定結果である `touch_events` は削除されます(ライン削除を外部キーでブロックしてしまうため)。

```bash
npm run db:migrate:periodic:remote          # ローカルは db:migrate:periodic:local
```

#### APIトークンの権限設定

- `ANTHROPIC_API_KEY`: [Anthropic Console](https://console.anthropic.com/settings/keys) で発行するキーです。このWorkerが使うのはMessages API(判定リクエスト)のみで、Admin API(組織設定・メンバー管理・他キーの発行/失効など)の権限は不要です。Cron Triggerから自動的に呼び出され続ける常駐シークレットになるため、可能であれば他のプロジェクトと共有せず本プロジェクト専用のWorkspaceを作成してキーを発行し、Workspace側で使用量上限(spend limit)を設定しておくことを推奨します。漏洩時の影響範囲を絞るためです。
- 取引所(`hyperliquid` / `backpack`)側は本実装では公開のマーケットデータエンドポイント(現在値・ローソク足取得)のみを叩いており、APIキーや署名は一切使用していません。v0.2は自動発注非対応(判定ロジック検証のみ)のため、取引所側の資産にアクセスできるキーを発行・設定する必要はありません。

`wrangler.toml` の `[vars]` で以下を調整できます:

| 変数 | 意味 | デフォルト |
|---|---|---|
| `EXCHANGE` | 価格取得元。`hyperliquid` \| `backpack` | `hyperliquid` |
| `DEFAULT_CHECK_INTERVAL_MINUTES` | 判定足を指定せずに作成したラインの判定足(分)。`GET /candles` の既定の時間足も兼ねる | `15` |
| `CANDLE_WINDOW` | LLMに渡す直近の確定足の本数 | `15` |
| `CHECK_MARGIN_PCT` | 直近足の安値〜高値の範囲をこの割合だけ広げた範囲にラインが入っていなければ、LLMを呼ばずにスキップ(要チューニング) | `0.002` |
| `CLAUDE_MODEL` | 判定に使うClaudeモデル | `claude-sonnet-5` |

### 2. Workerの起動・デプロイ

```bash
npm run dev:worker      # ローカル開発 (wrangler dev)
npm run deploy:worker   # 本番デプロイ
```

### 3. フロントエンド(ライン描画UI)

`frontend/` はビルド不要の静的ファイル(`index.html` / `app.js` / `style.css`)です。`npx serve frontend` 等で配信するか、Cloudflare Pages 等にそのまま置いてください。画面上部の「API Base」にWorkerのURLを入力すれば動作します。

- [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)(Apache-2.0, CDN/jsdelivr)でローソク足を表示(データはWorkerの `GET /candles` 経由で取引所から取得)。ライセンス上の帰属表示としてチャート左下のTradingViewロゴ(`attributionLogo`)は有効のままにしています
- Lightweight Chartsには描画ツールが無いため、水平線は `createPriceLine`、トレンドラインは自前のSeries Primitive(`frontend/app.js` の `TrendLinesPrimitive`)で描画しています。トレンドラインは判定(`shared/src/line.ts` の `lineValueAt`)と同じく2点を通る直線として両方向に延長して表示します
- 「Symbol」は `GET /symbols` で取得した、`EXCHANGE`(デフォルトはHyperliquid)で現在取引可能な銘柄だけをプルダウンで表示します(24h出来高の多い順)。Hyperliquidの場合はメインDEXのPerp銘柄で、上場廃止(delisted)銘柄は除外されます。一覧は「読み込み」ボタンで再取得します
- 「時間足」で表示する足(1分〜日足)を切り替えられます。これは表示用で、判定に使う足はライン作成時に「判定足」で選んだものです(作成後は変更不可)。ラインは時刻と価格で保存しているので、どの時間足で引いても同じラインとして扱われます
- 初回は直近1000本を読み込み、チャートを左端近くまでスクロールすると更に1000本ずつ過去を読み込みます。取引所が返せる範囲が上限で、Hyperliquidは時間足ごとに直近5000本までしか返さないため、1分足なら約3.5日、15分足なら約52日、日足なら約13年が遡れる目安です
- 「水平線」ボタン→チャートを1クリックで水平線を保存、「トレンドライン」ボタン→2クリックで保存
- 描画前に「判定足」(1分〜日足、既定15分)を選んでおくと、そのラインはその時間足が確定するたびに判定されます
- 登録済みラインの一覧に判定足と現在の状態を表示。行を選択すると下に「判定履歴」(判定した足・状態・確信度・理由、LLMに送ったプロンプト全文)が出ます。「状態が変わった判定だけ表示」で絞り込めます
- 登録済みラインの一覧・削除。描画モードが「なし」のときにチャート上のラインをクリック(または一覧の行をクリック)すると選択状態になり、「選択中のラインを削除」ボタンかDeleteキーで削除できます(Escで選択解除)。カーソルを乗せたラインと、一覧でマウスを乗せた行のラインは太く強調表示されます

## ローカルでの動作確認

Cloudflareへのデプロイやアカウントは不要です。外部に接続するのは取引所の公開API(キー不要)と、LLM判定時のClaude APIだけです。

### 起動

```bash
cd worker
npm run db:migrate:local                          # 初回だけ。ローカルD1にテーブルを作る
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars   # 初回だけ(.gitignore済み)
cd ..

npm run dev:worker:test   # ターミナル1: Worker(Cronを手動で動かせるモード)
npx serve frontend        # ターミナル2: フロント(表示されたURLを開き、API Baseを http://localhost:8787 に)
```

ローカルではCronが自動では動きません。判定足が確定した後に、次のコマンドで1回分を手動実行します。

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

判定足を「1分」にして現在価格のすぐ近くに線を引くと、1分待つだけで判定を確認できます(遠い線はLLMを呼ばずにスキップされます)。結果は画面の「状態」列と「判定履歴」、または `GET /lines/{id}/checks` で確認できます。

### データの保存場所とリセット

引いたラインと判定履歴は、Workerのローカル D1(`worker/.wrangler/state/` 内のSQLite)に保存されています。`lines.json` はバックテスト用に書き出したコピーなので、編集・削除しても画面やCronには影響しません。

| やりたいこと | コマンド(リポジトリ直下) |
|---|---|
| ラインと判定履歴だけ全部消す | `npm run db:clear:local` |
| ローカルのD1・KV(判定キャッシュ)を丸ごと消してテーブルを作り直す | `npm run db:reset:local` |
| 1本だけ消す | 画面の「削除」ボタン、またはラインを選択してDeleteキー |

- `db:reset:local` は Worker(`wrangler dev`)を止めてから実行し、終わったら起動し直してください。起動したまま実行すると、Workerが消えたDBを掴んだままになり、ラインの保存などが `500 {"error":"internal error; reference = ..."}` で失敗します(Workerを再起動すれば直ります)
- `no such table: line_checks` などのエラーが出る場合は、ローカルD1がタッチ判定版の旧スキーマのままです。データが不要なら `npm run db:reset:local`、残したいなら `cd worker && npm run db:migrate:periodic:local` を実行してください
- 消したあとにバックテストする場合は、ラインを引き直してから `curl "http://localhost:8787/lines?symbol=BTC" > lines.json` で書き出し直してください

## API

| エンドポイント | 説明 |
|---|---|
| `POST /lines` | ライン登録。body: `{ symbol, kind: "horizontal"\|"trend", points: {price,timestamp}[], check_interval_minutes? }`。`check_interval_minutes` は判定足(分、1,3,5,15,30,60,120,240,480,720,1440)で、省略時は `DEFAULT_CHECK_INTERVAL_MINUTES` |
| `GET /lines?symbol=` | ライン一覧取得。各ラインに現在の `state` / `state_since`(その状態になった足の時刻) / `last_checked_candle` を含む |
| `GET /lines/{id}/checks?limit=&changes_only=1` | ラインの判定履歴(新しい順、既定100件・最大1000件)。各判定に送ったプロンプト全文・状態・確信度・理由を含む。`changes_only=1` で状態が変わった判定のみ |
| `DELETE /lines/{id}` | ライン削除 |
| `GET /symbols` | `EXCHANGE` で取引可能な銘柄一覧。`[{ symbol, dayVolume }]` を24h出来高(quote建て)の降順で返す。Hyperliquidは `metaAndAssetCtxs` のメインDEX Perpから上場廃止銘柄を除いたもの |
| `GET /candles?symbol=&interval=&limit=&endTime=` | チャート表示用のOHLCV取得(取引所へのプロキシ)。`interval`は分(1,3,5,15,30,60,120,240,480,720,1440、省略時は`DEFAULT_CHECK_INTERVAL_MINUTES`)、`limit`は`endTime`(epoch ms、省略時は現在)以前の本数で最大5000。取引所の1リクエストあたりの上限を超える分はページングして取得 |

### 定期判定の流れ

Cron Trigger は1分ごとに動きますが、各ラインを判定するのは**そのラインの判定足が確定したとき**だけです。

1. ラインを「銘柄×判定足」でまとめ、最新の確定足がまだ判定されていないラインがあるグループだけ、取引所から直近 `CANDLE_WINDOW` 本の確定足を取得します(形成中の足は除外。取引所がまだ確定足を返さなければ次の分に再試行)
2. ラインが直近足の安値〜高値(±`CHECK_MARGIN_PCT`)の範囲から外れていれば、LLMを呼ばずにその足を判定済みにします
3. 範囲内なら、直近足と**前回の状態・理由**を渡してLLMに状態を判定させ、`line_checks` に(送ったプロンプトごと)記録し、`lines` の現在の状態を更新します

| 状態 | 意味 |
|---|---|
| `holding_above` | 上で維持(ラインより上、またはサポートとして機能) |
| `holding_below` | 下で維持(ラインより下、またはレジスタンスとして機能) |
| `testing` | 試している最中(ライン付近で攻防中) |
| `broken_up` | 上抜け確定(抜けが確定した足でのみ報告。以降も上で推移すれば `holding_above` に戻る) |
| `broken_down` | 下抜け確定(同上、以降は `holding_below`) |

LLM呼び出しは1回の判定につき最大3回(初回+2回リトライ)まで試し、それでも失敗した場合は何も記録せず、次の分のCronが同じ足を再判定します(仕様4.2)。Cronが一度止まっても、次に動いたときに最新の確定足で判定し直します。

呼び出し回数の目安は「判定足1本につき、価格の近くにあるライン1本あたり1回」です(例: 15分足で常に価格の近くにあるライン1本なら1日最大96回)。同じラインの同じ足の判定はKVにキャッシュし、Cronが同じ足をやり直しても再課金しません(仕様8)。

## バックテスト

```bash
# lines.json は GET /lines のレスポンスをそのまま保存したもの(各ラインの check_interval_minutes の足で再生)
# (リポジトリ直下で実行。--lines / --out の相対パスは npm を実行したディレクトリ基準)
curl "http://localhost:8787/lines?symbol=BTC" > lines.json

npm run backtest -- \
  --lines lines.json --symbol BTC \
  --start 2024-01-01 --end 2024-02-01 \
  --llm mock        # まずAPI課金なしでロジックの疎通確認
```

`--llm claude --claude-api-key sk-ant-...` (または `ANTHROPIC_API_KEY` 環境変数)にすると実際にClaudeで判定し、`output/` に以下を出力します:

- `backtest_result.json` — `win_rate` / `profit_factor` / `max_drawdown` / `total_trades`(仕様5.3)
- `trades.json` — 仮想売買ごとの詳細(方向・エントリー/エグジット・R倍数)
- `check_log.json` — 足ごとの判定履歴(状態・前回の状態・理由・送ったプロンプト)

全オプションは `npm run backtest -- --help` 相当で `npm run backtest --` を引数なしで実行すると表示されます。

### 仮想売買ルール(v0.2独自の暫定ルール)

仕様書は判定ロジック(3値分類)までを定義しており、判定後の具体的なエントリー/エグジットルールは範囲外です(仕様9の未決事項)。バックテストでは以下の暫定ルールで仮想売買しています(`backtest/src/replay.ts`):

- 状態が `broken_up` に変わった足の終値でロング、`broken_down` に変わった足の終値でショート(同じラインの前のトレードが決済されるまでは新規エントリーしない)
- ストップロス = 割れたライン自体の値、テイクプロフィット = リスクの `--rr` 倍(デフォルト2倍)
- `--max-hold-bars` を超えても未決着ならその足の終値で手仕舞い

必要に応じて `replay.ts` のこの部分だけ差し替えれば、別のエグジットルールで再検証できます。

## 判定(LLM)の入出力

`shared/src/llm/prompt.ts` / `shared/src/llm/client.ts` を参照。システムプロンプト(固定)と、銘柄・判定足・ラインの値・直近の確定足(トレンドラインは足ごとのラインの値つき)・出来高比・前回の状態と理由をまとめたユーザーメッセージを送り、`tool_choice` で `report_line_state` ツール呼び出しに強制して、構造化JSON `{state, confidence, reasoning}` を取得します(仕様6.3)。実際に送ったユーザーメッセージは判定ごとに `line_checks.prompt` に保存され、`GET /lines/{id}/checks` とフロントの判定履歴で確認できます。

## 実装済み範囲 / 今後の検討課題(仕様9より)

以下は仕様書に「未決事項」として明記されている、または実装上の仮決め箇所です。動くものを優先して妥当な初期値を入れていますが、実運用前に検証・調整してください:

- 判定対象を絞る範囲(`CHECK_MARGIN_PCT`)・LLMに渡す本数(`CANDLE_WINDOW`)は暫定値
- `line_checks` は判定のたびに1行(プロンプト全文込み)増えます。1分足のラインを長期間置くと行数が増えるので、必要に応じて古い行を削除してください
- トレンドラインは2点から時刻方向に無限延長する「半直線/直線」として扱っています(区間=segmentとして打ち切る運用にしたい場合は `shared/src/line.ts` の `lineValueAt` を要修正)
- LLM入力はテキスト(案A)のみ実装。画像入力(案B)は未実装
- バックテストの手数料・スリッページは未考慮(`pnl_pct`は無レバレッジの価格変化率のみ)
- v0.3以降のアラート通知・自動発注は対象外(仕様2.2)

## 動作確認

- 3ワークスペース(`shared`/`worker`/`backtest`)すべて `npm run typecheck` 通過
- `wrangler deploy --dry-run` でWorkerのバンドル(shared依存込み)を確認済み
- `backtest` はモックLLMでの合成データ再生(定期判定→状態遷移→仮想売買→指標集計)まで動作確認済み
- Cronの定期判定は、インメモリのSQLiteと取引所・Claude APIのスタブで通しの動作確認済み(確定足ごとに1回だけ判定・形成中の足の除外・遠いラインのスキップ・前回状態のプロンプトへの反映・ライン削除時の履歴削除)
- Claude実呼び出し・実取引所APIでの通しは未実施(APIキー・実データが必要なため)。デプロイ前に `--llm claude` で少量期間のバックテストを行うことを推奨します
