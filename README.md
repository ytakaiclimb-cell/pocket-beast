# ポケットビースト

ドット絵のモンスター育成アプリ。誰でも開ける URL で配り、リアルタイムで対戦できる。

```
docs/                               アプリ本体（GitHub Pages で配信）
supabase/migrations/0001_init.sql   テーブル・RLS・成長の検算トリガー
supabase/functions/arena/index.ts   対戦の審判（Edge Function）
supabase/functions/app/index.ts     （不使用）Storage 配信の試み。下記参照
```

- Supabase プロジェクト: `pocket-beast` / `aauokhvypzpkaavskhgl` / 東京
- API: `https://aauokhvypzpkaavskhgl.supabase.co`

## なぜ配信が GitHub Pages なのか

Supabase は **HTML を配信させてくれない**。Storage の公開URLでも、自前の
Edge Function から `Content-Type: text/html` を付けて返しても、
`text/plain` に書き換えられ `default-src 'none'; sandbox` の CSP が付く。
（JSON はそのまま通るので、HTML だけを狙った意図的な制限。）

なので Supabase は **DB・認証・Realtime・対戦サーバ**として使い、
アプリ本体は GitHub Pages に置く。`supabase/functions/app` はその検証の残骸で、
使っていない。消してよい。

## 考え方

**クライアントを信じない。** 不特定多数に公開するので、勝敗も戦績も
クライアントの自己申告では動かさない。

- `matches` / `match_events` に **書き込み用の RLS ポリシーを作らない**
  = ログインしたユーザーからは一切書けない。対戦の進行は `arena` 関数だけが行う。
- `monsters` は本人だけが書けるが、トリガー `monster_plausible` が
  「そのアカウント歴・その年齢で到達しうる合計値か」を検算して弾く。
- 戦績とレートは `auth.uid()` が無いとき（= service_role = 審判）だけ動く。

これで防げるのは「結果の詐称」「他人のデータの書き換え」「ありえない強さの登録」。
防げないのは、初回登録で年齢と強さを盛る行為（レートで自然に是正される想定）。

## 手の種類

| 手 | 効果 |
|---|---|
| `strike` こうげき | ちから基準のダメージ。ゲージ +12 |
| `guard` ぼうぎょ | 攻撃せず、まもり 2.2倍。ゲージ +25 |
| `focus` ためる | 攻撃せず、次の一撃 1.8倍。まもり 0.7倍で無防備。ゲージ +20 |
| `special` ひっさつ | ゲージ 60 消費。最大パラメータ基準の大ダメージ |

1ターン 20秒。時間内に出さなければ `strike` 扱い。30ターンで HP 割合の高い方の勝ち。

## 更新のしかた

アプリ本体は `docs/` を直して `git push` するだけ（GitHub Pages が拾う）。

サーバ側を直したら:

```bash
# マイグレーション・Edge Function は Claude から MCP 経由で適用
```

## 残り

1. Supabase の匿名ログインを有効化（ダッシュボード → Authentication → Sign In / Providers）
2. GitHub にリポジトリを作って push → Pages を有効化
3. 2端末で実戦確認

## 公開先

- アプリ: https://ytakaiclimb-cell.github.io/pocket-beast/
- リポジトリ: https://github.com/ytakaiclimb-cell/pocket-beast （public）

`docs/` を直して `git push` すれば、1〜2分で反映される。

## 通しテストで確かめたこと（2026-09-26）

- 匿名ログイン → players 行の作成 → ロビー表示
- 募集 → 参加 → 10ターンの対戦 → 勝敗確定 → レート更新（1012 / 988）
- こうげき・ぼうぎょ・ためる・ひっさつ・かわす が全部発火する
- 細工の拒否:
  - ありえない強さへの更新 → `stats total 3996 exceeds the cap 126` で拒否
  - 自分のレート・勝ち数の書き換え → 元の値に戻る
  - 他人のモンスターの書き換え → 0行（RLS）
  - 対戦結果の直接書き換え → 0行（書き込みポリシー無し）
