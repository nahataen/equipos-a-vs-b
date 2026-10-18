// Sistema ranked con LP por racha (mismas reglas que la app):
// base gana +30 / pierde −15; racha 3+ victorias → gana +35 y perder esa cuesta −12;
// racha 3+ derrotas → pierde −20; piso 0. Agrega partidas a GAMES y corre: node ranked.js
const BASE = 400, WIN = 30, WIN_HOT = 35, LOSS = 15, LOSS_MERCY = 12, LOSS_COLD = 20;
const HOT = 3, COLD = 3, MIN_GAMES = 5;
const TIERS = ['Hierro', 'Bronce', 'Plata', 'Oro', 'Platino', 'Esmeralda', 'Diamante'];

const GAMES = [
  { w: ['nataen', 'roxas', 'djuanchito', 'poppa', 'hanubi'], l: ['neid', 'junko', 'blubby', 'hanz', 'mika'] },
  { w: ['djuanchito', 'hanubi', 'neid', 'blubby', 'poppa'], l: ['nataen', 'junko', 'hanz', 'mika', 'roxas'] },
  { w: ['nataen', 'hanubi', 'neid', 'blubby', 'junko'], l: ['mika', 'roxas', 'hanz', 'djuanchito', 'poppa'] },
  { w: ['hanubi', 'blubby', 'djuanchito', 'mika', 'fairy'], l: ['nataen', 'roxas', 'hanz', 'junko', 'neid'] },
  { w: ['nataen', 'hanz', 'junko', 'neid', 'djuanchito'], l: ['hanubi', 'blubby', 'mika', 'fairy', 'roxas'] },
  { w: ['blubby', 'mika', 'junko', 'djuanchito', 'hanz'], l: ['nataen', 'roxas', 'neid', 'hanubi', 'fairy'] },
  { w: ['blubby', 'junko', 'roxas', 'fairy', 'neid'], l: ['nataen', 'mika', 'djuanchito', 'hanz', 'hanubi'] },
  { w: ['junko', 'roxas', 'hanz', 'mika', 'hanubi'], l: ['nataen', 'djuanchito', 'neid', 'fairy', 'blubby'] },
];
const EXTRA = ['sanns']; // jugadores sin partidas registradas
const NAMES = { nataen: 'Nataen', roxas: 'Roxas', djuanchito: 'DJuanchito', poppa: 'Poppa', hanubi: 'Hanubi', neid: 'Neid', junko: 'Junko', blubby: 'Blubby', hanz: 'Hanz', mika: 'Mika', fairy: 'Fairy', sanns: 'Sanns' };

function rankOf(p) {
  if (p >= 2800) return 'Maestro';
  const tier = TIERS[Math.floor(p / 400)];
  const div = ['IV', 'III', 'II', 'I'][Math.floor((p % 400) / 100)];
  return `${tier} ${div} - ${p % 100} LP`;
}
// mismos helpers que la app (src/App.jsx)
const nextStreakOnWin = (s) => (s > 0 ? s + 1 : 1);
const nextStreakOnLoss = (s) => (s < 0 ? s - 1 : -1);
const lpForWin = (s) => (nextStreakOnWin(s) >= HOT ? WIN_HOT : WIN);
const lpForLoss = (s) => (s > 0 ? LOSS_MERCY : Math.abs(nextStreakOnLoss(s)) >= COLD ? LOSS_COLD : LOSS);

const st = {};
const all = new Set([...GAMES.flatMap((g) => [...g.w, ...g.l]), ...EXTRA]);
for (const n of all) st[n] = { wins: 0, losses: 0, points: BASE, streak: 0, hist: [] };
GAMES.forEach((g, i) => {
  for (const n of g.w) {
    const s = st[n], d = lpForWin(s.streak);
    s.wins++; s.points += d; s.streak = nextStreakOnWin(s.streak);
    s.hist.push(`P${i + 1}:+${d}→${s.points}`);
  }
  for (const n of g.l) {
    const s = st[n], d = lpForLoss(s.streak);
    s.losses++; s.points = Math.max(0, s.points - d); s.streak = nextStreakOnLoss(s.streak);
    s.hist.push(`P${i + 1}:-${d}→${s.points}`);
  }
});

const rows = [...all].map((n) => {
  const s = st[n], games = s.wins + s.losses;
  return { n, games, ...s, wr: games ? (s.wins / games) * 100 : null };
});
// Verificaciones
const tw = rows.reduce((a, r) => a + r.wins, 0), tl = rows.reduce((a, r) => a + r.losses, 0);
const badGames = rows.filter((r) => r.wins + r.losses !== r.games);
const badDeltas = rows.filter((r) => r.hist.some((h) => {
  const d = parseInt(h.split(':')[1]);
  return r.hist.includes(h) && Math.abs(d) !== 12 && Math.abs(d) !== 15 && Math.abs(d) !== 20 && Math.abs(d) !== 30 && Math.abs(d) !== 35;
}));
const hotWins = rows.reduce((a, r) => a + r.hist.filter((h) => h.includes(':+35')).length, 0);
const mercyLosses = rows.reduce((a, r) => a + r.hist.filter((h) => h.includes(':-12')).length, 0);
const coldLosses = rows.reduce((a, r) => a + r.hist.filter((h) => h.includes(':-20')).length, 0);
console.log(`VERIF a) total wins=${tw} total loses=${tl} -> ${tw === tl ? 'OK' : 'MAL'}`);
console.log(`VERIF b) wins+loses=partidas -> ${badGames.length === 0 ? 'OK' : 'MAL: ' + badGames.map((r) => r.n)}`);
console.log(`VERIF c) solo deltas de la tabla (30/35/12/15/20) -> ${badDeltas.length === 0 ? 'OK' : 'MAL: ' + badDeltas.map((r) => r.n)}`);
console.log(`VERIF d) rachas: +35 x${hotWins}, -12 x${mercyLosses}, -20 x${coldLosses} (esperado >0 cada uno)`);

// Orden: puntos, winrate, partidas, nombre
rows.sort((a, b) => b.points - a.points || (b.wr ?? -1) - (a.wr ?? -1) || b.games - a.games || a.n.localeCompare(b.n));
console.log('\n#  Jugador      Rango                PJ  W  L  WR%    Pts  Racha');
rows.forEach((r, i) => {
  const rango = r.games < MIN_GAMES ? 'En colocación' : rankOf(r.points);
  const racha = r.streak > 0 ? `🔥${r.streak}` : r.streak < 0 ? `❄${-r.streak}` : '—';
  console.log(`${String(i + 1).padStart(2)} ${(NAMES[r.n] ?? r.n).padEnd(12)} ${rango.padEnd(20)} ${String(r.games).padStart(2)}  ${r.wins}  ${r.losses}  ${r.wr === null ? '—' : r.wr.toFixed(1).padStart(5)}  ${String(r.points).padStart(4)}  ${racha}`);
});
console.log('\nHISTORIAL (solo partidas jugadas):');
for (const r of rows) console.log(`- ${NAMES[r.n] ?? r.n}: ${r.hist.join(' | ') || 'sin partidas'}`);
