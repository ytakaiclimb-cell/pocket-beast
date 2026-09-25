-- ポケットビースト: 対戦サーバのスキーマ
-- 方針: クライアントは matches / match_events に直接書けない。
--       対戦の進行はすべて Edge Function（service_role）が審判として行う。

create extension if not exists pgcrypto;

-- ============================================================
-- プレイヤー
-- ============================================================
create table if not exists public.players (
  id          uuid primary key references auth.users(id) on delete cascade,
  handle      text not null check (char_length(btrim(handle)) between 1 and 16),
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

-- ============================================================
-- いま登録されているモンスター（1人1体）
-- ============================================================
create table if not exists public.monsters (
  player_id   uuid primary key references public.players(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 12),
  species     text not null check (char_length(species) between 1 and 24),
  stage       smallint not null check (stage between 0 and 4),
  pw          int not null check (pw between 0 and 999),
  df          int not null check (df between 0 and 999),
  spd         int not null check (spd between 0 and 999),
  iq          int not null check (iq between 0 and 999),
  care_miss   int not null default 0 check (care_miss >= 0),
  gen         int not null default 1 check (gen between 1 and 9999),
  age_ms      bigint not null check (age_ms >= 0),
  wins        int not null default 0,
  losses      int not null default 0,
  rating      int not null default 1000,
  updated_at  timestamptz not null default now()
);

-- 「その年齢・その在籍期間で到達しうる強さか」をサーバ側で検算する。
-- 公開する以上、クライアントの自己申告は信じない。
create or replace function public.monster_plausible()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  joined_ms numeric;
  hours     numeric;
  cap       int;
begin
  select extract(epoch from (now() - p.created_at)) * 1000
    into joined_ms
    from public.players p
   where p.id = new.player_id;

  if joined_ms is null then
    raise exception 'unknown player';
  end if;

  -- 登録より前から育っていたことにはできない（1時間の猶予だけ見る）
  if new.age_ms > joined_ms + 3600000 then
    raise exception 'age_ms (%) is older than this player account', new.age_ms;
  end if;

  -- 1時間あたりに伸ばせる合計値の上限。トレーニングは体力を食うので
  -- 実際にはこれより伸びない。初期値ぶんとして 120 を足す。
  hours := new.age_ms::numeric / 3600000;
  cap   := floor(hours * 40)::int + 120;

  if (new.pw + new.df + new.spd + new.iq) > cap then
    raise exception 'stats total % exceeds the cap % for age %h',
      (new.pw + new.df + new.spd + new.iq), cap, round(hours, 1);
  end if;

  -- 戦績とレートはサーバ（審判の Edge Function = service_role）だけが動かす。
  -- 本人としてのログイン（auth.uid() あり）からの更新では、いまの値に戻す。
  if tg_op = 'INSERT' then
    new.wins   := 0;
    new.losses := 0;
    new.rating := 1000;
  elsif auth.uid() is not null then
    select m.wins, m.losses, m.rating
      into new.wins, new.losses, new.rating
      from public.monsters m where m.player_id = new.player_id;
  end if;

  new.updated_at := now();
  return new;
end $$;

drop trigger if exists monsters_plausible on public.monsters;
create trigger monsters_plausible
  before insert or update on public.monsters
  for each row execute function public.monster_plausible();

-- ============================================================
-- 対戦
-- ============================================================
do $$ begin
  create type public.match_status as enum ('waiting','running','done','cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.matches (
  id          uuid primary key default gen_random_uuid(),
  host_id     uuid not null references public.players(id) on delete cascade,
  guest_id    uuid references public.players(id) on delete cascade,
  status      public.match_status not null default 'waiting',
  turn        int not null default 0,

  host_snap   jsonb not null,          -- 開始時点のモンスターの写し
  guest_snap  jsonb,

  host_hp     int,
  host_max    int,
  guest_hp    int,
  guest_max   int,

  host_move   text check (host_move in ('strike','guard','focus','special')),
  guest_move  text check (guest_move in ('strike','guard','focus','special')),
  host_gauge  int not null default 0,
  guest_gauge int not null default 0,
  host_focus  boolean not null default false,
  guest_focus boolean not null default false,

  winner      uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deadline    timestamptz,             -- この時刻を過ぎた手は自動で strike
  expires_at  timestamptz not null default now() + interval '15 minutes'
);

create index if not exists matches_open_idx
  on public.matches (created_at desc) where status = 'waiting';
create index if not exists matches_host_idx  on public.matches (host_id);
create index if not exists matches_guest_idx on public.matches (guest_id);

create table if not exists public.match_events (
  id         bigserial primary key,
  match_id   uuid not null references public.matches(id) on delete cascade,
  turn       int not null,
  seq        int not null,
  kind       text not null default 'log' check (kind in ('log','hp','result')),
  line       text not null,
  payload    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists match_events_match_idx
  on public.match_events (match_id, id);

-- ============================================================
-- RLS
-- ============================================================
alter table public.players      enable row level security;
alter table public.monsters     enable row level security;
alter table public.matches      enable row level security;
alter table public.match_events enable row level security;

-- players: 誰でも名前は見える（対戦相手の表示に要る）。書けるのは自分だけ。
drop policy if exists players_read   on public.players;
drop policy if exists players_insert on public.players;
drop policy if exists players_update on public.players;
create policy players_read   on public.players for select using (true);
create policy players_insert on public.players for insert with check (id = auth.uid());
create policy players_update on public.players for update using (id = auth.uid()) with check (id = auth.uid());

-- monsters: 誰でも見える（ロビーの一覧）。書けるのは自分の1体だけ。
drop policy if exists monsters_read   on public.monsters;
drop policy if exists monsters_insert on public.monsters;
drop policy if exists monsters_update on public.monsters;
drop policy if exists monsters_delete on public.monsters;
create policy monsters_read   on public.monsters for select using (true);
create policy monsters_insert on public.monsters for insert with check (player_id = auth.uid());
create policy monsters_update on public.monsters for update using (player_id = auth.uid()) with check (player_id = auth.uid());
create policy monsters_delete on public.monsters for delete using (player_id = auth.uid());

-- matches: 募集中のものと、自分が関わっているものだけ見える。
-- 書き込みポリシーは作らない = クライアントからは一切書けない。
-- 作成・参加・手の送信はすべて Edge Function 経由。
drop policy if exists matches_read on public.matches;
create policy matches_read on public.matches for select using (
  status = 'waiting' or host_id = auth.uid() or guest_id = auth.uid()
);

-- match_events: その対戦の当事者だけ読める。
drop policy if exists match_events_read on public.match_events;
create policy match_events_read on public.match_events for select using (
  exists (
    select 1 from public.matches m
     where m.id = match_events.match_id
       and (m.host_id = auth.uid() or m.guest_id = auth.uid())
  )
);

-- ============================================================
-- リアルタイム配信
-- ============================================================
do $$ begin
  alter publication supabase_realtime add table public.matches;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.match_events;
exception when duplicate_object then null; end $$;

-- 相手側の手が見えてしまうと不利になるので、matches の更新は
-- REPLICA IDENTITY を既定（主キーのみ）のままにし、
-- クライアントには Edge Function が確定させた結果だけを見せる。

-- ============================================================
-- 片付け（古い募集・終わった対戦）
-- ============================================================
create or replace function public.sweep_matches()
returns void
language sql
security definer
set search_path = public
as $$
  update public.matches
     set status = 'cancelled', updated_at = now()
   where status = 'waiting' and expires_at < now();

  delete from public.matches
   where status in ('done','cancelled') and updated_at < now() - interval '1 day';
$$;
