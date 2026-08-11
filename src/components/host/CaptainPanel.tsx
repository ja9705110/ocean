"use client";

import { useCallback, useEffect, useState } from "react";
import { listTeamPlayers, listTeams } from "@/lib/game/api";
import type { Team, TeamPlayer } from "@/lib/game/types";
import { setTeamCaptain } from "@/lib/quiz/api";

/**
 * 隊長名單（Q3）。
 *
 * 隊長是玩家自己在手機上搶的，主持人平常不必管。這一區存在的理由只有一個：
 * 現場一定會出現「隊長手機沒電」「隊長跑去廁所」——那時要能一秒改派，
 * 不然那一桌整場都按不了。
 */

const POLL_MS = 4000;

interface CaptainPanelProps {
  readonly sessionId: string;
}

interface TeamRoster {
  readonly team: Team;
  readonly players: readonly TeamPlayer[];
}

export function CaptainPanel({ sessionId }: CaptainPanelProps) {
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

  const waiting = rosters.filter((r) => !r.players.some((p) => p.isCaptain));

  return (
    <div className="mt-6 rounded-lg border border-ink-800 bg-ink-950/60 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-ink-400">各桌隊長</p>
        <span className="text-xs text-ink-500">
          {waiting.length === 0
            ? `${rosters.length} 桌都推派好了`
            : `還有 ${waiting.length} 桌沒推派`}
        </span>
      </div>

      <p className="mt-1 text-xs leading-relaxed text-ink-500">
        玩家在手機上自己搶，先按的人就是隊長。
        手機沒電或臨時離席時，點下面的名字就能改派。
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
                <button
                  key={player.id}
                  type="button"
                  disabled={busy || player.isCaptain}
                  onClick={() => assign(player.id)}
                  title={player.isCaptain ? "目前的隊長" : "改派為隊長"}
                  className={
                    player.isCaptain
                      ? "rounded-full border border-signal-500 bg-signal-900/40 px-3 py-1 text-xs text-signal-400"
                      : "rounded-full border border-ink-700 px-3 py-1 text-xs text-ink-400 transition-colors duration-300 ease-world hover:bg-ink-800 disabled:opacity-40"
                  }
                >
                  {player.displayName}
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
