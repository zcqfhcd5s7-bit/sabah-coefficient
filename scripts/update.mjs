#!/usr/bin/env node
/**
 * Sabah FK — UEFA club coefficient tracker
 * ----------------------------------------
 * Pulls Sabah's 2026/27 European campaign straight from UEFA's own match feed
 * (the same API that powers uefa.com), applies the coefficient rules from
 * Annex D of the 2026/27 UEFA Champions League regulations, and writes data.json.
 *
 * Run by .github/workflows/update.yml on a schedule, so the published page
 * refreshes itself after every match with no manual editing.
 *
 * No dependencies — Node 20+ (built-in fetch).
 */

const TEAM_ID = '2609356';          // Sabah FC (UEFA FAME id)
const SEASON  = 2027;               // UEFA labels 2026/27 as season 2027
const CARRIED = 6.0;                // 2022/23 0.0 + 2023/24 2.0 + 2024/25 2.0 + 2025/26 2.0

const COMPETITIONS = {
  '1':    { code: 'UCL',  name: 'UEFA Champions League'  },
  '14':   { code: 'UEL',  name: 'UEFA Europa League'     },
  '2291': { code: 'UECL', name: 'UEFA Conference League' },
};

/* ---------------------------------------------------------------- Annex D */

// D.4.3.a — points for a club eliminated in qualifying (Conference League scale)
const QUALIFYING_EXIT_POINTS = {
  QUALIFYING_ROUND_1: 1.0,
  QUALIFYING_ROUND_2: 1.5,
  QUALIFYING_ROUND_3: 2.0,
  PLAY_OFF:           2.5,
};

// D.4 — league phase onwards
const MATCH_POINTS   = { win: 2, draw: 1, loss: 0 };
// D.4.2.c / D.4.3.c — guaranteed league-phase minimums
const GUARANTEED_MIN = { UCL: 0, UEL: 3.0, UECL: 2.5 };
// D.5 — extra points per knockout round reached
const KO_BONUS       = { UCL: 1.5, UEL: 1.0, UECL: 0.5 };
const LEAGUE_GAMES   = { UCL: 8, UEL: 8, UECL: 6 };

// D.5 — bonus points by final league-phase position
function positionBonus(code, rank) {
  if (code === 'UCL')  return rank >= 25 ? 6.0 : 12.0 - 0.25 * (rank - 1);
  if (code === 'UEL')  return rank >= 25 ? 0.0 :  6.0 - 0.25 * (rank - 1);
  if (rank >= 25) return 0.0;                       // UECL
  if (rank <= 9)  return 4.0 - 0.25  * (rank - 1);  // ranks 1–9
  return 2.0 - 0.125 * (rank - 9);                  // ranks 9–25
}

/* ------------------------------------------------------------------ fetch */

async function getJSON(url) {
  const res = await fetch(url, {
    headers: { 'accept': 'application/json', 'user-agent': 'sabah-coefficient-tracker' },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function fetchMatches(competitionId) {
  // Offline mode for tests: SABAH_FIXTURE=path/to/matches.json
  if (process.env.SABAH_FIXTURE) {
    const { readFile } = await import('node:fs/promises');
    const all = JSON.parse(await readFile(process.env.SABAH_FIXTURE, 'utf8'));
    return all.filter(m => String(m.competition?.id) === String(competitionId));
  }
  const url = `https://match.uefa.com/v5/matches?competitionId=${competitionId}`
            + `&seasonYear=${SEASON}&teamId=${TEAM_ID}&limit=100&offset=0`;
  try {
    const data = await getJSON(url);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error(`  ! ${COMPETITIONS[competitionId].code}: ${err.message}`);
    return [];
  }
}

/** Best-effort: UEFA's published club coefficient ranking. Optional. */
async function fetchOfficialCoefficient() {
  if (process.env.SABAH_FIXTURE) return null;
  const base = 'https://comp.uefa.com/v2/coefficients'
             + `?coefficientRange=OVERALL&coefficientType=MEN_CLUB&language=EN&seasonYear=${SEASON}`;
  // The endpoint paginates inconsistently, so try a few known styles and stop
  // as soon as Sabah shows up. If none work we simply omit this block.
  const attempts = [ '', '&page=1&pageSize=500', '&limit=500', '&offset=0&limit=500', '&size=500' ];
  for (const suffix of attempts) {
    try {
      const json = await getJSON(base + suffix);
      const members = json?.data?.members ?? [];
      const hit = members.find(m => String(m?.member?.id) === TEAM_ID);
      if (hit) {
        return {
          totalValue:  hit.overallRanking?.totalValue ?? null,
          position:    hit.overallRanking?.position ?? null,
          lastUpdated: json?.data?.lastUpdateDate ?? null,
        };
      }
    } catch { /* try the next style */ }
  }
  return null;
}

/* ------------------------------------------------------------- normalising */

function normalise(raw) {
  const code   = COMPETITIONS[String(raw.competition?.id)]?.code ?? 'UCL';
  const home   = raw.homeTeam ?? {};
  const away   = raw.awayTeam ?? {};
  const total  = raw.score?.total ?? {};
  const isHome = String(home.id) === TEAM_ID;

  const hs = Number.isFinite(total.home) ? total.home : null;
  const as = Number.isFinite(total.away) ? total.away : null;

  let outcome = null;
  if (hs !== null && as !== null) {
    const ours = isHome ? hs : as, theirs = isHome ? as : hs;
    outcome = ours > theirs ? 'win' : ours === theirs ? 'draw' : 'loss';
  }

  return {
    id:          String(raw.id),
    competition: code,
    roundName:   raw.round?.translations?.name?.EN ?? raw.round?.metaData?.name ?? '',
    roundType:   raw.round?.metaData?.type ?? '',
    roundMode:   raw.round?.mode ?? '',
    matchdayNo:  raw.matchday?.sequenceNumber ? Number(raw.matchday.sequenceNumber) : null,
    leg:         raw.leg?.number ?? null,
    kickOff:     raw.kickOffTime?.dateTime ?? null,
    date:        raw.kickOffTime?.date ?? null,
    status:      raw.status ?? 'SCHEDULED',
    isHome,
    homeTeam:    home.internationalName ?? '',
    awayTeam:    away.internationalName ?? '',
    homeCountry: home.countryCode ?? '',
    awayCountry: away.countryCode ?? '',
    homeScore:   hs,
    awayScore:   as,
    regular:     raw.score?.regular ?? null,
    aggregate:   raw.score?.aggregate ?? null,
    outcome,
    opponent:    isHome ? (away.internationalName ?? '') : (home.internationalName ?? ''),
    opponentCountry: isHome ? (away.countryCode ?? '') : (home.countryCode ?? ''),
    venueCity:   raw.stadium?.city?.translations?.name?.EN ?? '',
    venueName:   raw.stadium?.translations?.name?.EN?.trim() ?? '',
    tieWinnerId: raw.winner?.aggregate?.team?.id ? String(raw.winner.aggregate.team.id) : null,
    tieWinnerText: raw.winner?.aggregate?.translations?.reasonText?.EN ?? null,
    scorers: (raw.playerEvents?.scorers ?? []).map(s => ({
      player: s.player?.translations?.shortName?.EN ?? s.player?.internationalName ?? '',
      minute: s.time?.minute ?? null,
      forSabah: String(s.teamId) === TEAM_ID,
      type: s.goalType ?? 'SCORED',
    })),
  };
}

const isLeaguePhase = m =>
  m.roundType === 'LEAGUE_PHASE' || m.roundMode === 'LEAGUE' ||
  /league phase/i.test(m.roundName);

/* ------------------------------------------------------------ coefficient */

function computeCoefficient(matches) {
  const finished = matches.filter(m => m.status === 'FINISHED');
  const league   = matches.filter(isLeaguePhase);
  const leaguePlayed = league.filter(m => m.status === 'FINISHED');

  // Last two-legged tie that has been decided.
  const lastTie    = [...finished].reverse().find(m => m.tieWinnerId);
  const wonLastTie = lastTie ? lastTie.tieWinnerId === TEAM_ID : null;

  // Between winning the play-off and the league-phase draw, UEFA's feed has no
  // league-phase fixtures yet — but the place is already secured. A play-off
  // *loser* in the Champions Path drops into the Europa League league phase,
  // so either way a league phase is reached once the play-off is played.
  const playOffDecided = lastTie?.roundType === 'PLAY_OFF';
  const qualifiedByPlayOff = playOffDecided && wonLastTie === true;
  const parachutedByPlayOff = playOffDecided && wonLastTie === false
                              && lastTie.competition === 'UCL';

  const reachedLeaguePhase = league.length > 0 || qualifiedByPlayOff || parachutedByPlayOff;

  // Which competition's league phase? The feed wins if it has fixtures;
  // otherwise infer from the play-off result.
  const code = league[0]?.competition
            ?? (qualifiedByPlayOff  ? lastTie.competition
            :   parachutedByPlayOff ? 'UEL'
            :   finished[finished.length - 1]?.competition)
            ?? matches[0]?.competition ?? 'UCL';

  // Eliminated in qualifying: lost a tie with no league phase to fall into.
  let eliminatedAt = null;
  if (!reachedLeaguePhase && lastTie && wonLastTie === false) {
    eliminatedAt = lastTie.roundType;
  }

  const wins   = leaguePlayed.filter(m => m.outcome === 'win').length;
  const draws  = leaguePlayed.filter(m => m.outcome === 'draw').length;
  const losses = leaguePlayed.filter(m => m.outcome === 'loss').length;
  const played = leaguePlayed.length;
  const total  = LEAGUE_GAMES[code] ?? 8;
  const remaining = Math.max(0, total - played);

  const matchPoints = wins * MATCH_POINTS.win + draws * MATCH_POINTS.draw;
  const minimum     = GUARANTEED_MIN[code] ?? 0;

  let earned, note;
  if (eliminatedAt) {
    earned = QUALIFYING_EXIT_POINTS[eliminatedAt] ?? 0;
    note   = 'Eliminated in qualifying — fixed points on the Conference League scale (Annex D.4.3.a).';
  } else if (reachedLeaguePhase) {
    // Points banked so far. The position bonus is only confirmed once the
    // league phase ends, so it is reported separately as the floor.
    earned = Math.max(matchPoints, played === total ? minimum : 0);
    note   = played === 0
      ? `${code} league phase secured — match points start accruing at matchday 1.`
      : played === total
        ? 'League phase complete — awaiting final position for the ranking bonus.'
        : 'League phase in progress — match points banked so far.';
  } else {
    earned = 0;
    note   = 'Qualifying in progress — qualifying results do not add to the club coefficient.';
  }

  // Floor: worst realistic outcome from here.
  let floorSeason;
  if (eliminatedAt)            floorSeason = earned;
  else if (reachedLeaguePhase) floorSeason = Math.max(matchPoints, minimum) + positionBonus(code, 36);
  else                         floorSeason = QUALIFYING_EXIT_POINTS.PLAY_OFF;

  return {
    competition: code,
    reachedLeaguePhase,
    eliminatedAt,
    leaguePhase: { played, total, remaining, wins, draws, losses, matchPoints },
    guaranteedMinimum: minimum,
    positionBonusFloor: reachedLeaguePhase ? positionBonus(code, 36) : 0,
    koBonusPerRound: KO_BONUS[code] ?? 0,
    seasonPointsSoFar: round3(earned),
    seasonPointsFloor: round3(floorSeason),
    carried: CARRIED,
    coefficientNow:   round3(CARRIED + earned),
    coefficientFloor: round3(CARRIED + floorSeason),
    note,
  };
}

const round3 = n => Math.round(n * 1000) / 1000;

/* -------------------------------------------------------------------- main */

async function main() {
  console.log('Fetching Sabah 2026/27 matches from UEFA…');

  const raw = [];
  for (const id of Object.keys(COMPETITIONS)) {
    const found = await fetchMatches(id);
    console.log(`  ${COMPETITIONS[id].code}: ${found.length} match(es)`);
    raw.push(...found);
  }

  if (raw.length === 0) throw new Error('UEFA returned no matches — refusing to overwrite data.json.');

  const matches = raw.map(normalise)
    .sort((a, b) => String(a.kickOff).localeCompare(String(b.kickOff)));

  const finished  = matches.filter(m => m.status === 'FINISHED');
  const upcoming  = matches.filter(m => m.status !== 'FINISHED');
  const coefficient = computeCoefficient(matches);
  const official    = await fetchOfficialCoefficient();

  const data = {
    generatedAt: new Date().toISOString(),
    source: {
      matches: 'https://match.uefa.com/v5/matches (official UEFA match feed)',
      rules:   'UEFA Champions League Regulations 2026/27, Annex D — Coefficient Ranking System',
      rulesUrl:'https://documents.uefa.com/r/Regulations-of-the-UEFA-Champions-League-2026/27/Annex-D-Coefficient-Ranking-System-Online',
      ranking: official ? 'https://comp.uefa.com/v2/coefficients (official UEFA club ranking)' : null,
    },
    club: { id: TEAM_ID, name: 'Sabah FC', country: 'AZE' },
    season: '2026/27',
    carriedSeasons: [
      { season: '2022/23', points: 0.0, note: 'no European football' },
      { season: '2023/24', points: 2.0, note: 'Conference League Q3 exit' },
      { season: '2024/25', points: 2.0, note: 'Conference League Q3 exit' },
      { season: '2025/26', points: 2.0, note: 'Conference League Q3 exit (Levski)' },
    ],
    matches,
    lastResult: finished[finished.length - 1] ?? null,
    nextMatch:  upcoming[0] ?? null,
    coefficient,
    officialRanking: official,
    rules: {
      qualifyingExit: QUALIFYING_EXIT_POINTS,
      matchPoints: MATCH_POINTS,
      guaranteedMinimum: GUARANTEED_MIN,
      koBonus: KO_BONUS,
      leagueGames: LEAGUE_GAMES,
    },
  };

  const { writeFile } = await import('node:fs/promises');
  await writeFile('data.json', JSON.stringify(data, null, 2) + '\n');

  console.log(`\nWrote data.json — ${matches.length} matches, ${finished.length} played.`);
  console.log(`Competition: ${coefficient.competition}`
            + `  league phase: ${coefficient.reachedLeaguePhase ? 'yes' : 'not yet'}`);
  console.log(`Coefficient now ${coefficient.coefficientNow} · floor ${coefficient.coefficientFloor}`);
}

main().catch(err => { console.error(err); process.exit(1); });
