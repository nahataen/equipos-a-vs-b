// Sistema ranked estilo LoL: base 1000, +20/-20, piso 0.
// Agrega partidas nuevas al array GAMES (w: ganadores, l: perdedores) y corre: node ranked.js
const BASE = 1000, WIN = 20, LOSS = 20, MIN_GAMES = 5;
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

const st = {};
const all = new Set([...GAMES.flatMap((g) => [...g.w, ...g.l]), ...EXTRA]);
for (const n of all) st[n] = { wins: 0, losses: 0, points: BASE, hist: [] };
GAMES.forEach((g, i) => {
  for (const n of g.w) { const s = st[n]; s.wins++; s.points += WIN; s.hist.push(`P${i + 1}:+20→${s.points}`); }
  for (const n of g.l) { const s = st[n]; s.losses++; s.points = Math.max(0, s.points - LOSS); s.hist.push(`P${i + 1}:-20→${s.points}`); }
});

const rows = [...all].map((n) => {
  const s = st[n], games = s.wins + s.losses;
  return { n, games, ...s, wr: games ? (s.wins / games) * 100 : null };
});
// Verificaciones
const tw = rows.reduce((a, r) => a + r.wins, 0), tl = rows.reduce((a, r) => a + r.losses, 0);
const badGames = rows.filter((r) => r.wins + r.losses !== r.games);
const badPts = rows.filter((r) => r.points !== Math.max(0, BASE + WIN * r.wins - LOSS * r.losses));
console.log(`VERIF a) total wins=${tw} total loses=${tl} -> ${tw === tl ? 'OK' : 'MAL'}`);
console.log(`VERIF b) wins+loses=partidas -> ${badGames.length === 0 ? 'OK' : 'MAL: ' + badGames.map((r) => r.n)}`);
console.log(`VERIF c) puntos=1000+20W-20L -> ${badPts.length === 0 ? 'OK' : 'MAL: ' + badPts.map((r) => r.n)}`);

// Orden: puntos, winrate, partidas, nombre
rows.sort((a, b) => b.points - a.points || (b.wr ?? -1) - (a.wr ?? -1) || b.games - a.games || a.n.localeCompare(b.n));
console.log('\n#  Jugador      Rango                PJ  W  L  WR%    Pts');
rows.forEach((r, i) => {
  const rango = r.games < MIN_GAMES ? 'En colocación' : rankOf(r.points);
  console.log(`${String(i + 1).padStart(2)} ${(NAMES[r.n] ?? r.n).padEnd(12)} ${rango.padEnd(20)} ${String(r.games).padStart(2)}  ${r.wins}  ${r.losses}  ${r.wr === null ? '—' : r.wr.toFixed(1).padStart(5)}  ${r.points}`);
});
console.log('\nHISTORIAL (solo partidas jugadas):');
for (const r of rows) console.log(`- ${NAMES[r.n] ?? r.n}: ${r.hist.join(' | ') || 'sin partidas'}`);
