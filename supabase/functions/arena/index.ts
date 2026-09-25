// ポケットビースト: 対戦の審判
//
// クライアントは matches / match_events に直接書けない（RLS に書き込みポリシーが無い）。
// 手を送る・相手を決める・ダメージを決めるのは、すべてこの関数が行う。
// そうしないと、公開した先で「自分の勝ちにする」クライアントを作られる。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TURN_SECONDS = 20;
const MAX_TURNS = 30;
const MOVES = ["strike", "guard", "focus", "special"] as const;
type Move = typeof MOVES[number];

type Snap = {
  name: string; species: string; stage: number;
  pw: number; df: number; spd: number; iq: number;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const maxHp = (m: Snap) => Math.round(70 + m.df * 0.7 + (m.pw + m.spd) * 0.12);
const best = (m: Snap) => Math.max(m.pw, m.df, m.spd, m.iq);

/* ---------- 1ターンの処理 ---------- */
type Side = {
  key: "host" | "guest";
  snap: Snap; hp: number; gauge: number; focused: boolean; move: Move;
};

function resolveTurn(a: Side, b: Side, log: string[]) {
  // 速い方が先。同速はランダム。
  const first = a.snap.spd === b.snap.spd
    ? (Math.random() < 0.5 ? a : b)
    : (a.snap.spd > b.snap.spd ? a : b);
  const second = first === a ? b : a;

  for (const atk of [first, second]) {
    const def = atk === a ? b : a;
    if (atk.hp <= 0 || def.hp <= 0) continue;
    act(atk, def, log);
  }
  // 「ためる」の効果は act() の中で立て、次に当てた攻撃で消費される。
}

function act(atk: Side, def: Side, log: string[]) {
  const an = atk.snap.name, dn = def.snap.name;

  if (atk.move === "guard") {
    atk.gauge = Math.min(100, atk.gauge + 25);
    log.push(`${an}は みをまもっている`);
    return;
  }
  if (atk.move === "focus") {
    atk.gauge = Math.min(100, atk.gauge + 20);
    atk.focused = true;
    log.push(`${an}は ちからを ためた`);
    return;
  }
  if (atk.move === "special" && atk.gauge < 60) {
    log.push(`${an}は ひっさつを だそうとしたが ちからが たりない`);
    return;
  }

  // 防御側の実効まもり
  let defv = def.snap.df;
  if (def.move === "guard") defv *= 2.2;
  else if (def.move === "focus") defv *= 0.7;

  // かわす
  const dodge = Math.min(0.28, (def.snap.spd / (def.snap.spd + atk.snap.spd + 1)) * 0.35);
  if (def.move !== "focus" && Math.random() < dodge) {
    log.push(`${dn}は みをかわした`);
    return;
  }

  let dmg: number;
  const special = atk.move === "special";
  if (special) {
    atk.gauge -= 60;
    dmg = best(atk.snap) * 1.3 + atk.snap.pw * 0.6 - defv * 0.18;
  } else {
    atk.gauge = Math.min(100, atk.gauge + 12);
    dmg = atk.snap.pw * 0.85 + Math.random() * atk.snap.pw * 0.35 - defv * 0.35;
  }

  let charged = false;
  if (atk.focused) { dmg *= 1.8; atk.focused = false; charged = true; }

  const crit = Math.random() < 0.05 + atk.snap.iq / 2200;
  if (crit) dmg *= 1.7;

  const d = Math.max(1, Math.round(dmg));
  def.hp = Math.max(0, def.hp - d);

  const what = special ? "ひっさつ" : "こうげき";
  const kamae = charged ? "ためた " : "";
  log.push(`${an}の ${kamae}${what}！${crit ? " かいしん！" : ""} ${d} ダメージ`);
}

/* ---------- 本体 ---------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  const asUser = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: uerr } = await asUser.auth.getUser();
  if (uerr || !user) return json({ error: "サインインしていません" }, 401);

  const db = createClient(url, svc, { auth: { persistSession: false } });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = String(body.action ?? "");

  // 登録されているモンスターは常にサーバから読む（クライアントの申告は使わない）
  const myMonster = async (): Promise<Snap | null> => {
    const { data } = await db.from("monsters")
      .select("name,species,stage,pw,df,spd,iq").eq("player_id", user.id).maybeSingle();
    return data as Snap | null;
  };

  const writeEvents = async (matchId: string, turn: number, lines: string[]) => {
    if (!lines.length) return;
    await db.from("match_events").insert(
      lines.map((line, i) => ({ match_id: matchId, turn, seq: i, line })),
    );
  };

  try {
    switch (action) {
      /* --- 募集を出す --- */
      case "open": {
        const snap = await myMonster();
        if (!snap) return json({ error: "さきに モンスターを とうろくして ください" }, 400);

        await db.from("matches").update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("host_id", user.id).eq("status", "waiting");

        const { data, error } = await db.from("matches").insert({
          host_id: user.id, host_snap: snap, status: "waiting",
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        }).select().single();
        if (error) throw error;
        return json({ ok: true, match: data });
      }

      /* --- 募集を取り消す --- */
      case "cancel": {
        await db.from("matches").update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("host_id", user.id).eq("status", "waiting");
        return json({ ok: true });
      }

      /* --- 募集に乗る --- */
      case "join": {
        const matchId = String(body.match_id ?? "");
        const snap = await myMonster();
        if (!snap) return json({ error: "さきに モンスターを とうろくして ください" }, 400);

        const { data: m } = await db.from("matches").select("*").eq("id", matchId).maybeSingle();
        if (!m) return json({ error: "その ぼしゅうは ありません" }, 404);
        if (m.status !== "waiting") return json({ error: "もう うまっています" }, 409);
        if (m.host_id === user.id) return json({ error: "じぶんの ぼしゅうには はいれません" }, 400);

        const hostSnap = m.host_snap as Snap;
        const { data, error } = await db.from("matches").update({
          guest_id: user.id, guest_snap: snap, status: "running", turn: 1,
          host_hp: maxHp(hostSnap), host_max: maxHp(hostSnap),
          guest_hp: maxHp(snap), guest_max: maxHp(snap),
          host_move: null, guest_move: null,
          deadline: new Date(Date.now() + TURN_SECONDS * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("id", matchId).eq("status", "waiting").select().single();
        if (error) throw error;

        await writeEvents(matchId, 0, [`${hostSnap.name} と ${snap.name} の たいせん！`]);
        return json({ ok: true, match: data });
      }

      /* --- 手を送る / 期限切れを処理する --- */
      case "move":
      case "tick": {
        const matchId = String(body.match_id ?? "");
        const { data: m } = await db.from("matches").select("*").eq("id", matchId).maybeSingle();
        if (!m) return json({ error: "その たいせんは ありません" }, 404);
        if (m.status !== "running") return json({ ok: true, match: m });

        const isHost = m.host_id === user.id;
        const isGuest = m.guest_id === user.id;
        if (!isHost && !isGuest) return json({ error: "この たいせんの さんかしゃでは ありません" }, 403);

        let hostMove = m.host_move as Move | null;
        let guestMove = m.guest_move as Move | null;

        if (action === "move") {
          const mv = String(body.move ?? "");
          if (!MOVES.includes(mv as Move)) return json({ error: "しらない て です" }, 400);
          if (isHost) { if (hostMove) return json({ ok: true, match: m }); hostMove = mv as Move; }
          else { if (guestMove) return json({ ok: true, match: m }); guestMove = mv as Move; }

          const { error } = await db.from("matches")
            .update(isHost ? { host_move: hostMove } : { guest_move: guestMove })
            .eq("id", matchId).eq("turn", m.turn);
          if (error) throw error;
        }

        const overdue = m.deadline ? new Date(m.deadline).getTime() < Date.now() : false;
        if (!(hostMove && guestMove) && !overdue) {
          return json({ ok: true, waiting: true });
        }
        // 期限切れのぶんは こうげき あつかい
        hostMove = hostMove ?? "strike";
        guestMove = guestMove ?? "strike";

        const host: Side = {
          key: "host", snap: m.host_snap as Snap, hp: m.host_hp, gauge: m.host_gauge,
          focused: m.host_focus, move: hostMove,
        };
        const guest: Side = {
          key: "guest", snap: m.guest_snap as Snap, hp: m.guest_hp, gauge: m.guest_gauge,
          focused: m.guest_focus, move: guestMove,
        };

        const log: string[] = [];
        resolveTurn(host, guest, log);

        const turn = m.turn + 1;
        let status = "running";
        let winner: string | null = null;

        if (host.hp <= 0 || guest.hp <= 0 || turn > MAX_TURNS) {
          status = "done";
          if (host.hp <= 0 && guest.hp <= 0) winner = null;
          else if (host.hp <= 0) winner = m.guest_id;
          else if (guest.hp <= 0) winner = m.host_id;
          else {
            const hr = host.hp / m.host_max, gr = guest.hp / m.guest_max;
            winner = hr === gr ? null : (hr > gr ? m.host_id : m.guest_id);
          }
          log.push(
            winner === null ? "ひきわけ！"
              : `${(winner === m.host_id ? host : guest).snap.name} の しょうり！`,
          );
        }

        const { data: updated, error: uerr2 } = await db.from("matches").update({
          turn, status,
          host_hp: host.hp, guest_hp: guest.hp,
          host_gauge: host.gauge, guest_gauge: guest.gauge,
          host_focus: host.focused, guest_focus: guest.focused,
          host_move: null, guest_move: null,
          winner,
          deadline: status === "running"
            ? new Date(Date.now() + TURN_SECONDS * 1000).toISOString() : null,
          updated_at: new Date().toISOString(),
        }).eq("id", matchId).eq("turn", m.turn).select().maybeSingle();

        if (uerr2) throw uerr2;
        // 同時に2人が resolve を呼んだ場合、負けた方の更新は 0 行になる。
        // そのときは相手が処理済みなので、そのまま現在の状態を返す。
        if (!updated) {
          const { data: cur } = await db.from("matches").select("*").eq("id", matchId).maybeSingle();
          return json({ ok: true, match: cur });
        }

        await writeEvents(matchId, m.turn, log);

        if (status === "done") {
          const loser = winner === null ? null : (winner === m.host_id ? m.guest_id : m.host_id);
          if (winner) {
            const { data: w } = await db.from("monsters").select("wins,rating").eq("player_id", winner).maybeSingle();
            const { data: l } = await db.from("monsters").select("losses,rating").eq("player_id", loser!).maybeSingle();
            if (w && l) {
              const exp = 1 / (1 + Math.pow(10, (l.rating - w.rating) / 400));
              const k = 24;
              await db.from("monsters").update({
                wins: w.wins + 1, rating: Math.round(w.rating + k * (1 - exp)),
              }).eq("player_id", winner);
              await db.from("monsters").update({
                losses: l.losses + 1, rating: Math.round(l.rating - k * (1 - exp)),
              }).eq("player_id", loser!);
            }
          }
        }

        return json({ ok: true, match: updated });
      }

      /* --- 降参 --- */
      case "forfeit": {
        const matchId = String(body.match_id ?? "");
        const { data: m } = await db.from("matches").select("*").eq("id", matchId).maybeSingle();
        if (!m || m.status !== "running") return json({ ok: true });
        if (m.host_id !== user.id && m.guest_id !== user.id) return json({ error: "さんかしゃでは ありません" }, 403);
        const winner = m.host_id === user.id ? m.guest_id : m.host_id;
        await db.from("matches").update({
          status: "done", winner, deadline: null, updated_at: new Date().toISOString(),
        }).eq("id", matchId);
        await writeEvents(matchId, m.turn, ["こうさん した"]);
        return json({ ok: true });
      }

      case "sweep": {
        await db.rpc("sweep_matches");
        return json({ ok: true });
      }

      default:
        return json({ error: "しらない action: " + action }, 400);
    }
  } catch (e) {
    console.error(action, e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
