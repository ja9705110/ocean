"use client";

import { useCallback, useEffect, useState } from "react";
import { listTeamPlayers, listTeams, removeGamePlayer } from "@/lib/game/api";
import type { Team, TeamPlayer } from "@/lib/game/types";
import { setTeamCaptain } from "@/lib/quiz/api";

/**
 * 各桌名單（Q3／C27）。
 *
 * 兩件現場一定會遇到的事：
 *
 *   改派桌長  桌長手機沒電、跑去廁所。點名字就換人，
 *             不然那一桌整場都按不了。（只有隊長代表賽用得到）
 *   移除玩家  掃錯桌卡坐進別人的隊伍、彩排留下來的假玩家、中途離席的人。
 *             他自己重掃沒有用——join_game 認的是裝置，同一支手機在
 *             同一場只會有一個座位。踢掉之後重掃就能坐到對的桌。
 *
 * 所以這一區在三種計分方式底下都要出現，不是只有隊長代表賽。
 */

const POLL_MS = 4000;

interface CaptainPanelProps {
  readonly sessionId: string;
  /** 隊長代表賽才需要改派桌長，其他玩法點名字沒有意義 */
  readonly canAssignCaptain: boolean;
}

interface TeamRoster {
  readonly team: Team;
  readonly players: readonly TeamPlayer[];
}

export function CaptainPanel({
  sessionId,
  canAssignCaptain,
}: CaptainPanelProps) {
  const [rosters, setRosters] = useState<TeamRoster[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const teams = await listTeams(sessionId);
    const withPlayers = await Promise.all(
      teams.map(async (team) => ({
        team,
        players: await listTeamPlayers(team.id),
      })),
    );
    setRosters(withPlayers.filter((r) => r.players.length > 0));
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      await Promise.resolve();
      if (cancelled) {
        return;
      }
      await refresh().catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
    };
    void load();

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh().catch(() => undefined);
      }
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refresh]);

  const assign = useCallback(
    (playerId: string) => {
      setBusy(true);
      setError(null);
      void setTeamCaptain(playerId)
        .then(() => refresh())
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setBusy(false));
    },
    [refresh],
  );

  /**
   * 把人請出去。
   *
   * 先問一次再動手——這會連他的作答與分數一起清掉。但不是不可逆的
   * 大事：他重掃桌卡就能再進來，所以一個 confirm 就夠，
   * 不必像刪場次那樣要求打字。
   */
  const remove = useCallback(
    (player: TeamPlayer, teamName: string) => {
      const note = player.isCaptain
        ? `\n\n${player.displayName} 是這一桌的桌長，移除之後這桌暫時沒有人能按答案，記得再指定一位。`
        : "";
      if (
        !window.confirm(
          `把「${player.displayName}」移出${teamName}？\n` +
            "他在這一場的作答與分數會一起清掉。\n" +
            "他重新掃桌卡就可以再加入。" +
            note,
        )
      ) {
        return;
      }
      setBusy(true);
      setError(null);
      void removeGamePlayer(player.id)
        .then(() => refresh())
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setBusy(false));
    },
    [refresh],
  );

  const waiting = rosters.filter((r) => !r.players.some((p) => p.isCaptain));

  return (
    <div className="mt-6 rounded-lg border border-ink-800 bg-ink-950/60 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-ink-400">各桌名單</p>
        <span className="text-xs text-ink-500">
          {canAssignCaptain
            ? waiting.length === 0
              ? `${rosters.length} 桌都推派好了`
              : `還有 ${waiting.length} 桌沒推派`
            : `${rosters.length} 桌已入座`}
        </span>
      </div>

      <p className="mt-1 text-xs leading-relaxed text-ink-500">
        {canAssignCaptain
          ? "玩家在手機上自己搶桌長，先按的人就是。手機沒電或臨時離席時，點名字就能改派。"
          : "這裡是目前入座的所有人。"}
        <br />
        名字右邊的 × 是把人移出這一場——掃錯桌、彩排留下的假玩家、
        中途離開的人都用它。移出的人重新掃桌卡就能再加入。
      </p>

      {error ? (
        <p className="mt-3 text-xs text-alert-500">{error}</p>
      ) : null}

      {rosters.length === 0 ? (
        <p className="mt-4 text-xs text-ink-600">還沒有人入座。</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rosters.map(({ team, players }) => (
            <li key={team.id} className="flex flex-wrap items-center gap-2">
              <span className="w-20 shrink-0 text-xs text-ink-400">
                {team.name}
              </span>
              {players.map((player) => (
                <span
                  key={player.id}
                  className={
                    player.isCaptain
                      ? "flex items-center rounded-full border border-signal-500 bg-signal-900/40 pr-1 pl-3 text-xs text-signal-400"
                      : "flex items-center rounded-full border border-ink-700 pr-1 pl-3 text-xs text-ink-400"
                  }
                >
                  <button
                    type="button"
                    disabled={busy || player.isCaptain || !canAssignCaptain}
                    onClick={() => assign(player.id)}
                    title={
                      !canAssignCaptain
                        ? player.displayName
                        : player.isCaptain
                          ? "目前的桌長"
                          : "改派為桌長"
                    }
                    className="py-1 disabled:opacity-100"
                  >
                    {player.displayName}
                  </button>
                  {/* × 跟名字分開兩顆按鈕：點名字是改派，那是完全不同的動作 */}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => remove(player, team.name)}
                    title={`把 ${player.displayName} 移出這一場`}
                    aria-label={`把 ${player.displayName} 移出這一場`}
                    className="ml-1.5 rounded-full px-1.5 py-1 text-ink-600 transition-colors duration-300 ease-world hover:text-alert-500 disabled:opacity-40"
                  >
                    ×
                  </button>
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
